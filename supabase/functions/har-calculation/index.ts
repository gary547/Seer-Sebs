// Durable HAR/TP worker — fast path (Option A).
// Modes:
//   start  — { project_id, stalenessDays? }   → seeds har_jobs + queues, returns job_id
//   tick   — { project_id? | job_id? }        → advances one micro-batch on one job
//   status — { project_id } or { job_id }     → returns the current job row
//
// Each tick is short-lived (≤ ~50s). All progress is persisted in
// har_jobs / har_serp_tasks / har_ahrefs_queue / har_backlinks_queue, so
// crashes and rate limits never lose work. After every productive tick the
// worker self-chains via EdgeRuntime.waitUntil() so it doesn't have to wait
// for the next pg_cron minute. pg_cron remains the safety net.
//
// HAR maths (runPhaseCompute) is unchanged from the previous version.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Tuning (Option A: conservative parallel pools) ────────────────────────
const TICK_BUDGET_MS       = 50_000;
const HEARTBEAT_MS         = 10_000;
const SERP_POST_BATCH      = 100;
const SERP_POST_PARALLEL   = 3;
const SERP_FETCH_BATCH     = 150;
const SERP_FETCH_PARALLEL  = 8;
const AHREFS_BATCH         = 100;
const AHREFS_PARALLEL      = 4;
const BACKLINKS_BATCH      = 500;
const BACKLINKS_PARALLEL   = 3;
const CHAIN_GUARD_MS       = 30_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE);
}

const dfsAuth = () => {
  const k = Deno.env.get("DATAFORSEO_API_KEY")!;
  return k.includes(":") ? btoa(k) : k;
};

const normalizeDomain = (u: string) =>
  (u || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase();

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options);
      return r;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("unreachable");
}

// Run async tasks in parallel with a max concurrency cap.
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function chunkedDo<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

// ───────────────────────────────────────────────────────────────────────────
// START — stale-aware: only enqueue keywords with no SERP row or stale rows
// ───────────────────────────────────────────────────────────────────────────
async function handleStart(project_id: string, stalenessDays = 7) {
  const sb = admin();

  // Replace any non-terminal job for this project.
  await sb
    .from("har_jobs")
    .update({ status: "error", last_error: "superseded by new run", completed_at: new Date().toISOString() })
    .eq("project_id", project_id)
    .not("status", "in", "(completed,error)");

  // Cleanup orphaned queue rows from prior runs.
  await sb.from("har_serp_tasks").delete().eq("project_id", project_id);
  await sb.from("har_ahrefs_queue").delete().eq("project_id", project_id);
  await sb.from("har_backlinks_queue").delete().eq("project_id", project_id);

  // Page through all kept keywords.
  const kept: Array<{ id: string; keyword: string; ranking_url: string | null }> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("keywords")
      .select("id, keyword, ranking_url")
      .eq("project_id", project_id)
      .eq("detox_status", "keep")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch keywords: ${error.message}`);
    if (!data?.length) break;
    kept.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (!kept.length) {
    const e: any = new Error(
      "No 'keep' keywords found for this project. Run Keyword Detox first (or restore some keywords) before calculating HAR."
    );
    e.statusCode = 400;
    throw e;
  }

  // Determine which kept keywords already have FRESH serp_results — skip those.
  const cutoff = new Date(Date.now() - stalenessDays * 86_400_000).toISOString();
  const freshKeywordIds = new Set<string>();
  const ids = kept.map((k) => k.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data } = await sb
      .from("serp_results")
      .select("keyword_id, fetched_at")
      .in("keyword_id", chunk)
      .gte("fetched_at", cutoff);
    for (const r of data ?? []) freshKeywordIds.add((r as any).keyword_id);
  }
  const toQueue = kept.filter((k) => !freshKeywordIds.has(k.id));
  // If everything is fresh we still create a job so compute runs and HAR
  // is recomputed against the latest ahrefs/backlinks data.
  const serpTotal = toQueue.length;

  const { data: job, error: jobErr } = await sb
    .from("har_jobs")
    .insert({
      project_id,
      status: serpTotal ? "posting_serp" : "fetching_ahrefs",
      phase: serpTotal ? "post_serp" : "fetch_ahrefs",
      total_keywords: kept.length,
      serp_tasks_total: serpTotal,
      started_at: new Date().toISOString(),
      next_run_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (jobErr) throw new Error(`create job: ${jobErr.message}`);

  // Seed SERP tasks (only stale/missing).
  for (let i = 0; i < toQueue.length; i += 500) {
    const chunk = toQueue.slice(i, i + 500).map((k) => ({
      job_id: job.id,
      project_id,
      keyword_id: k.id,
      keyword: k.keyword,
      status: "queued",
    }));
    if (chunk.length) {
      const { error } = await sb.from("har_serp_tasks").insert(chunk);
      if (error) throw new Error(`seed serp tasks: ${error.message}`);
    }
  }

  // Seed Ahrefs queue with client domain + each kept keyword's ranking_url.
  const { data: project } = await sb
    .from("navigator_projects")
    .select("id, clients(domain)")
    .eq("id", project_id)
    .single();
  const rawDomain = (project?.clients as any)?.domain;
  if (!rawDomain) throw new Error("client domain missing");
  const clientDomain = rawDomain.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

  const ahrefsSeeds = new Set<string>();
  ahrefsSeeds.add(`https://${clientDomain}`);
  for (const kw of kept) {
    if (!kw.ranking_url) continue;
    const u = kw.ranking_url.startsWith("http")
      ? kw.ranking_url
      : kw.ranking_url.startsWith("/")
        ? `https://${clientDomain}${kw.ranking_url}`
        : `https://${kw.ranking_url}`;
    ahrefsSeeds.add(u);
  }
  if (ahrefsSeeds.size > 0) {
    const rows = [...ahrefsSeeds].map((url) => ({
      job_id: job.id,
      project_id,
      target_url: url,
      target_mode: url === `https://${clientDomain}` ? "domain" : "exact",
      status: "pending",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await sb.from("har_ahrefs_queue").insert(rows.slice(i, i + 500));
    }
    await sb.from("har_jobs").update({ ahrefs_targets_total: rows.length }).eq("id", job.id);
  }

  await sb.from("navigator_projects").update({ har_status: "running" }).eq("id", project_id);

  // Kick the first tick immediately.
  scheduleSelfTick(job.id);

  return { job_id: job.id, total_keywords: kept.length, serp_tasks_total: serpTotal, fresh_skipped: kept.length - serpTotal };
}

// Self-chain: re-invoke our own function with mode:"tick" without awaiting.
function scheduleSelfTick(job_id: string) {
  try {
    const url = `${SUPABASE_URL}/functions/v1/har-calculation`;
    const promise = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE}`,
        apikey: SERVICE_ROLE,
      },
      body: JSON.stringify({ mode: "tick", job_id }),
    }).catch((e) => console.warn("self-tick failed", e));
    // @ts-ignore — EdgeRuntime is provided by Supabase Deno runtime
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(promise);
  } catch (e) {
    console.warn("scheduleSelfTick error", e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TICK — pick one runnable job and advance one phase
// ───────────────────────────────────────────────────────────────────────────
async function handleTick(opts: { project_id?: string; job_id?: string } = {}) {
  const sb = admin();
  await sb.rpc("release_stale_har_claims");

  let job: any = null;
  if (opts.job_id) {
    const { data } = await sb.from("har_jobs").select("*").eq("id", opts.job_id).maybeSingle();
    job = data;
    if (!job || job.status === "completed" || job.status === "error") return { idle: true };
  } else {
    const q = sb
      .from("har_jobs")
      .select("*")
      .not("status", "in", "(completed,error)")
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at", { ascending: true })
      .limit(1);
    if (opts.project_id) q.eq("project_id", opts.project_id);
    const { data: jobs } = await q;
    job = jobs?.[0];
    if (!job) return { idle: true };
  }

  // Re-entrancy guard: if locked very recently, another tick is already running.
  if (job.locked_at && Date.now() - new Date(job.locked_at).getTime() < CHAIN_GUARD_MS) {
    return { busy: true, job_id: job.id };
  }

  // Heartbeat / lock
  await sb
    .from("har_jobs")
    .update({ locked_at: new Date().toISOString(), attempts: (job.attempts ?? 0) + 1 })
    .eq("id", job.id);

  const deadline = Date.now() + TICK_BUDGET_MS;
  let lastHeartbeat = Date.now();
  const beat = async () => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      await sb.from("har_jobs").update({ locked_at: new Date().toISOString() }).eq("id", job.id);
    }
  };

  let advanced = false;
  let chainNext = false;
  try {
    // Phase 1: POST queued SERP tasks
    if (job.serp_tasks_posted < job.serp_tasks_total) {
      advanced = await runPhasePostSerp(sb, job, deadline, beat);
      await sb.from("har_jobs").update({ status: "posting_serp", phase: "post_serp", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 2: poll/fetch posted tasks
    else if (job.serp_tasks_done < job.serp_tasks_total) {
      advanced = await runPhasePollSerp(sb, job, deadline, beat);
      const next = advanced ? new Date().toISOString() : new Date(Date.now() + 20_000).toISOString();
      await sb.from("har_jobs").update({ status: "polling_serp", phase: "poll_serp", next_run_at: next }).eq("id", job.id);
      chainNext = advanced; // if no progress, let cron pick it up after the wait
    }
    // Phase 3: seed Ahrefs queue with discovered SERP URLs (one-time)
    else if (job.phase === "post_serp" || job.phase === "poll_serp") {
      await seedAhrefsFromSerp(sb, job);
      await sb.from("har_jobs").update({ phase: "fetch_ahrefs", status: "fetching_ahrefs", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 4: Ahrefs
    else if (job.ahrefs_targets_done < job.ahrefs_targets_total) {
      advanced = await runPhaseAhrefs(sb, job, deadline, beat);
      await sb.from("har_jobs").update({ status: "fetching_ahrefs", phase: "fetch_ahrefs", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 5: seed backlinks queue from SERP URLs (one-time)
    else if (job.phase !== "fetch_backlinks" && job.phase !== "compute") {
      await seedBacklinksFromSerp(sb, job);
      await sb.from("har_jobs").update({ phase: "fetch_backlinks", status: "fetching_backlinks", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 6: backlinks
    else if (!job.backlinks_skipped && job.backlinks_targets_done < job.backlinks_targets_total) {
      const { advanced: adv, skipped } = await runPhaseBacklinks(sb, job, deadline, beat);
      advanced = adv;
      const patch: any = { status: "fetching_backlinks", phase: "fetch_backlinks", next_run_at: new Date().toISOString() };
      if (skipped) patch.backlinks_skipped = true;
      await sb.from("har_jobs").update(patch).eq("id", job.id);
      chainNext = true;
    }
    // Phase 7: compute HAR + write final tables
    else {
      await sb.from("har_jobs").update({ phase: "compute", status: "computing" }).eq("id", job.id);
      await runPhaseCompute(sb, job);

      // Re-run forecasts BEFORE flipping har_status to completed, so that by
      // the time the UI sees `har_status='completed'` the keyword_forecasts
      // rows already have `har` + `har_revenue_gain_annual` populated.
      //
      // Previously this was a fire-and-forget fetch wrapped in
      // EdgeRuntime.waitUntil — if it dropped (cold start, runtime kill,
      // network blip) the project ended up with valid har_results but every
      // keyword_forecasts.har = NULL, which surfaced as £0 in the TP Revenue
      // column and the TP Revenue Uplift dashboard widget.
      let recomputeError: string | null = null;
      try {
        const fcUrl = `${SUPABASE_URL}/functions/v1/compute-forecasts`;
        const fcRes = await fetch(fcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_ROLE}`,
            apikey: SERVICE_ROLE,
          },
          body: JSON.stringify({ project_id: job.project_id }),
        });
        if (!fcRes.ok) {
          const body = await fcRes.text().catch(() => "");
          recomputeError = `compute-forecasts HTTP ${fcRes.status}: ${body.slice(0, 300)}`;
          console.warn("post-HAR compute-forecasts non-ok:", recomputeError);
        } else {
          console.log("post-HAR compute-forecasts succeeded");
        }
      } catch (e: any) {
        recomputeError = `compute-forecasts threw: ${e?.message ?? String(e)}`;
        console.warn(recomputeError);
      }

      await sb
        .from("har_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          last_error: recomputeError, // null on success; recorded if recompute failed
        })
        .eq("id", job.id);
      await sb.from("navigator_projects").update({ har_status: "completed" }).eq("id", job.project_id);

      // Cleanup queues now that we've persisted everything we need
      await sb.from("har_serp_tasks").delete().eq("job_id", job.id);
      await sb.from("har_ahrefs_queue").delete().eq("job_id", job.id);
      await sb.from("har_backlinks_queue").delete().eq("job_id", job.id);

      chainNext = false;
    }

    if (chainNext) scheduleSelfTick(job.id);
    return await summarise(sb, job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("tick error", msg);
    const fatal = /auth\/subscription|client domain|No kept/i.test(msg);
    await sb
      .from("har_jobs")
      .update({
        status: fatal ? "error" : "rate_limited",
        last_error: msg,
        next_run_at: new Date(Date.now() + (fatal ? 0 : 60_000)).toISOString(),
        completed_at: fatal ? new Date().toISOString() : null,
      })
      .eq("id", job.id);
    if (fatal) {
      await sb.from("navigator_projects").update({ har_status: "error" }).eq("id", job.project_id);
    }
    return { error: msg, job_id: job.id };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: post SERP tasks (parallel posts + bulk RPC writeback)
// ───────────────────────────────────────────────────────────────────────────
async function runPhasePostSerp(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  let didWork = false;
  while (Date.now() < deadline) {
    // Claim SERP_POST_PARALLEL batches up-front so we can hit DFS in parallel.
    const claimBatches: Array<Array<{ id: string; keyword: string }>> = [];
    for (let p = 0; p < SERP_POST_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_serp_post_batch", {
        _job_id: job.id,
        _limit: SERP_POST_BATCH,
      });
      if (!claims?.length) break;
      claimBatches.push(claims as any);
    }
    if (!claimBatches.length) return didWork;

    const responses = await runPool(claimBatches, SERP_POST_PARALLEL, async (claims) => {
      const payload = claims.map((c) => ({
        keyword: c.keyword,
        location_code: 2826,
        language_code: "en",
        depth: 20,
        device: "desktop",
        os: "windows",
        tag: c.id,
      }));
      const resp = await fetchWithRetry(
        "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        {
          method: "POST",
          headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await resp.json().catch(() => ({}));
      return { claims, tasks: body.tasks ?? [] };
    });

    // Build a single bulk-update payload for all responses combined.
    // Track which claim ids were already 'posted' on this attempt so we don't
    // double-count retries against serp_tasks_posted.
    const alreadyPostedIds = new Set<string>();
    {
      const allClaimIds = claimBatches.flat().map((c) => c.id);
      const { data: existing } = await sb
        .from("har_serp_tasks")
        .select("id,status")
        .in("id", allClaimIds);
      for (const r of existing ?? []) if (r.status === "posted") alreadyPostedIds.add(r.id);
    }

    const bulkRows: any[] = [];
    let postedCount = 0;
    for (const { tasks } of responses) {
      for (const t of tasks) {
        const ourId = t.data?.tag;
        if (!ourId) continue;
        if (t.id && (t.status_code === 20100 || t.status_code === 20000)) {
          bulkRows.push({ id: ourId, dfs_task_id: t.id, status: "posted", last_error: null });
          if (!alreadyPostedIds.has(ourId)) postedCount++;
        } else {
          bulkRows.push({ id: ourId, dfs_task_id: null, status: "queued", last_error: t.status_message ?? `code ${t.status_code}` });
        }
      }
    }

    if (bulkRows.length) {
      await sb.rpc("bulk_update_har_serp_tasks", { _rows: bulkRows });
      didWork = true;
    }
    if (postedCount > 0) {
      const newPosted = Math.min((job.serp_tasks_posted ?? 0) + postedCount, job.serp_tasks_total ?? 0);
      await sb
        .from("har_jobs")
        .update({ serp_tasks_posted: newPosted })
        .eq("id", job.id);
      job.serp_tasks_posted = newPosted;
    }
    await beat();
  }
  return didWork;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: poll SERP results — driven by tasks_ready, parallel task_get
// ───────────────────────────────────────────────────────────────────────────
const extractSubItems = (item: any): Array<{ url: string; title?: string }> => {
  const out: Array<{ url: string; title?: string }> = [];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.url === "string" && /^https?:\/\//.test(n.url)) out.push({ url: n.url, title: n.title });
    if (Array.isArray(n.items)) n.items.forEach(visit);
    if (Array.isArray(n.references)) n.references.forEach(visit);
    if (Array.isArray(n.expanded_element)) n.expanded_element.forEach(visit);
  };
  visit(item);
  return out;
};

async function runPhasePollSerp(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  // 1. Ask DFS which posted tasks are ready.
  const readyResp = await fetchWithRetry(
    "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
    { method: "GET", headers: { Authorization: `Basic ${dfsAuth()}` } },
  );
  const readyBody = await readyResp.json().catch(() => ({}));
  const readyIds: string[] = (readyBody.tasks?.[0]?.result ?? []).map((it: any) => it.id).filter(Boolean);

  // 2. Claim ready rows.
  let claims: any[] = [];
  if (readyIds.length) {
    const { data } = await sb.rpc("claim_har_serp_fetch_by_dfs_ids", {
      _job_id: job.id,
      _dfs_ids: readyIds,
      _limit: SERP_FETCH_BATCH,
    });
    claims = data ?? [];
  }

  // 2b. Stale-posted fallback: if nothing came back from tasks_ready, but we have
  // rows that were posted > 3 min ago, try fetching them directly. DFS sometimes
  // drops tasks from the ready feed before we see them, and direct task_get works
  // regardless. This is the difference between "wait forever" and "self-heal".
  if (!claims.length) {
    const { data: stale } = await sb.rpc("claim_har_serp_fetch_batch", {
      _job_id: job.id,
      _limit: Math.min(SERP_FETCH_BATCH, 50),
    });
    claims = stale ?? [];
    console.log(JSON.stringify({
      phase: "poll_serp", job: job.id,
      ready_ids: readyIds.length, ready_claimed: 0, stale_claimed: claims.length,
      done: job.serp_tasks_done, total: job.serp_tasks_total,
    }));
  } else {
    console.log(JSON.stringify({
      phase: "poll_serp", job: job.id,
      ready_ids: readyIds.length, ready_claimed: claims.length,
      done: job.serp_tasks_done, total: job.serp_tasks_total,
    }));
  }

  if (!claims.length) return false;

  const clientDomainNorm = await getClientDomainNorm(sb, job.project_id);

  const serpResultRows: any[] = [];
  const serpRankingRows: any[] = [];
  const serpFeatureRows: any[] = [];
  const fetchedKeywordIds = new Set<string>();
  const fetchedTaskIds: string[] = [];
  const erroredTasks: Array<{ id: string; error: string }> = [];

  // 3. Parallel task_get with a pool.
  await runPool(claims as any[], SERP_FETCH_PARALLEL, async (c: any) => {
    if (Date.now() > deadline) return;
    try {
      const r = await fetchWithRetry(
        `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${c.dfs_task_id}`,
        { method: "GET", headers: { Authorization: `Basic ${dfsAuth()}` } },
      );
      const j = await r.json();
      const t = j.tasks?.[0];
      if (t?.status_code !== 20000) {
        erroredTasks.push({ id: c.id, error: t?.status_message ?? `code ${t?.status_code}` });
        return;
      }
      const items = t.result?.[0]?.items ?? [];
      fetchedKeywordIds.add(c.keyword_id);
      for (const item of items) {
        if (item.type === "organic") {
          if (item.rank_absolute > 20) continue;
          const url = item.url ?? "";
          const domain = normalizeDomain(url);
          serpResultRows.push({
            project_id: job.project_id,
            keyword_id: c.keyword_id,
            rank_absolute: item.rank_absolute,
            url,
            domain,
            fetched_at: new Date().toISOString(),
          });
          serpRankingRows.push({
            keyword_id: c.keyword_id,
            rank_position: item.rank_absolute,
            ranking_url: url,
            ranking_domain: domain,
            is_our_domain: domain === clientDomainNorm,
          });
        } else {
          // Vintage stamping: single per-task capture timestamp so all feature
          // rows from one SERP fetch share the same captured_at. serp_result_id
          // is left NULL here — feature items (PAA, Answer, images, etc.) do
          // not map to a specific organic serp_results row in this path.
          const capturedAt = new Date().toISOString();
          const subs = extractSubItems(item);
          if (subs.length === 0) {
            serpFeatureRows.push({
              keyword_id: c.keyword_id,
              result_type: item.type,
              top_serp_feature: item.title ?? null,
              top_serp_feature_url: null,
              serp_feature_count: 1,
              serp_feature_owned: false,
              captured_at: capturedAt,
              serp_result_id: null,
            });
          } else {
            for (const s of subs) {
              const sd = normalizeDomain(s.url);
              serpFeatureRows.push({
                keyword_id: c.keyword_id,
                result_type: item.type,
                top_serp_feature: s.title ?? item.title ?? null,
                top_serp_feature_url: s.url,
                serp_feature_count: subs.length,
                serp_feature_owned: sd === clientDomainNorm,
                captured_at: capturedAt,
                serp_result_id: null,
              });
            }
          }
        }
      }
      fetchedTaskIds.push(c.id);
    } catch (err) {
      erroredTasks.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
    await beat();
  });

  // 4. Persist (bulk).
  if (fetchedKeywordIds.size > 0) {
    const ids = [...fetchedKeywordIds];
    await chunkedDo(ids, 200, async (chunk) => {
      await sb.from("serp_rankings").delete().in("keyword_id", chunk);
      await sb.from("serp_features").delete().in("keyword_id", chunk);
    });
    await chunkedDo(serpResultRows, 500, (chunk) =>
      sb.from("serp_results").upsert(chunk, { onConflict: "keyword_id,rank_absolute" }),
    );
    await chunkedDo(serpRankingRows, 500, (chunk) => sb.from("serp_rankings").insert(chunk));
    await chunkedDo(serpFeatureRows, 500, (chunk) => sb.from("serp_features").insert(chunk));
  }

  if (fetchedTaskIds.length > 0) {
    await chunkedDo(fetchedTaskIds, 500, (chunk) =>
      sb.from("har_serp_tasks")
        .update({ status: "fetched", fetched_at: new Date().toISOString(), locked_at: null })
        .in("id", chunk),
    );
    await sb
      .from("har_jobs")
      .update({ serp_tasks_done: (job.serp_tasks_done ?? 0) + fetchedTaskIds.length })
      .eq("id", job.id);
    job.serp_tasks_done = (job.serp_tasks_done ?? 0) + fetchedTaskIds.length;
  }

  if (erroredTasks.length > 0) {
    // Bulk: same status/error for each (last_error differs but we keep it best-effort)
    await chunkedDo(erroredTasks, 200, (chunk) =>
      Promise.all(chunk.map((e) =>
        sb.from("har_serp_tasks").update({ status: "error", last_error: e.error, locked_at: null }).eq("id", e.id),
      )),
    );
    await sb
      .from("har_jobs")
      .update({ serp_tasks_done: (job.serp_tasks_done ?? 0) + erroredTasks.length })
      .eq("id", job.id);
    job.serp_tasks_done = (job.serp_tasks_done ?? 0) + erroredTasks.length;
  }

  return fetchedTaskIds.length > 0 || erroredTasks.length > 0;
}

async function getClientDomainNorm(sb: any, project_id: string): Promise<string> {
  const { data } = await sb
    .from("navigator_projects")
    .select("clients(domain)")
    .eq("id", project_id)
    .single();
  const raw = (data?.clients as any)?.domain ?? "";
  return raw.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "").toLowerCase();
}

// ───────────────────────────────────────────────────────────────────────────
// SEEDING: discover SERP URLs and add to Ahrefs / Backlinks queues
// ───────────────────────────────────────────────────────────────────────────
async function seedAhrefsFromSerp(sb: any, job: any) {
  const { data: ks } = await sb
    .from("keywords")
    .select("id")
    .eq("project_id", job.project_id)
    .eq("detox_status", "keep");
  const keywordIds = (ks ?? []).map((r: any) => r.id);
  if (!keywordIds.length) return;

  const allUrls = new Set<string>();
  for (let i = 0; i < keywordIds.length; i += 500) {
    const chunk = keywordIds.slice(i, i + 500);
    const { data } = await sb.from("serp_results").select("url").in("keyword_id", chunk);
    for (const r of data ?? []) if (r.url) allUrls.add(r.url);
  }

  const { data: existing } = await sb.from("har_ahrefs_queue").select("target_url").eq("job_id", job.id);
  const have = new Set((existing ?? []).map((r: any) => r.target_url));

  const toInsert = [...allUrls]
    .filter((u) => !have.has(u))
    .map((u) => ({ job_id: job.id, project_id: job.project_id, target_url: u, target_mode: "exact", status: "pending" }));

  for (let i = 0; i < toInsert.length; i += 500) {
    await sb.from("har_ahrefs_queue").insert(toInsert.slice(i, i + 500));
  }

  const { count } = await sb
    .from("har_ahrefs_queue")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  await sb.from("har_jobs").update({ ahrefs_targets_total: count ?? 0 }).eq("id", job.id);
  job.ahrefs_targets_total = count ?? 0;
}

async function seedBacklinksFromSerp(sb: any, job: any) {
  const { data: rows } = await sb
    .from("har_ahrefs_queue")
    .select("target_url, target_mode")
    .eq("job_id", job.id)
    .eq("target_mode", "exact");
  const urls = [...new Set((rows ?? []).map((r: any) => r.target_url))];
  if (!urls.length) return;
  const toInsert = urls.map((u) => ({ job_id: job.id, project_id: job.project_id, target_url: u, status: "pending" }));
  for (let i = 0; i < toInsert.length; i += 500) {
    await sb.from("har_backlinks_queue").insert(toInsert.slice(i, i + 500));
  }
  await sb.from("har_jobs").update({ backlinks_targets_total: toInsert.length }).eq("id", job.id);
  job.backlinks_targets_total = toInsert.length;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Ahrefs (parallel batch-analysis)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseAhrefs(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  const AHREFS_KEY = Deno.env.get("AHREFS_API_KEY")!;
  let didWork = false;

  while (Date.now() < deadline) {
    // Claim AHREFS_PARALLEL batches up-front.
    const batches: Array<Array<{ id: string; target_url: string; target_mode: string }>> = [];
    for (let p = 0; p < AHREFS_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_ahrefs_batch", {
        _job_id: job.id,
        _limit: AHREFS_BATCH,
      });
      if (!claims?.length) break;
      batches.push(claims as any);
    }
    if (!batches.length) return didWork;

    let totalDone = 0;
    try {
      await runPool(batches, AHREFS_PARALLEL, async (claims) => {
        const resp = await fetchWithRetry("https://api.ahrefs.com/v3/batch-analysis/batch-analysis", {
          method: "POST",
          headers: { Authorization: `Bearer ${AHREFS_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            select: ["url", "url_rating", "domain_rating", "ahrefs_rank"],
            targets: claims.map((c) => ({ url: c.target_url, mode: c.target_mode, protocol: "both" })),
            output: "json",
          }),
        });
        if (!resp.ok) {
          const status = resp.status;
          const txt = await resp.text();
          if (status === 401 || status === 402 || status === 403) {
            throw new Error(`Ahrefs auth/subscription error (${status}): ${txt}`);
          }
          await sb
            .from("har_ahrefs_queue")
            .update({ status: "pending", locked_at: null, last_error: `${status}: ${txt.slice(0, 200)}` })
            .in("id", claims.map((c) => c.id));
          return;
        }
        const body = await resp.json();
        const targets = body.targets ?? [];
        // Ahrefs returns rows in the same order as the request payload.
        await Promise.all(
          claims.map((c, i) =>
            sb.from("har_ahrefs_queue").update({
              status: "done",
              url_rating: targets[i]?.url_rating ?? 0,
              domain_rating: targets[i]?.domain_rating ?? 0,
              ahrefs_rank: targets[i]?.ahrefs_rank ?? 0,
              locked_at: null,
            }).eq("id", c.id),
          ),
        );
        totalDone += claims.length;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth\/subscription/.test(msg)) throw err;
      // Release any leftover claims back to pending (best-effort).
      const allIds = batches.flat().map((c) => c.id);
      await sb
        .from("har_ahrefs_queue")
        .update({ status: "pending", locked_at: null, last_error: msg.slice(0, 200) })
        .in("id", allIds);
      return didWork;
    }

    if (totalDone > 0) {
      await sb.from("har_jobs").update({ ahrefs_targets_done: (job.ahrefs_targets_done ?? 0) + totalDone }).eq("id", job.id);
      job.ahrefs_targets_done = (job.ahrefs_targets_done ?? 0) + totalDone;
      didWork = true;
    }
    await beat();
  }
  return didWork;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Backlinks (parallel)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseBacklinks(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<{ advanced: boolean; skipped: boolean }> {
  let didWork = false;
  let skipped = false;

  while (Date.now() < deadline) {
    const batches: Array<Array<{ id: string; target_url: string }>> = [];
    for (let p = 0; p < BACKLINKS_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_backlinks_batch", {
        _job_id: job.id,
        _limit: BACKLINKS_BATCH,
      });
      if (!claims?.length) break;
      batches.push(claims as any);
    }
    if (!batches.length) return { advanced: didWork, skipped };

    let totalDone = 0;
    try {
      await runPool(batches, BACKLINKS_PARALLEL, async (claims) => {
        const targets = claims.map((c) => c.target_url);
        const [refResp, blResp] = await Promise.all([
          fetchWithRetry("https://api.dataforseo.com/v3/backlinks/bulk_referring_domains/live", {
            method: "POST",
            headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
            body: JSON.stringify([{ targets }]),
          }),
          fetchWithRetry("https://api.dataforseo.com/v3/backlinks/bulk_backlinks/live", {
            method: "POST",
            headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
            body: JSON.stringify([{ targets }]),
          }),
        ]);
        const [refData, blData] = await Promise.all([refResp.json(), blResp.json()]);

        const refStatus = refData.tasks?.[0]?.status_code;
        const blStatus = blData.tasks?.[0]?.status_code;
        if (refStatus === 40204 || blStatus === 40204) {
          await sb
            .from("har_backlinks_queue")
            .update({ status: "done", locked_at: null })
            .in("id", claims.map((c) => c.id));
          skipped = true;
          totalDone += claims.length;
          return;
        }

        const refMap: Record<string, number> = {};
        const blMap: Record<string, number> = {};
        for (const i of refData.tasks?.[0]?.result?.[0]?.items ?? []) refMap[i.target] = i.referring_domains ?? 0;
        for (const i of blData.tasks?.[0]?.result?.[0]?.items ?? []) blMap[i.target] = i.backlinks ?? 0;

        await Promise.all(
          claims.map((c) =>
            sb.from("har_backlinks_queue").update({
              status: "done",
              referring_domains: refMap[c.target_url] ?? null,
              backlinks: blMap[c.target_url] ?? null,
              locked_at: null,
            }).eq("id", c.id),
          ),
        );
        totalDone += claims.length;
      });
    } catch (err) {
      const allIds = batches.flat().map((c) => c.id);
      await sb
        .from("har_backlinks_queue")
        .update({ status: "pending", locked_at: null, last_error: (err instanceof Error ? err.message : String(err)).slice(0, 200) })
        .in("id", allIds);
      return { advanced: didWork, skipped };
    }

    if (totalDone > 0) {
      await sb
        .from("har_jobs")
        .update({ backlinks_targets_done: (job.backlinks_targets_done ?? 0) + totalDone })
        .eq("id", job.id);
      job.backlinks_targets_done = (job.backlinks_targets_done ?? 0) + totalDone;
      didWork = true;
    }
    await beat();
  }
  return { advanced: didWork, skipped };
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Compute HAR + finalise (formula UNCHANGED)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseCompute(sb: any, job: any) {
  const project_id = job.project_id;
  const clientDomainNorm = await getClientDomainNorm(sb, project_id);
  const clientDomain = clientDomainNorm;

  // Build URL → metrics map from har_ahrefs_queue
  const ahrefsMap: Record<string, { url_rating: number; domain_rating: number; ahrefs_rank: number }> = {};
  let from = 0;
  while (true) {
    const { data } = await sb
      .from("har_ahrefs_queue")
      .select("target_url, url_rating, domain_rating, ahrefs_rank")
      .eq("job_id", job.id)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const r of data) {
      ahrefsMap[r.target_url] = {
        url_rating: Number(r.url_rating ?? 0),
        domain_rating: Number(r.domain_rating ?? 0),
        ahrefs_rank: Number(r.ahrefs_rank ?? 0),
      };
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const blMap: Record<string, { ref: number | null; bl: number | null }> = {};
  if (!job.backlinks_skipped) {
    let bf = 0;
    while (true) {
      const { data } = await sb
        .from("har_backlinks_queue")
        .select("target_url, referring_domains, backlinks")
        .eq("job_id", job.id)
        .range(bf, bf + 999);
      if (!data?.length) break;
      for (const r of data) blMap[r.target_url] = { ref: r.referring_domains, bl: r.backlinks };
      if (data.length < 1000) break;
      bf += 1000;
    }
  }

  // Bulk-upsert serp_results metrics in one call per 500-row chunk.
  let sf = 0;
  while (true) {
    const { data } = await sb
      .from("serp_results")
      .select("id, url")
      .eq("project_id", project_id)
      .range(sf, sf + 999);
    if (!data?.length) break;
    const updates = data.map((r: any) => {
      const a = ahrefsMap[r.url] ?? { url_rating: null, domain_rating: null, ahrefs_rank: null };
      const b = blMap[r.url] ?? { ref: null, bl: null };
      return {
        id: r.id,
        url_rating: a.url_rating,
        domain_rating: a.domain_rating,
        ahrefs_rank: a.ahrefs_rank,
        referring_domains: b.ref,
        backlinks: b.bl,
      };
    });
    await chunkedDo(updates, 500, (chunk) => sb.from("serp_results").upsert(chunk, { onConflict: "id" }));
    if (data.length < 1000) break;
    sf += 1000;
  }

  // Client domain metrics
  const clientKey = `https://${clientDomain}`;
  const clientMetrics = ahrefsMap[clientKey] ?? { url_rating: 0, domain_rating: 0, ahrefs_rank: 0 };
  await sb.from("client_domain_metrics").upsert(
    {
      project_id,
      domain: clientDomain,
      url_rating: clientMetrics.url_rating,
      domain_rating: clientMetrics.domain_rating,
      ahrefs_rank: clientMetrics.ahrefs_rank,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  // HAR per kept keyword (formula unchanged)
  const kept: Array<{ id: string; ranking_url: string | null }> = [];
  let kf = 0;
  while (true) {
    const { data } = await sb
      .from("keywords")
      .select("id, ranking_url")
      .eq("project_id", project_id)
      .eq("detox_status", "keep")
      .range(kf, kf + 999);
    if (!data?.length) break;
    kept.push(...data);
    if (data.length < 1000) break;
    kf += 1000;
  }

  const harRows: any[] = [];
  for (const kw of kept) {
    const { data: serps } = await sb
      .from("serp_results")
      .select("rank_absolute, url")
      .eq("project_id", project_id)
      .eq("keyword_id", kw.id)
      .order("rank_absolute", { ascending: true });

    let kwClientUR = clientMetrics.url_rating;
    if (kw.ranking_url) {
      const u = kw.ranking_url.startsWith("http")
        ? kw.ranking_url
        : kw.ranking_url.startsWith("/")
          ? `https://${clientDomain}${kw.ranking_url}`
          : `https://${kw.ranking_url}`;
      kwClientUR = ahrefsMap[u]?.url_rating ?? clientMetrics.url_rating;
    }
    let pos: number | null = null;
    let compUR: number | null = null;
    let compUrl: string | null = null;
    for (const c of serps ?? []) {
      const entry = ahrefsMap[c.url];
      const cur = entry?.url_rating;
      // Missing competitor UR: skip — do not let client "beat" an unknown row.
      if (cur === undefined || cur === null) continue;
      if (kwClientUR >= cur) {
        pos = c.rank_absolute;
        compUR = cur;
        compUrl = c.url;
        break;
      }
    }
    harRows.push({
      project_id,
      keyword_id: kw.id,
      har_position: pos,
      client_url_rating: kwClientUR,
      har_competitor_ur: compUR,
      har_competitor_url: compUrl,
      calculated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < harRows.length; i += 500) {
    await sb.from("har_results").upsert(harRows.slice(i, i + 500), { onConflict: "keyword_id" });
  }
  await sb.from("har_jobs").update({ har_rows_done: harRows.length }).eq("id", job.id);
}

async function summarise(sb: any, job_id: string) {
  const { data } = await sb.from("har_jobs").select("*").eq("id", job_id).single();
  return { job: data };
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP entrypoint
// ───────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode ?? "tick";

    // Authorization gate: this function invokes paid external APIs and mutates
    // rows via the service role. Reject anonymous callers.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const cronSecretHeader = req.headers.get("x-cron-secret") ?? "";
    const cronSecretEnv = Deno.env.get("HAR_CRON_SECRET") ?? "";
    const isInternal =
      bearer === SERVICE_ROLE ||
      (cronSecretEnv.length > 0 && cronSecretHeader === cronSecretEnv);

    // For end-user calls, validate the JWT and (for start/status) the target
    // project visibility. `tick` is only ever fired by our own self-chain or
    // the pg_cron watchdog, so require the service-role bearer or shared secret.
    if (!isInternal) {

      if (!bearer) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (mode === "tick") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(
        SUPABASE_URL,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
      if (userErr || !userData?.user?.id) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Resolve project_id (status may pass job_id only) and verify visibility.
      let projectIdToCheck: string | null = body.project_id ?? null;
      if (!projectIdToCheck && body.job_id) {
        const { data: jobRow } = await admin()
          .from("har_jobs").select("project_id").eq("id", body.job_id).maybeSingle();
        projectIdToCheck = jobRow?.project_id ?? null;
      }
      if (!projectIdToCheck) {
        return new Response(JSON.stringify({ error: "project_id or job_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: canProject } = await userClient.rpc("is_visible_project", { _project_id: projectIdToCheck });
      if (!canProject) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    let result: unknown;
    if (mode === "start") {
      if (!body.project_id) throw new Error("project_id required");
      result = await handleStart(body.project_id, body.stalenessDays);
    } else if (mode === "tick") {
      result = await handleTick({ project_id: body.project_id, job_id: body.job_id });
    } else if (mode === "status") {
      const sb = admin();
      if (body.job_id) {
        const { data } = await sb.from("har_jobs").select("*").eq("id", body.job_id).maybeSingle();
        result = { job: data };
      } else if (body.project_id) {
        const { data } = await sb
          .from("har_jobs")
          .select("*")
          .eq("project_id", body.project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        result = { job: data };
      } else throw new Error("project_id or job_id required");
    } else {
      throw new Error(`unknown mode: ${mode}`);
    }
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

