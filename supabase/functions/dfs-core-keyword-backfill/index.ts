// dfs-core-keyword-backfill
// Admin-only. For a project's kept keywords, calls DataForSEO
// google_ads/search_volume/live and persists ONLY the close-variant cluster
// identifier onto public.keywords (core_keyword, keyword_cluster_id,
// cluster_source). Never touches volume, monthly volumes, difficulty, intent,
// detox, or forecasting.
//
// BOOT: dfs-core-keyword-backfill v1.0.0 build=2026-07-20T21:15Z

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildBasicAuth } from "../_shared/dataforseo.ts";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";

const BOOT_TS = new Date().toISOString();
console.log(`[dfs-core-keyword-backfill] BOOT v1.0.0 at ${BOOT_TS}`);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DFS_BASE = "https://api.dataforseo.com";
const STANDARD_PATH = "/v3/keywords_data/google_ads/search_volume/live";
const ENDPOINT_ID = "keywords_data_google_ads_search_volume_live";
const LOCATION_CODE = 2826;
const LANGUAGE_CODE = "en";
const MODEL_VERSION = "cluster_backfill_v1.0.0";
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;
const KW_PER_BATCH = 700;
const REQ_TIMEOUT_MS = 45_000;

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

async function callDfs(body: unknown, apiKey: string) {
  try {
    const res = await fetch(`${DFS_BASE}${STANDARD_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${buildBasicAuth(apiKey)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    return { http_status: res.status, json: parsed, error: null as string | null };
  } catch (e) {
    return { http_status: null, json: null, error: (e as Error).message };
  }
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

  let payload: { project_id?: string; limit_keywords?: number; dry_run?: boolean };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") return err(400, "invalid_payload", "project_id is required.");
  const dryRun = !!payload?.dry_run;
  const requestedLimit = Number(payload?.limit_keywords ?? DEFAULT_LIMIT);
  const limitKeywords = Math.max(
    1,
    Math.min(MAX_LIMIT, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_LIMIT),
  );

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  const { data: proj, error: projErr } = await sb
    .from("navigator_projects").select("id").eq("id", projectId).maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");

  const { data: kws, error: kwErr } = await sb
    .from("keywords")
    .select("id, keyword")
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

  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: MODEL_VERSION,
      scope: {
        kind: "cluster_backfill",
        endpoint: ENDPOINT_ID,
        limit_keywords: limitKeywords,
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

  const warnings: string[] = [];
  const errors: unknown[] = [];
  const statusCodeCounts: Record<string, number> = {};
  let apiCalls = 0;
  let costReported = 0;

  const perKeywordCore = new Map<string, string>();
  const batches = chunk(keywords, KW_PER_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const kwStrings = batch.map((b) => b.keyword);
    const { http_status, json: body, error: netErr } = await callDfs(
      [{ keywords: kwStrings, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE }],
      DATAFORSEO_API_KEY,
    );
    apiCalls += 1;
    if (netErr) { warnings.push(`network:${netErr} batch=${bi}`); continue; }
    if (!body) { warnings.push(`non_json http=${http_status} batch=${bi}`); continue; }
    const apiCode = Number(body?.status_code ?? 0);
    statusCodeCounts[String(apiCode || "unknown")] = (statusCodeCounts[String(apiCode || "unknown")] ?? 0) + 1;
    if (apiCode !== 20000) { warnings.push(`api ${apiCode} ${body?.status_message ?? ""} batch=${bi}`); continue; }
    const cost = Number(body?.tasks?.[0]?.cost ?? 0);
    if (Number.isFinite(cost)) costReported += cost;

    const result: any[] = body?.tasks?.[0]?.result ?? [];
    for (const r of result) {
      const kw = String(r?.keyword ?? "").trim().toLowerCase();
      if (!kw) continue;
      const id = kwToId.get(kw);
      if (!id) continue;
      const ck = r?.keyword_properties?.core_keyword;
      if (typeof ck === "string" && ck.trim().length) perKeywordCore.set(id, ck);
    }
  }

  const distinctClusterIds = new Set<string>();
  let keywordsUpdated = 0;
  if (!dryRun) {
    for (const [id, ck] of perKeywordCore) {
      const clusterId = ck.trim().toLowerCase() || null;
      if (clusterId) distinctClusterIds.add(clusterId);
      const { error: upErr } = await sb
        .from("keywords")
        .update({ core_keyword: ck, keyword_cluster_id: clusterId, cluster_source: "dfs_core_keyword" })
        .eq("id", id);
      if (upErr) { errors.push({ code: "cluster_update_failed", message: upErr.message, keyword_id: id }); continue; }
      keywordsUpdated += 1;
    }
  } else {
    for (const ck of perKeywordCore.values()) {
      const clusterId = ck.trim().toLowerCase();
      if (clusterId) distinctClusterIds.add(clusterId);
    }
    keywordsUpdated = perKeywordCore.size;
  }

  const summary = {
    endpoint_used: ENDPOINT_ID,
    keywords_scanned: keywords.length,
    keywords_with_core_keyword: perKeywordCore.size,
    keywords_updated: keywordsUpdated,
    distinct_cluster_ids: distinctClusterIds.size,
    status_code_counts: statusCodeCounts,
    api_calls: apiCalls,
    cost_reported: Number(costReported.toFixed(6)),
    warnings,
    errors,
    dry_run: dryRun,
  };

  const runStatus: CalcRunTerminalStatus =
    !dryRun && keywordsUpdated === 0 && errors.length > 0
      ? CALC_RUN_FAILED_STATUS
      : CALC_RUN_SUCCESS_STATUS;

  const { error: closeErr } = await sb.from("calc_run_registry").update({
    status: runStatus,
    finished_at: new Date().toISOString(),
    summary_json: summary,
    warnings,
    errors,
  }).eq("id", calcRunId);
  if (closeErr) return err(500, "db_error", `calc_run_close_failed: ${closeErr.message}`);

  console.log(
    "[dfs-core-keyword-backfill] project=%s scanned=%d with_ck=%d updated=%d distinct=%d dry=%s",
    projectId, keywords.length, perKeywordCore.size, keywordsUpdated, distinctClusterIds.size, String(dryRun),
  );

  return json(200, { calc_run_id: calcRunId, summary, dry_run: dryRun, boot_ts: BOOT_TS });
});
