// dataforseo-historical-volume-backfill
// Admin-only. Backfills up to 48 (default 24) months of monthly search-volume
// history for a project's kept keywords via the DataForSEO Google Ads
// Search Volume Live endpoint. Writes rows with
// source = 'dataforseo_historical_backfill' via upsert on
// (keyword_id, month, source) so existing 'dataforseo_search_volume' rows
// (and any other source) are never touched. Manual invocation only —
// no cron, no v1 forecast recompute, no Labs endpoint.
//
// NOTE: This function must NEVER call `.delete()` on keyword_monthly_volumes.
// Historical rows from other sources must be preserved. `deletes_performed`
// is reported as 0 in the run summary and asserted before closing the run.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildBasicAuth, computeMonthRange, fetchGoogleAdsStatus, resolveStatusDrivenDateTo, type GoogleAdsStatusResult } from "../_shared/dataforseo.ts";
import { classifyReadiness, DEFAULT_READINESS_THRESHOLDS, type CoverageSummary } from "../_shared/phase6-readiness.ts";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DFS_BASE = "https://api.dataforseo.com";
const BOOT_TS = new Date().toISOString();
console.log(`[dataforseo-historical-volume-backfill] BOOT cluster-capture=1 at ${BOOT_TS}`);
// Standard Google Ads Search Volume Live endpoint. This endpoint accepts
// date_from / date_to and returns per-month history for the requested window.
// Per-task keyword limit is 1000; we chunk conservatively below.
const STANDARD_PATH = "/v3/keywords_data/google_ads/search_volume/live";
const ENDPOINT_ID = "keywords_data_google_ads_search_volume_live";
const LOCATION_CODE = 2826; // UK — matches keyword-enrichment and Phase 5.1 probe
const LANGUAGE_CODE = "en";
const MODEL_VERSION = "volume_history_v2.0.0";
const SOURCE = "dataforseo_historical_backfill";
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const KW_PER_BATCH = 700; // < DataForSEO per-task cap of 1000
const UPSERT_CHUNK = 1000;
const REQ_TIMEOUT_MS = 45_000;
const DEFAULT_REQUESTED_MONTHS = 24;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return json(status, { code, error, ...extra });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function callDfs(path: string, body: unknown, apiKey: string): Promise<{
  http_status: number | null;
  json: any;
  error: string | null;
}> {
  try {
    const res = await fetch(`${DFS_BASE}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${buildBasicAuth(apiKey)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    return { http_status: res.status, json: parsed, error: null };
  } catch (e) {
    return { http_status: null, json: null, error: (e as Error).message };
  }
}

// Extract per-keyword monthly entries from the standard endpoint's response.
function extractPerKeyword(body: any): Map<string, { months: Array<{ year: number; month: number; volume: number }>; core_keyword: string | null }> {
  const out = new Map<string, { months: Array<{ year: number; month: number; volume: number }>; core_keyword: string | null }>();
  const result: any[] = body?.tasks?.[0]?.result ?? [];
  for (const r of result) {
    const kw = String(r?.keyword ?? "").trim().toLowerCase();
    if (!kw) continue;
    const monthly: any[] = Array.isArray(r?.monthly_searches) ? r.monthly_searches : [];
    const rows: Array<{ year: number; month: number; volume: number }> = [];
    for (const h of monthly) {
      const y = Number(h?.year), m = Number(h?.month);
      if (!Number.isFinite(y) || !Number.isFinite(m)) continue;
      rows.push({ year: y, month: m, volume: Number(h?.search_volume ?? 0) || 0 });
    }
    const ckRaw = r?.keyword_properties?.core_keyword;
    const core_keyword = typeof ckRaw === "string" && ckRaw.trim().length ? ckRaw : null;
    if (rows.length || core_keyword) out.set(kw, { months: rows, core_keyword });
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return err(500, "misconfigured", "Missing Supabase env.");
  if (!DATAFORSEO_API_KEY) return err(500, "misconfigured", "Missing DATAFORSEO_API_KEY.");

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return err(401, "unauthorized", "Missing Authorization header.");

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: {
    project_id?: string;
    limit_keywords?: number;
    requested_months?: number;
    dry_run?: boolean;
  };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }

  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") return err(400, "invalid_payload", "project_id is required.");
  const dryRun = !!payload?.dry_run;
  const requestedLimit = Number(payload?.limit_keywords ?? DEFAULT_LIMIT);
  const limitKeywords = Math.max(
    1,
    Math.min(MAX_LIMIT, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_LIMIT),
  );
  const fallbackRange = computeMonthRange(
    Number(payload?.requested_months ?? DEFAULT_REQUESTED_MONTHS),
  );
  const requested_months = fallbackRange.requested_months;
  const statusProbe: GoogleAdsStatusResult = await fetchGoogleAdsStatus(DATAFORSEO_API_KEY, {
    locationCode: LOCATION_CODE,
    languageCode: LANGUAGE_CODE,
  });
  const resolved = resolveStatusDrivenDateTo(statusProbe, {
    date_from: fallbackRange.date_from,
    date_to: fallbackRange.date_to,
  });
  const date_from = resolved.date_from;
  const date_to = resolved.date_to;
  const date_to_source = resolved.source;
  const statusProbePublic = statusProbe.ok
    ? {
        ok: true as const,
        actual_data: statusProbe.actual_data,
        latest_finalised_month: statusProbe.latest_finalised_month,
        http_status: statusProbe.http_status,
        api_status_code: statusProbe.api_status_code,
        raw_snapshot: statusProbe.raw_snapshot,
      }
    : {
        ok: false as const,
        reason: statusProbe.reason,
        http_status: statusProbe.http_status,
        api_status_code: statusProbe.api_status_code,
        raw_snapshot: statusProbe.raw_snapshot,
      };

  // Auth + admin
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // Project visibility
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects").select("id").eq("id", projectId).maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");

  // Collect keywords
  const { data: kws, error: kwErr } = await sb
    .from("keywords")
    .select("id, keyword, avg_monthly_volume")
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .order("avg_monthly_volume", { ascending: false, nullsFirst: false })
    .limit(limitKeywords);
  if (kwErr) return err(500, "db_error", kwErr.message);
  const keywords = (kws ?? [])
    .map((k: any) => ({ id: String(k.id), keyword: String(k.keyword ?? "").trim() }))
    .filter((k) => k.keyword.length > 0);
  if (!keywords.length) return err(404, "no_keywords", "No kept keywords to backfill.");

  const kwToId = new Map<string, string>();
  for (const k of keywords) kwToId.set(k.keyword.toLowerCase(), k.id);

  // Open calc_run_registry row (even for graceful failure)
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: MODEL_VERSION,
      scope: {
        kind: "monthly_volume_backfill",
        endpoint: ENDPOINT_ID,
        limit_keywords: limitKeywords,
        requested_months,
        date_from,
        date_to,
        date_to_source,
        dry_run: dryRun,
      },
      status: "running",
      warnings: [],
      errors: [],
      summary_json: {},
    })
    .select("id")
    .single();
  if (runErr || !runIns) return err(500, "db_error", runErr?.message ?? "Failed to open calc run.");
  const calcRunId = (runIns as { id: string }).id;

  const closeRun = async (
    status: CalcRunTerminalStatus,
    summary: Record<string, unknown>,
    warnings: unknown[],
    errors: unknown[],
  ) => {
    const { error: closeErr } = await sb.from("calc_run_registry").update({
      status,
      finished_at: new Date().toISOString(),
      summary_json: summary,
      warnings,
      errors,
    }).eq("id", calcRunId);
    if (closeErr) {
      throw new Error(`calc_run_close_failed: ${closeErr.message}`);
    }
  };

  const warnings: string[] = [];
  if (date_to_source === "fallback_computed") {
    warnings.push(`google_ads_status_fallback: ${resolved.warning ?? "unknown"}`);
  }
  const errors: unknown[] = [];
  const statusCodeCounts: Record<string, number> = {};
  const responseShapeErrors: Array<{ batch_index: number; reason: string; http_status: number | null }> = [];
  let apiCalls = 0;
  let costReported = 0;
  const perKeywordMonths = new Map<string, number>(); // kw_id -> months returned
  const perKeywordCore = new Map<string, string>(); // kw_id -> core_keyword (raw)

  const rowsToUpsert: Array<{ keyword_id: string; month: string; volume: number; source: string; fetched_at: string }> = [];
  const nowIso = new Date().toISOString();

  const batches = chunk(keywords, KW_PER_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const kwStrings = batch.map((b) => b.keyword);
    const { http_status, json: body, error } = await callDfs(
      STANDARD_PATH,
      [{
        keywords: kwStrings,
        location_code: LOCATION_CODE,
        language_code: LANGUAGE_CODE,
        date_from,
        date_to,
      }],
      DATAFORSEO_API_KEY,
    );
    apiCalls += 1;
    if (error) {
      warnings.push(`Network error on batch ${bi} (${batch.length} kw): ${error}`);
      responseShapeErrors.push({ batch_index: bi, reason: `network_error:${error}`, http_status });
      continue;
    }
    if (!body) {
      warnings.push(`Non-JSON response on batch ${bi} (${batch.length} kw), http=${http_status}`);
      responseShapeErrors.push({ batch_index: bi, reason: "non_json_body", http_status });
      continue;
    }
    const apiCode = Number(body?.status_code ?? 0);
    const codeKey = String(apiCode || "unknown");
    statusCodeCounts[codeKey] = (statusCodeCounts[codeKey] ?? 0) + 1;
    if (apiCode !== 20000) {
      warnings.push(`API ${apiCode} ${body?.status_message ?? ""} on batch ${bi} (${batch.length} kw)`);
      continue;
    }
    const cost = Number(body?.tasks?.[0]?.cost ?? 0);
    if (Number.isFinite(cost)) costReported += cost;

    const taskResult = body?.tasks?.[0]?.result;
    if (!Array.isArray(taskResult)) {
      responseShapeErrors.push({ batch_index: bi, reason: "missing_or_non_array_result", http_status });
      warnings.push(`Missing tasks[0].result on batch ${bi}`);
      continue;
    }

    const perKw = extractPerKeyword(body);
    for (const [kwLower, entry] of perKw) {
      const id = kwToId.get(kwLower);
      if (!id) continue;
      const prev = perKeywordMonths.get(id) ?? 0;
      perKeywordMonths.set(id, prev + entry.months.length);
      if (entry.core_keyword) perKeywordCore.set(id, entry.core_keyword);
      for (const m of entry.months) {
        rowsToUpsert.push({
          keyword_id: id,
          month: `${m.year}-${String(m.month).padStart(2, "0")}-01`,
          volume: m.volume,
          source: SOURCE,
          fetched_at: nowIso,
        });
      }
    }
  }

  // Persist DataForSEO close-variant cluster identifiers (read-only metadata; never mutates volume).
  let clusterIdsWritten = 0;
  const distinctClusterIds = new Set<string>();
  if (!dryRun && perKeywordCore.size) {
    const entries = Array.from(perKeywordCore.entries());
    for (const [id, ck] of entries) {
      const clusterId = ck.trim().toLowerCase() || null;
      if (clusterId) distinctClusterIds.add(clusterId);
      const { error: upErr } = await sb
        .from("keywords")
        .update({ core_keyword: ck, keyword_cluster_id: clusterId, cluster_source: "dfs_core_keyword" })
        .eq("id", id);
      if (upErr) {
        errors.push({ code: "cluster_update_failed", message: upErr.message, keyword_id: id });
        continue;
      }
      clusterIdsWritten += 1;
    }
  } else if (dryRun) {
    for (const ck of perKeywordCore.values()) {
      const clusterId = ck.trim().toLowerCase();
      if (clusterId) distinctClusterIds.add(clusterId);
    }
    clusterIdsWritten = perKeywordCore.size;
  }

  const monthCounts = Array.from(perKeywordMonths.values());
  const keywordsWithResults = monthCounts.length;
  const keywordsFailed = keywords.length - keywordsWithResults;
  const keywordsWithLt24 = monthCounts.filter((n) => n < 24).length;
  const minMonths = monthCounts.length ? Math.min(...monthCounts) : 0;
  const maxMonths = monthCounts.length ? Math.max(...monthCounts) : 0;
  const medMonths = median(monthCounts);

  let monthsUpserted = 0;
  if (!dryRun && rowsToUpsert.length) {
    for (const c of chunk(rowsToUpsert, UPSERT_CHUNK)) {
      const { error: upErr } = await sb
        .from("keyword_monthly_volumes")
        .upsert(c, { onConflict: "keyword_id,month,source" });
      if (upErr) {
        errors.push({ code: "upsert_failed", message: upErr.message, chunk_size: c.length });
        continue;
      }
      monthsUpserted += c.length;
    }
  } else if (dryRun) {
    monthsUpserted = rowsToUpsert.length; // would-be count
  }

  // Defensive: this function never deletes from keyword_monthly_volumes.
  const deletesPerformed = 0;
  if ((deletesPerformed as number) !== 0) {
    throw new Error("Invariant violated: backfill must not delete monthly volume rows.");
  }

  // Phase 6 readiness — coverage RPC + classifier. Never fatal.
  let coverage: CoverageSummary | null = null;
  let readiness: { status: string; reason: string } = {
    status: "unknown",
    reason: "coverage_not_computed",
  };
  try {
    const { data: covRows, error: covErr } = await sb.rpc("project_monthly_coverage", {
      p_project_id: projectId,
    });
    if (covErr) throw covErr;
    const row = Array.isArray(covRows) ? covRows[0] : covRows;
    if (row) {
      coverage = {
        keywords_with_history: Number(row.keywords_with_history ?? 0),
        kept_keywords_total: Number(row.kept_keywords_total ?? 0),
        min_months: Number(row.min_months ?? 0),
        median_months: Number(row.median_months ?? 0),
        max_months: Number(row.max_months ?? 0),
        percent_keywords_at_or_above_24_months: Number(row.percent_keywords_at_or_above_24_months ?? 0),
        percent_keywords_at_or_above_12_months: Number(row.percent_keywords_at_or_above_12_months ?? 0),
      };
      const r = classifyReadiness(coverage);
      readiness = { status: r.status, reason: r.reason };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`readiness_coverage_failed: ${msg}`);
    readiness = { status: "unknown", reason: `coverage_rpc_failed: ${msg}` };
  }

  const summary = {
    requested_months,
    date_from,
    date_to,
    date_to_source,
    status_probe: statusProbePublic,
    endpoint_used: ENDPOINT_ID,
    source: SOURCE,
    keywords_requested: keywords.length,
    keywords_with_results: keywordsWithResults,
    keywords_failed: keywordsFailed,
    keywords_with_less_than_24_months: keywordsWithLt24,
    min_months_returned: minMonths,
    median_months_returned: medMonths,
    max_months_returned: maxMonths,
    status_code_counts: statusCodeCounts,
    response_shape_errors: responseShapeErrors,
    months_upserted: monthsUpserted,
    deletes_performed: deletesPerformed,
    cluster_ids_written: clusterIdsWritten,
    distinct_cluster_ids: distinctClusterIds.size,
    api_calls: apiCalls,
    cost_reported: Number(costReported.toFixed(6)),
    coverage,
    readiness,
    readiness_thresholds: DEFAULT_READINESS_THRESHOLDS,
    warnings,
    errors,
    dry_run: dryRun,
  };

  const runStatus =
    !dryRun && monthsUpserted === 0 && errors.length > 0
      ? CALC_RUN_FAILED_STATUS
      : CALC_RUN_SUCCESS_STATUS;
  await closeRun(runStatus, summary, warnings, errors);

  console.log(
    "[dataforseo-historical-volume-backfill] project=%s endpoint=%s requested_months=%d attempted=%d with_results=%d months=%d dry=%s",
    projectId, ENDPOINT_ID, requested_months, keywords.length, keywordsWithResults, monthsUpserted, String(dryRun),
  );

  return json(200, {
    calc_run_id: calcRunId,
    endpoint_used: ENDPOINT_ID,
    requested_months,
    date_from,
    date_to,
    date_to_source,
    status_probe: statusProbePublic,
    source: SOURCE,
    readiness,
    summary,
    dry_run: dryRun,
  });
});
