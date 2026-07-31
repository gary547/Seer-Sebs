// Brand classification — rule pass + Claude adjudication for uncertain rows.
//
// Modes:
//   - { project_id, mode:"start"  }  -> create brand_classification_jobs row, kick worker, return 202 { job_id }
//   - { project_id, mode:"status" }  -> return latest job row + aggregate counts
//
// Writes ONLY is_branded / brand_confidence on keywords and gsc_upload_keywords.
// Idempotent: re-running overwrites those two columns and nothing else.
//
// Classification basis: DISTINCT normalised keyword (lower/trim). A query that
// appears on multiple device rows is classified once and the verdict is fanned
// out to every row (keywords + gsc_upload_keywords) sharing that normalised
// string. `total_keywords` / `processed_keywords` on the job row count DISTINCT
// queries; `branded_count` / `non_branded_count` count ROWS updated across
// both tables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { classifyKeyword, deriveBrandTokens } from "../_shared/brand-classifier.ts";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";
import { reserveOTPM } from "../_shared/ai-rate-window.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SONNET_MODEL = "claude-sonnet-4-6";
const UNCERTAIN_BATCH = 40;
const WORKER_BUDGET_MS = 110_000;

interface StartBody { project_id: string; mode?: "start" | "status" }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normQ(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

async function requireAdmin(sb: any): Promise<boolean> {
  const { data: user } = await sb.auth.getUser();
  if (!user?.user?.id) return false;
  const uid = user.user.id;
  const { data } = await sb.rpc("has_role", { _user_id: uid, _role: "admin" });
  if (data === true) return true;
  const { data: sr } = await sb.rpc("has_role", { _user_id: uid, _role: "super_admin" });
  return sr === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabaseCaller = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    if (!(await requireAdmin(supabaseCaller))) return json({ error: "Forbidden" }, 403);

    const body = (await req.json()) as StartBody;
    if (!body?.project_id) return json({ error: "project_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    if (body.mode === "status") {
      const { data: job } = await supabase.from("brand_classification_jobs")
        .select("*").eq("project_id", body.project_id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const counts = await countBranded(supabase, body.project_id);
      return json({ job, counts });
    }

    // Reuse an in-flight job if fresh.
    const { data: existing } = await supabase.from("brand_classification_jobs")
      .select("*").eq("project_id", body.project_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing && (existing.status === "queued" || existing.status === "running")
      && existing.heartbeat_at && Date.now() - new Date(existing.heartbeat_at).getTime() < 60_000) {
      return json({ job_id: existing.id, reused: true }, 202);
    }

    const { data: created, error: createErr } = await supabase.from("brand_classification_jobs")
      .insert({ project_id: body.project_id, status: "queued" })
      .select("id").single();
    if (createErr) return json({ error: createErr.message }, 500);

    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(runWorker(created.id));
    else runWorker(created.id).catch((e) => console.error("worker crash", e));

    return json({ job_id: created.id }, 202);
  } catch (e) {
    console.error("brand-classification error", e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function countBranded(sb: any, projectId: string) {
  // Row-level coverage across BOTH tables so the admin card can show
  // "rows flagged branded / total rows" alongside the distinct-query counters.
  const { data: uploads } = await sb.from("gsc_uploads").select("id").eq("project_id", projectId);
  const uploadIds = (uploads ?? []).map((u: any) => u.id);

  const [kb, kn, ku, kt] = await Promise.all([
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_branded", true),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_branded", false),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("is_branded", null),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId),
  ]);

  let gb = 0, gn = 0, gu = 0, gt = 0;
  if (uploadIds.length > 0) {
    const [b, n, u, t] = await Promise.all([
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).eq("is_branded", true),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).eq("is_branded", false),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).is("is_branded", null),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds),
    ]);
    gb = b.count ?? 0; gn = n.count ?? 0; gu = u.count ?? 0; gt = t.count ?? 0;
  }

  return {
    // Legacy shape (keywords table only) — kept for backwards compatibility.
    branded: kb.count ?? 0,
    non_branded: kn.count ?? 0,
    unclassified: ku.count ?? 0,
    // New row-level totals across both surfaces.
    row_totals: {
      keywords: { branded: kb.count ?? 0, non_branded: kn.count ?? 0, unclassified: ku.count ?? 0, total: kt.count ?? 0 },
      gsc: { branded: gb, non_branded: gn, unclassified: gu, total: gt },
      combined: {
        branded: (kb.count ?? 0) + gb,
        non_branded: (kn.count ?? 0) + gn,
        unclassified: (ku.count ?? 0) + gu,
        total: (kt.count ?? 0) + gt,
      },
    },
  };
}

async function heartbeat(sb: any, jobId: string, patch: Record<string, unknown> = {}) {
  await sb.from("brand_classification_jobs").update({ heartbeat_at: new Date().toISOString(), ...patch }).eq("id", jobId);
}

async function runWorker(jobId: string) {
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const startedAt = Date.now();
  try {
    const { data: job } = await sb.from("brand_classification_jobs").select("*").eq("id", jobId).maybeSingle();
    if (!job) return;
    if (job.status === "complete") return;

    const projectId = job.project_id;
    const { data: project } = await sb.from("navigator_projects")
      .select("client_id, clients(company_name, domain, domain_normalized, brand_terms)")
      .eq("id", projectId).single();
    if (!project) throw new Error("project not found");
    const client = (project as any).clients;

    // Brand vocabulary from keyword_rules — ONLY 'brand' and 'own_brand' types.
    // 'whitelist' is a detox keep-list, not brand vocabulary, and must not contribute
    // (previously caused e.g. "tvs" to be classified as a brand token for AO).
    const { data: rules } = await sb.from("keyword_rules")
      .select("rule_type, keyword_categorisation").eq("client_id", (project as any).client_id);
    const ruleBrandTerms = (rules ?? [])
      .filter((r: any) => r.rule_type === "brand" || r.rule_type === "own_brand")
      .map((r: any) => r.keyword_categorisation)
      .filter(Boolean) as string[];

    // Merge admin-curated explicit brand terms with brand-typed rules.
    // Both are treated as explicit (word-boundary, bypass >=3-char rule) so
    // punctuated terms like "ao.com" survive normalisation intact.
    const explicitTerms = Array.from(new Set([
      ...((client?.brand_terms ?? []) as string[]),
      ...ruleBrandTerms,
    ]));

    const tokens = deriveBrandTokens({
      companyName: client?.company_name ?? null,
      domain: client?.domain ?? null,
      domainNormalised: client?.domain_normalized ?? null,
      explicitTerms,
    });


    // ---- Load rows from both surfaces ----
    // NB: gsc_upload_keywords.keyword is the column name (audited against
    // information_schema — the previous "query" reference was wrong).
    // Both prefetches page past PostgREST's default 1,000-row cap so that
    // large projects (~43k GSC rows for TVs Ongoing / SEO) are covered fully.
    const kwRows = await fetchAllRows<{ id: string; keyword: string | null }>(
      sb, "keywords", "id, keyword", (q) => q.eq("project_id", projectId),
    );

    const { data: uploads } = await sb.from("gsc_uploads").select("id").eq("project_id", projectId);
    const uploadIds = (uploads ?? []).map((u: any) => u.id);
    const gscRows = await selectIn<{ id: string; keyword: string | null }>(
      sb, "gsc_upload_keywords", "id, keyword", "upload_id", uploadIds, { paginate: true },
    );

    // ---- Build distinct-query → row-ids index across both tables ----
    const kwIdsByQuery = new Map<string, string[]>();
    const gscIdsByQuery = new Map<string, string[]>();
    for (const r of kwRows ?? []) {
      const q = normQ(r.keyword);
      if (!q) continue;
      const arr = kwIdsByQuery.get(q) ?? [];
      arr.push(r.id);
      kwIdsByQuery.set(q, arr);
    }
    for (const r of gscRows) {
      const q = normQ(r.keyword);
      if (!q) continue;
      const arr = gscIdsByQuery.get(q) ?? [];
      arr.push(r.id);
      gscIdsByQuery.set(q, arr);
    }
    const allQueries = new Set<string>([...kwIdsByQuery.keys(), ...gscIdsByQuery.keys()]);
    const distinctTotal = allQueries.size;

    await sb.from("brand_classification_jobs").update({
      status: "running",
      started_at: job.started_at ?? new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      brand_tokens: tokens as unknown as Record<string, unknown>,
      total_keywords: distinctTotal,
      last_error: null,
    }).eq("id", jobId);

    // ---- Rule pass over distinct queries ----
    const totals = {
      distinctProcessed: 0,
      distinctUncertain: 0,
      distinctUncertainResolved: 0,
      brandedRows: 0,
      nonBrandedRows: 0,
      uncertainResolvedRows: 0,
      aiCalls: 0,
    };
    const uncertainQueries: string[] = [];

    const kwBrand: string[] = [];
    const kwNon: string[] = [];
    const gscBrand: string[] = [];
    const gscNon: string[] = [];

    for (const q of allQueries) {
      const v = classifyKeyword(q, tokens);
      const kwIds = kwIdsByQuery.get(q) ?? [];
      const gscIds = gscIdsByQuery.get(q) ?? [];
      if (v.decision === "branded") {
        kwBrand.push(...kwIds);
        gscBrand.push(...gscIds);
        totals.brandedRows += kwIds.length + gscIds.length;
        totals.distinctProcessed++;
      } else if (v.decision === "non_branded") {
        kwNon.push(...kwIds);
        gscNon.push(...gscIds);
        totals.nonBrandedRows += kwIds.length + gscIds.length;
        totals.distinctProcessed++;
      } else {
        uncertainQueries.push(q);
        totals.distinctUncertain++;
      }
    }

    await bulkUpdateBranded(sb, "keywords", kwBrand, true, 0.95);
    await bulkUpdateBranded(sb, "keywords", kwNon, false, 0.9);
    await bulkUpdateBranded(sb, "gsc_upload_keywords", gscBrand, true, 0.95);
    await bulkUpdateBranded(sb, "gsc_upload_keywords", gscNon, false, 0.9);

    await heartbeat(sb, jobId, {
      total_keywords: distinctTotal,
      processed_keywords: totals.distinctProcessed,
      branded_count: totals.brandedRows,
      non_branded_count: totals.nonBrandedRows,
    });

    // ---- Claude pass over UNCERTAIN distinct queries ----
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (ANTHROPIC_API_KEY && uncertainQueries.length > 0) {
      const companyLabel = client?.company_name ?? client?.domain_normalized ?? "the client";

      for (let i = 0; i < uncertainQueries.length; i += UNCERTAIN_BATCH) {
        if (Date.now() - startedAt > WORKER_BUDGET_MS) break;
        const batch = uncertainQueries.slice(i, i + UNCERTAIN_BATCH);
        const tokensNeeded = batch.length * 30 + 200;

        for (let attempt = 0; attempt < 6; attempt++) {
          const r = await reserveOTPM(sb, SONNET_MODEL, tokensNeeded);
          if (r.reserved) break;
          await new Promise((res) => setTimeout(res, r.waitMs));
        }

        const results = await adjudicate(ANTHROPIC_API_KEY, companyLabel, batch);
        totals.aiCalls++;

        const kb: string[] = [], kn2: string[] = [], gb: string[] = [], gn2: string[] = [];
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (!r) continue;
          const q = batch[j];
          const kwIds = kwIdsByQuery.get(q) ?? [];
          const gscIds = gscIdsByQuery.get(q) ?? [];
          if (r.is_brand) {
            kb.push(...kwIds); gb.push(...gscIds);
            totals.brandedRows += kwIds.length + gscIds.length;
          } else {
            kn2.push(...kwIds); gn2.push(...gscIds);
            totals.nonBrandedRows += kwIds.length + gscIds.length;
          }
          totals.uncertainResolvedRows += kwIds.length + gscIds.length;
          totals.distinctUncertainResolved++;
          totals.distinctProcessed++;
        }
        await bulkUpdateBranded(sb, "keywords", kb, true, 0.85);
        await bulkUpdateBranded(sb, "keywords", kn2, false, 0.85);
        await bulkUpdateBranded(sb, "gsc_upload_keywords", gb, true, 0.85);
        await bulkUpdateBranded(sb, "gsc_upload_keywords", gn2, false, 0.85);

        await heartbeat(sb, jobId, {
          processed_keywords: totals.distinctProcessed,
          branded_count: totals.brandedRows,
          non_branded_count: totals.nonBrandedRows,
          uncertain_resolved_count: totals.uncertainResolvedRows,
          ai_calls: totals.aiCalls,
        });
      }
    }

    await sb.from("brand_classification_jobs").update({
      status: "complete",
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      processed_keywords: totals.distinctProcessed,
      total_keywords: distinctTotal,
      branded_count: totals.brandedRows,
      non_branded_count: totals.nonBrandedRows,
      uncertain_resolved_count: totals.uncertainResolvedRows,
      ai_calls: totals.aiCalls,
    }).eq("id", jobId);
  } catch (e) {
    console.error("brand-classification worker error", e);
    await sb.from("brand_classification_jobs").update({
      status: "error",
      last_error: (e as Error).message?.slice(0, 500) ?? "unknown",
      finished_at: new Date().toISOString(),
    }).eq("id", jobId);
  }
}

async function bulkUpdateBranded(sb: any, table: string, ids: string[], is: boolean, confidence: number) {
  if (ids.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error } = await sb.from(table)
      .update({ is_branded: is, brand_confidence: confidence })
      .in("id", slice);
    if (error) throw error;
  }
}

async function adjudicate(apiKey: string, company: string, keywords: string[]): Promise<{ is_brand: boolean; confidence: number }[]> {
  const prompt = `Company: "${company}".
For each query below, decide if it is a BRAND/NAVIGATIONAL query for THIS company (searching for the brand itself, its site, its login, etc.).
Return strict JSON array in the same order: [{"is_brand": true|false, "confidence": 0..1}, ...]. No prose.

Queries:
${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: Math.max(400, keywords.length * 30),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude ${res.status}: ${t.slice(0, 200)}`);
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return keywords.map(() => ({ is_brand: false, confidence: 0.5 }));
  try {
    const arr = JSON.parse(match[0]);
    return arr.map((r: any) => ({
      is_brand: r?.is_brand === true,
      confidence: typeof r?.confidence === "number" ? r.confidence : 0.7,
    }));
  } catch {
    return keywords.map(() => ({ is_brand: false, confidence: 0.5 }));
  }
}
