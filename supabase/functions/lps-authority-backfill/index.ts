// lps-authority-backfill
// Phase 8 · Prompt 8.2b — LPS Authority Backfill.
// Admin-only. Enriches serp_results.url_rating / domain_rating /
// referring_domains / backlinks for a project using Ahrefs batch-analysis and
// DataForSEO bulk endpoints — the same providers HAR already talks to.
// Does not touch HAR, forecasts, or revenue. Every run opens a
// calc_run_registry row so 8.3's cascade cleanup applies.
//
// Contract:
//   POST /functions/v1/lps-authority-backfill
//   Body: {
//     project_id: uuid,
//     mode: "estimate" | "run",
//     refresh_stale_days?: number,   // default 90
//     limit_urls?: number,           // default 5000, hard cap
//     include_competitors?: boolean  // default true
//   }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_PARTIAL_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import { buildBasicAuth } from "../_shared/dataforseo.ts";
import {
  AHREFS_BATCH_SIZE,
  buildUrlCandidates,
  chunk,
  coverageOf,
  DB_UPSERT_CHUNK,
  DEFAULT_LIMIT_URLS,
  DEFAULT_REFRESH_STALE_DAYS,
  DFS_BATCH_SIZE,
  filterCandidatesToFetch,
  LPS_BACKFILL_MODEL_VERSION,
  normaliseDomain,
  parseAhrefsAuthorityBatch,
  parseDfsAuthorityBatch,
  REQUEST_PARALLELISM,
  runPool,
  type SerpRowLite,
  type UrlCandidate,
} from "../_shared/lps-backfill.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SERP_PAGE = 1000;
const KW_ID_CHUNK = 100;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return json(status, { code, error, ...extra });
}
function dfsAuth(): string {
  const raw = Deno.env.get("DATAFORSEO_API_KEY") ?? "";
  return buildBasicAuth(raw);
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.status === 429 || resp.status >= 500) {
        await resp.text();
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  if (lastErr) throw lastErr;
  return await fetch(url, init);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return err(500, "misconfigured", "Missing Supabase env.");

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return err(401, "unauthorized", "Missing Authorization header.");

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: {
    project_id?: string;
    mode?: string;
    refresh_stale_days?: number;
    limit_urls?: number;
    include_competitors?: boolean;
  };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }

  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }
  const mode = payload?.mode === "run" ? "run" : "estimate";
  const includeCompetitors = payload?.include_competitors !== false;
  const refreshStaleDays = Math.max(
    0,
    Math.min(365, Number(payload?.refresh_stale_days ?? DEFAULT_REFRESH_STALE_DAYS)),
  );
  const limitUrls = Math.max(
    1,
    Math.min(DEFAULT_LIMIT_URLS, Math.floor(Number(payload?.limit_urls ?? DEFAULT_LIMIT_URLS))),
  );

  // Auth + admin gate.
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb
    .from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // Project visibility + archive gate.
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at")
    .eq("id", projectId).maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot backfill for an archived project.");
  }

  const clientId = (proj as { client_id?: string | null }).client_id ?? null;
  let clientDomain: string | null = null;
  if (clientId) {
    const { data: clientRow } = await sb
      .from("clients")
      .select("domain_normalized, domain")
      .eq("id", clientId).maybeSingle();
    clientDomain = normaliseDomain(
      (clientRow as { domain_normalized?: string | null; domain?: string | null } | null)?.domain_normalized
      ?? (clientRow as { domain?: string | null } | null)?.domain
      ?? null,
    );
  }

  // Load kept keyword ids.
  const { data: kwRows, error: kwErr } = await sb
    .from("keywords").select("id")
    .eq("project_id", projectId).eq("detox_status", "keep");
  if (kwErr) return err(500, "db_error", kwErr.message);
  const keywordIds = (kwRows ?? []).map((k) => String((k as { id: string }).id));

  if (keywordIds.length === 0) {
    return json(200, {
      mode,
      coverage_before: coverageOf([]),
      candidates_total: 0,
      candidates_to_fetch: 0,
      skipped_reason: "no_kept_keywords",
    });
  }

  // Load SERP rows for those keywords (chunked .in()).
  const serpRows: SerpRowLite[] = [];
  for (const ids of chunk(keywordIds, KW_ID_CHUNK)) {
    // page through in case a keyword has many rows
    let offset = 0;
    while (true) {
      const { data, error: sErr } = await sb
        .from("serp_results")
        .select("id, url, domain, url_rating, domain_rating, referring_domains, backlinks, fetched_at")
        .in("keyword_id", ids)
        .range(offset, offset + SERP_PAGE - 1);
      if (sErr) return err(500, "db_error", sErr.message);
      const batch = (data ?? []) as unknown as SerpRowLite[];
      serpRows.push(...batch);
      if (batch.length < SERP_PAGE) break;
      offset += SERP_PAGE;
    }
  }

  const coverageBefore = coverageOf(serpRows);

  // Optionally exclude competitor rows (keep only client-domain rows).
  const domainScopedRows = includeCompetitors
    ? serpRows
    : serpRows.filter((r) => clientDomain && normaliseDomain(r.domain) === clientDomain);

  const allCandidates = buildUrlCandidates(domainScopedRows);
  let toFetch = filterCandidatesToFetch(allCandidates, refreshStaleDays, new Date().toISOString());

  // Always include the client-domain seed if present, so
  // client_domain_metrics stays in sync.
  const clientSeedUrl = clientDomain ? `https://${clientDomain}` : null;

  let capped = false;
  if (toFetch.length > limitUrls) {
    toFetch = toFetch.slice(0, limitUrls);
    capped = true;
  }

  // ---- Estimate mode ----
  if (mode === "estimate") {
    return json(200, {
      mode,
      project_id: projectId,
      client_domain: clientDomain,
      keywords_seen: keywordIds.length,
      serp_rows_seen: serpRows.length,
      candidates_total: allCandidates.length,
      candidates_to_fetch: toFetch.length,
      ahrefs_calls_est: Math.ceil((toFetch.length + (clientSeedUrl ? 1 : 0)) / AHREFS_BATCH_SIZE),
      dataforseo_calls_est: Math.ceil(toFetch.length / DFS_BATCH_SIZE) * 2, // ref_domains + backlinks
      refresh_stale_days: refreshStaleDays,
      limit_urls: limitUrls,
      hit_limit: capped,
      coverage_before: coverageBefore,
    });
  }

  // ---- Run mode: open calc_run_registry ----
  const scope: Record<string, unknown> = {
    kind: "lps_authority_backfill_v1",
    refresh_stale_days: refreshStaleDays,
    limit_urls: limitUrls,
    include_competitors: includeCompetitors,
    client_domain: clientDomain,
    hit_limit: capped,
  };
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry").insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: LPS_BACKFILL_MODEL_VERSION,
      scope, status: "running",
      warnings: [], errors: [], summary_json: {},
    }).select("id").single();
  if (runErr || !runIns) return err(500, "db_error", runErr?.message ?? "Failed to open calc run.");
  const calcRunId = (runIns as { id: string }).id;

  const closeRun = async (
    status: CalcRunTerminalStatus,
    summary: Record<string, unknown>,
    warnings: unknown[], errors: unknown[],
  ) => {
    const { error: closeErr } = await sb.from("calc_run_registry").update({
      status, finished_at: new Date().toISOString(),
      summary_json: summary, warnings, errors,
    }).eq("id", calcRunId);
    if (closeErr) console.error("[lps-authority-backfill] close_run_failed", closeErr);
  };

  const AHREFS_KEY = Deno.env.get("AHREFS_API_KEY");
  if (!AHREFS_KEY) {
    await closeRun(CALC_RUN_FAILED_STATUS, { error: "missing_ahrefs_key" }, [], [{ code: "missing_ahrefs_key" }]);
    return err(500, "misconfigured", "AHREFS_API_KEY not set.");
  }
  const hasDataForSeoKey = !!Deno.env.get("DATAFORSEO_API_KEY");

  const warnings: unknown[] = [];
  const errors: unknown[] = [];

  // ---- Ahrefs UR/DR/RD/BL/ahrefs_rank ----
  const ahrefsResults = new Map<string, {
    url_rating: number | null;
    domain_rating: number | null;
    ahrefs_rank: number | null;
    referring_domains: number | null;
    backlinks: number | null;
  }>();

  // Ahrefs targets = every URL to fetch + the client seed.
  const ahrefsTargets: Array<{ url: string; mode: "exact" | "domain" }> = toFetch.map((c) => ({
    url: c.url, mode: "exact",
  }));
  if (clientSeedUrl && !ahrefsTargets.some((t) => t.url === clientSeedUrl)) {
    ahrefsTargets.push({ url: clientSeedUrl, mode: "domain" });
  }

  let ahrefsSuccess = 0, ahrefsFailed = 0, ahrefsRequested = 0;
  let ahrefsMatched = 0, ahrefsMatchedUr = 0, ahrefsMatchedDr = 0, ahrefsMatchedRd = 0, ahrefsMatchedBl = 0;
  const ahrefsDiagnostics: unknown[] = [];
  try {
    const batches = chunk(ahrefsTargets, AHREFS_BATCH_SIZE);
    await runPool(batches, REQUEST_PARALLELISM, async (targets) => {
      ahrefsRequested += targets.length;
      const resp = await fetchWithRetry("https://api.ahrefs.com/v3/batch-analysis/batch-analysis", {
        method: "POST",
        headers: { Authorization: `Bearer ${AHREFS_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          select: ["url", "url_rating", "domain_rating", "ahrefs_rank", "refdomains", "backlinks"],
          targets: targets.map((t) => ({ url: t.url, mode: t.mode, protocol: "both" })),
          output: "json",
        }),
      });
      if (!resp.ok) {
        const status = resp.status;
        const txt = await resp.text();
        ahrefsFailed += targets.length;
        warnings.push({ code: "ahrefs_http_error", status, sample: txt.slice(0, 200), targets: targets.length });
        return;
      }
      const body = await resp.json();
      const parsed = parseAhrefsAuthorityBatch(targets.map((t) => t.url), body);
      ahrefsDiagnostics.push(parsed.diagnostics);
      ahrefsMatched += parsed.diagnostics.matched;
      ahrefsMatchedUr += parsed.diagnostics.ur_matched;
      ahrefsMatchedDr += parsed.diagnostics.dr_matched;
      ahrefsMatchedRd += parsed.diagnostics.rd_matched;
      ahrefsMatchedBl += parsed.diagnostics.bl_matched;
      if (parsed.diagnostics.no_data_targets > 0 || parsed.diagnostics.unmatched_returned_targets.length > 0) {
        warnings.push({ code: "ahrefs_partial_or_empty_data", ...parsed.diagnostics });
      }
      for (const [target, r] of parsed.values) {
        ahrefsResults.set(target, {
          url_rating: r.url_rating,
          domain_rating: r.domain_rating,
          ahrefs_rank: r.ahrefs_rank,
          referring_domains: r.referring_domains,
          backlinks: r.backlinks,
        });
        if (r.url_rating !== null || r.domain_rating !== null || r.referring_domains !== null || r.backlinks !== null) {
          ahrefsSuccess += 1;
        }
      }
    });
  } catch (e) {
    errors.push({ code: "ahrefs_unhandled", message: e instanceof Error ? e.message : String(e) });
  }

  // ---- DataForSEO referring_domains + backlinks ----
  const dfsResults = new Map<string, { referring_domains: number | null; backlinks: number | null; source: "url" | "domain" }>();
  let dfsSuccess = 0, dfsFailed = 0, dfsRequested = 0, dfsUrlMatchedRd = 0, dfsUrlMatchedBl = 0, dfsDomainMatchedRd = 0, dfsDomainMatchedBl = 0;
  const dfsDiagnostics: unknown[] = [];

  const fetchDfsBatch = async (targets: string[], source: "url" | "domain") => {
    if (!targets.length) return;
    dfsRequested += targets.length;
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
    const parsed = parseDfsAuthorityBatch(targets, refData, blData, source);
    const diag = {
      ...parsed.diagnostics,
      rd_http_status: refResp.status,
      bl_http_status: blResp.status,
    };
    dfsDiagnostics.push(diag);
    if (!refResp.ok || !blResp.ok || !parsed.diagnostics.ok) {
      dfsFailed += targets.length;
      warnings.push({ code: "dfs_batch_not_clean", ...diag });
      return;
    }

    let batchWithAny = 0;
    for (const [target, metrics] of parsed.values) {
      if (metrics.referring_domains === null && metrics.backlinks === null) continue;
      batchWithAny += 1;
      dfsResults.set(target, {
        referring_domains: metrics.referring_domains,
        backlinks: metrics.backlinks,
        source,
      });
    }
    dfsSuccess += batchWithAny;
    if (source === "url") {
      dfsUrlMatchedRd += parsed.diagnostics.rd_matched;
      dfsUrlMatchedBl += parsed.diagnostics.bl_matched;
    } else {
      dfsDomainMatchedRd += parsed.diagnostics.rd_matched;
      dfsDomainMatchedBl += parsed.diagnostics.bl_matched;
    }
    if (parsed.diagnostics.no_data_targets > 0 || parsed.diagnostics.unmatched_returned_targets.length > 0) {
      warnings.push({ code: "dfs_partial_or_empty_data", ...diag });
    }
  };

  if (!hasDataForSeoKey) {
    warnings.push({ code: "missing_dfs_key", message: "DATAFORSEO_API_KEY not set; RD/BL fallback skipped." });
  } else {
    try {
      const candidatesNeedingDfs = toFetch.filter((c) => {
        const a = ahrefsResults.get(c.url);
        return !a || a.referring_domains === null || a.backlinks === null;
      });
      const targetsOnly = candidatesNeedingDfs.map((c) => c.url);
      const batches = chunk(targetsOnly, DFS_BATCH_SIZE);
      await runPool(batches, REQUEST_PARALLELISM, (targets) => fetchDfsBatch(targets, "url"));

      // Domain-level fallback: DataForSEO often has stronger coverage at domain
      // level than exact URL level. Use it only for URL candidates still missing
      // either RD or BL after the URL-level pass.
      const domainsNeedingFallback = Array.from(new Set(
        candidatesNeedingDfs
          .filter((c) => {
            const a = ahrefsResults.get(c.url);
            const v = dfsResults.get(c.url);
            return (a?.referring_domains ?? v?.referring_domains ?? null) === null
              || (a?.backlinks ?? v?.backlinks ?? null) === null;
          })
          .map((c) => c.domain ?? normaliseDomain(c.url))
          .filter((d): d is string => !!d),
      ));
      await runPool(chunk(domainsNeedingFallback, DFS_BATCH_SIZE), REQUEST_PARALLELISM, (targets) => fetchDfsBatch(targets, "domain"));

      for (const cand of toFetch) {
        const domain = cand.domain ?? normaliseDomain(cand.url);
        if (!domain) continue;
        const current = dfsResults.get(cand.url) ?? { referring_domains: null, backlinks: null, source: "url" as const };
        const fallback = dfsResults.get(domain);
        if (!fallback) continue;
        dfsResults.set(cand.url, {
          referring_domains: current.referring_domains ?? fallback.referring_domains,
          backlinks: current.backlinks ?? fallback.backlinks,
          source: current.referring_domains !== null && current.backlinks !== null ? current.source : "domain",
        });
      }
    } catch (e) {
      errors.push({ code: "dfs_unhandled", message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- Write results back to serp_results ----
  const updates: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();
  for (const cand of toFetch) {
    const a = ahrefsResults.get(cand.url);
    const d = dfsResults.get(cand.url);
    if (!a && !d) continue;
    for (const id of cand.ids) {
      const row: Record<string, unknown> = { id, fetched_at: nowIso };
      if (a) {
        if (a.url_rating !== null) row.url_rating = a.url_rating;
        if (a.domain_rating !== null) row.domain_rating = a.domain_rating;
        if (a.ahrefs_rank !== null) row.ahrefs_rank = a.ahrefs_rank;
        if (a.referring_domains !== null) row.referring_domains = a.referring_domains;
        if (a.backlinks !== null) row.backlinks = a.backlinks;
      }
      if (d) {
        if (row.referring_domains === undefined && d.referring_domains !== null) row.referring_domains = d.referring_domains;
        if (row.backlinks === undefined && d.backlinks !== null) row.backlinks = d.backlinks;
      }
      if (Object.keys(row).length > 2) updates.push(row);
    }
  }

  let rowsWritten = 0;
  for (const c of chunk(updates, DB_UPSERT_CHUNK)) {
    const { data: updated, error: rpcErr } = await sb.rpc("bulk_update_serp_authority", { _rows: c });
    if (rpcErr) {
      errors.push({ code: "serp_update_failed", message: rpcErr.message, chunk_size: c.length });
      continue;
    }
    rowsWritten += typeof updated === "number" ? updated : 0;
  }

  // Update client_domain_metrics from the client seed (mirror HAR behaviour).
  if (clientSeedUrl && clientDomain) {
    const seed = ahrefsResults.get(clientSeedUrl);
    if (seed) {
      const { error: cdmErr } = await sb.from("client_domain_metrics").upsert({
        project_id: projectId,
        domain: clientDomain,
        url_rating: seed.url_rating ?? 0,
        domain_rating: seed.domain_rating ?? 0,
        ahrefs_rank: seed.ahrefs_rank ?? 0,
        fetched_at: nowIso,
      }, { onConflict: "project_id" });
      if (cdmErr) warnings.push({ code: "client_domain_metrics_upsert_failed", message: cdmErr.message });
    }
  }

  // Re-measure coverage.
  const afterRows: SerpRowLite[] = [];
  for (const ids of chunk(keywordIds, KW_ID_CHUNK)) {
    let offset = 0;
    while (true) {
      const { data } = await sb
        .from("serp_results")
        .select("id, url, domain, url_rating, domain_rating, referring_domains, backlinks, fetched_at")
        .in("keyword_id", ids)
        .range(offset, offset + SERP_PAGE - 1);
      const batch = (data ?? []) as unknown as SerpRowLite[];
      afterRows.push(...batch);
      if (batch.length < SERP_PAGE) break;
      offset += SERP_PAGE;
    }
  }
  const coverageAfter = coverageOf(afterRows);

  const summary = {
    model_version: LPS_BACKFILL_MODEL_VERSION,
    keywords_seen: keywordIds.length,
    serp_rows_seen: serpRows.length,
    candidates_total: allCandidates.length,
    candidates_to_fetch: toFetch.length,
    hit_limit: capped,
    ahrefs_requested: ahrefsRequested,
    ahrefs_success: ahrefsSuccess,
    ahrefs_failed: ahrefsFailed,
    ahrefs_matched: ahrefsMatched,
    ahrefs_matched_ur: ahrefsMatchedUr,
    ahrefs_matched_dr: ahrefsMatchedDr,
    ahrefs_matched_rd: ahrefsMatchedRd,
    ahrefs_matched_bl: ahrefsMatchedBl,
    ahrefs_diagnostics: ahrefsDiagnostics,
    dfs_requested: dfsRequested,
    dfs_success: dfsSuccess,
    dfs_failed: dfsFailed,
    dfs_url_matched_rd: dfsUrlMatchedRd,
    dfs_url_matched_bl: dfsUrlMatchedBl,
    dfs_domain_matched_rd: dfsDomainMatchedRd,
    dfs_domain_matched_bl: dfsDomainMatchedBl,
    dfs_diagnostics: dfsDiagnostics,
    rows_written: rowsWritten,
    coverage_before: coverageBefore,
    coverage_after: coverageAfter,
    client_domain: clientDomain,
    refresh_stale_days: refreshStaleDays,
  };

  const rdImproved = coverageAfter.with_rd > coverageBefore.with_rd;
  const blImproved = coverageAfter.with_bl > coverageBefore.with_bl;
  const rdComplete = coverageAfter.total > 0 && coverageAfter.with_rd === coverageAfter.total;
  const blComplete = coverageAfter.total > 0 && coverageAfter.with_bl === coverageAfter.total;
  const hasProviderFailure = errors.length > 0 || ahrefsFailed > 0 || dfsFailed > 0;
  const status: CalcRunTerminalStatus = rowsWritten === 0 && errors.length > 0
    ? CALC_RUN_FAILED_STATUS
    : (hasProviderFailure || (!rdComplete && !rdImproved) || (!blComplete && !blImproved))
      ? CALC_RUN_PARTIAL_STATUS
      : CALC_RUN_SUCCESS_STATUS;
  await closeRun(status, summary, warnings, errors);

  return json(200, { calc_run_id: calcRunId, status, summary, warnings, errors });
});
