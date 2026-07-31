// dataforseo-history-probe
// Admin-only capability probe: does the current DataForSEO account expose
// ≥ 24 months of monthly search volume? Runs at most two upstream calls
// against ≤ 5 keywords. Read-only — writes nothing.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildBasicAuth, computeMonthRange, fetchGoogleAdsStatus, resolveStatusDrivenDateTo, type GoogleAdsStatusResult } from "../_shared/dataforseo.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DFS_BASE = "https://api.dataforseo.com";
const LABS_PATH = "/v3/dataforseo_labs/google/historical_search_volume/live";
const STANDARD_PATH = "/v3/keywords_data/google_ads/search_volume/live";
const LOCATION_CODE = 2826; // UK, matches other functions
const LANGUAGE_CODE = "en";
const MAX_SAMPLE = 5;
const DEFAULT_SAMPLE = 3;
const DEFAULT_REQUESTED_MONTHS = 24;
const MAX_REQUESTED_MONTHS = 48;

// Fallback date window when the Google Ads Status endpoint cannot be read.
// Delegates to the shared `computeMonthRange`, which applies the Google Ads
// finalisation lag so `date_to` never sits past the last finalised month.
function computeDateRange(months: number): { date_from: string; date_to: string } {
  const r = computeMonthRange(months);
  return { date_from: r.date_from, date_to: r.date_to };
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(status: number, code: string, error: string) {
  return json(status, { code, error });
}

type ProbeStatus = "available" | "unauthorized" | "not_available" | "error";
interface ProbeResult {
  endpoint: string;
  path: string;
  status: ProbeStatus;
  http_status: number | null;
  api_status_code: number | null;
  api_status_message: string | null;
  sample_keyword: string | null;
  months_returned: number | null;
  months_returned_min: number | null;
  months_returned_max: number | null;
  per_keyword_months: Array<{ keyword: string; months: number }>;
  earliest_month: string | null;
  latest_month: string | null;
  response_shape: Record<string, unknown> | null;
  cost_reported: number | null;
  notes: string;
}

function emptyProbe(endpoint: string, path: string): ProbeResult {
  return {
    endpoint, path,
    status: "error",
    http_status: null,
    api_status_code: null,
    api_status_message: null,
    sample_keyword: null,
    months_returned: null,
    months_returned_min: null,
    months_returned_max: null,
    per_keyword_months: [],
    earliest_month: null,
    latest_month: null,
    response_shape: null,
    cost_reported: null,
    notes: "",
  };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function summariseMonths(rows: Array<{ year?: number; month?: number }>): {
  count: number; earliest: string | null; latest: string | null;
} {
  const keys: string[] = [];
  for (const r of rows) {
    if (typeof r?.year === "number" && typeof r?.month === "number") {
      keys.push(monthKey(r.year, r.month));
    }
  }
  if (!keys.length) return { count: 0, earliest: null, latest: null };
  keys.sort();
  return { count: keys.length, earliest: keys[0], latest: keys[keys.length - 1] };
}

async function callDfs(path: string, body: unknown, apiKey: string): Promise<{
  http_status: number | null; json: any; error: string | null;
}> {
  try {
    const res = await fetch(`${DFS_BASE}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${buildBasicAuth(apiKey)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    return { http_status: res.status, json: parsed, error: null };
  } catch (e) {
    return { http_status: null, json: null, error: (e as Error).message };
  }
}

async function probeLabs(keywords: string[], apiKey: string): Promise<ProbeResult> {
  const p = emptyProbe("labs_historical_search_volume", LABS_PATH);
  const { http_status, json: body, error } = await callDfs(
    LABS_PATH,
    [{ keywords, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE }],
    apiKey,
  );
  p.http_status = http_status;
  if (error) { p.status = "error"; p.notes = `Network: ${error}`; return p; }
  if (!body) { p.status = "error"; p.notes = "Non-JSON response."; return p; }

  const apiCode = Number(body.status_code ?? null);
  const apiMsg = String(body.status_message ?? "");
  p.api_status_code = Number.isFinite(apiCode) ? apiCode : null;
  p.api_status_message = apiMsg || null;
  p.cost_reported = typeof body?.tasks?.[0]?.cost === "number" ? body.tasks[0].cost : null;

  // 40100/40200/40400 => auth/subscription issues
  if (apiCode === 40100 || apiCode === 40200 || apiCode === 40400 || http_status === 401 || http_status === 403) {
    p.status = "unauthorized";
    p.notes = "Labs endpoint not accessible with current credentials.";
    return p;
  }
  if (apiCode !== 20000) {
    p.status = apiCode === 40404 ? "not_available" : "error";
    p.notes = `API returned ${apiCode}: ${apiMsg}`;
    return p;
  }

  const result = body?.tasks?.[0]?.result?.[0];
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  const first = items[0] ?? null;
  const keyword_info = first?.keyword_data?.keyword_info ?? first?.keyword_info ?? null;
  const history: any[] = Array.isArray(keyword_info?.history) ? keyword_info.history
    : Array.isArray(keyword_info?.monthly_searches) ? keyword_info.monthly_searches
    : Array.isArray(first?.history) ? first.history : [];
  const summary = summariseMonths(history);

  p.status = "available";
  p.sample_keyword = (first?.keyword_data?.keyword ?? first?.keyword ?? keywords[0]) as string;
  p.months_returned = summary.count;
  p.earliest_month = summary.earliest;
  p.latest_month = summary.latest;
  p.response_shape = {
    items_count: items.length,
    first_item_keys: first ? Object.keys(first) : [],
    has_history_array: Array.isArray(keyword_info?.history),
    has_monthly_searches: Array.isArray(keyword_info?.monthly_searches),
  };
  p.notes = summary.count > 0
    ? `Labs returned ${summary.count} months of history.`
    : "Labs responded OK but returned no history rows.";
  return p;
}

async function probeStandard(
  keywords: string[],
  apiKey: string,
  dateFrom: string,
  dateTo: string,
): Promise<ProbeResult> {
  const p = emptyProbe("keywords_data_search_volume", STANDARD_PATH);
  const { http_status, json: body, error } = await callDfs(
    STANDARD_PATH,
    [{
      keywords,
      location_code: LOCATION_CODE,
      language_code: LANGUAGE_CODE,
      date_from: dateFrom,
      date_to: dateTo,
    }],
    apiKey,
  );
  p.http_status = http_status;
  if (error) { p.status = "error"; p.notes = `Network: ${error}`; return p; }
  if (!body) { p.status = "error"; p.notes = "Non-JSON response."; return p; }

  const apiCode = Number(body.status_code ?? null);
  const apiMsg = String(body.status_message ?? "");
  p.api_status_code = Number.isFinite(apiCode) ? apiCode : null;
  p.api_status_message = apiMsg || null;
  p.cost_reported = typeof body?.tasks?.[0]?.cost === "number" ? body.tasks[0].cost : null;

  if (apiCode === 40100 || apiCode === 40200 || http_status === 401 || http_status === 403) {
    p.status = "unauthorized";
    p.notes = "Standard endpoint auth failed — check DataForSEO credentials.";
    return p;
  }
  if (apiCode !== 20000) {
    p.status = "error";
    p.notes = `API returned ${apiCode}: ${apiMsg}`;
    return p;
  }

  const result: any[] = body?.tasks?.[0]?.result ?? [];
  const perKeyword: Array<{ keyword: string; months: number }> = [];
  let overallEarliest: string | null = null;
  let overallLatest: string | null = null;
  for (const r of result) {
    const kw = String(r?.keyword ?? "").trim();
    const monthly: any[] = Array.isArray(r?.monthly_searches) ? r.monthly_searches : [];
    const summary = summariseMonths(monthly);
    perKeyword.push({ keyword: kw, months: summary.count });
    if (summary.earliest && (!overallEarliest || summary.earliest < overallEarliest)) overallEarliest = summary.earliest;
    if (summary.latest && (!overallLatest || summary.latest > overallLatest)) overallLatest = summary.latest;
  }

  const counts = perKeyword.map((k) => k.months);
  const first = result[0] ?? null;
  p.status = "available";
  p.sample_keyword = first?.keyword ?? keywords[0];
  p.months_returned = counts.length ? Math.max(...counts) : 0;
  p.months_returned_min = counts.length ? Math.min(...counts) : 0;
  p.months_returned_max = counts.length ? Math.max(...counts) : 0;
  p.per_keyword_months = perKeyword;
  p.earliest_month = overallEarliest;
  p.latest_month = overallLatest;
  p.response_shape = {
    items_count: result.length,
    first_item_keys: first ? Object.keys(first) : [],
    has_monthly_searches: Array.isArray(first?.monthly_searches),
  };
  p.notes = counts.length
    ? `Standard endpoint returned ${p.months_returned_min}–${p.months_returned_max} months per sample keyword for ${dateFrom} → ${dateTo}.`
    : "Standard endpoint responded OK but returned no monthly_searches rows.";
  return p;
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

  let payload: { project_id?: string; sample_size?: number; requested_months?: number };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") return err(400, "invalid_payload", "project_id is required.");
  const requested = Number(payload?.sample_size ?? DEFAULT_SAMPLE);
  const sampleSize = Math.max(1, Math.min(MAX_SAMPLE, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_SAMPLE));
  const reqMonthsIn = Number(payload?.requested_months ?? DEFAULT_REQUESTED_MONTHS);
  const requestedMonths = Math.max(
    1,
    Math.min(MAX_REQUESTED_MONTHS, Number.isFinite(reqMonthsIn) ? Math.floor(reqMonthsIn) : DEFAULT_REQUESTED_MONTHS),
  );
  const fallbackRange = computeDateRange(requestedMonths);
  const statusProbe: GoogleAdsStatusResult = await fetchGoogleAdsStatus(DATAFORSEO_API_KEY, {
    locationCode: LOCATION_CODE,
    languageCode: LANGUAGE_CODE,
  });
  const resolved = resolveStatusDrivenDateTo(statusProbe, fallbackRange);
  const dateFrom = resolved.date_from;
  const dateTo = resolved.date_to;
  const dateToSource = resolved.source;
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
    .select("keyword, avg_monthly_volume")
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .gt("avg_monthly_volume", 0)
    .order("avg_monthly_volume", { ascending: false })
    .limit(sampleSize);
  if (kwErr) return err(500, "db_error", kwErr.message);
  const keywords = (kws ?? []).map((k: any) => String(k.keyword).trim()).filter(Boolean);

  if (!keywords.length) {
    return json(200, {
      endpoint_checked: "keywords_data_search_volume",
      requested_months: requestedMonths,
      date_from: dateFrom,
      date_to: dateTo,
      months_returned_min: null,
      months_returned_max: null,
      feasible: false,
      recommendation: "no_keywords_to_probe",
      failure_reason: "Project has no kept keywords with avg_monthly_volume > 0. Add keywords or run enrichment before probing history.",
      recommended: {
        endpoint: "none",
        months_available_estimate: 0,
        feasible_for_24_month_backfill: false,
        reason: "No kept keywords available to sample.",
      },
      probes: [],
      sample_used: { count: 0, keywords: [] },
      date_to_source: dateToSource,
      status_probe: statusProbePublic,
      warnings: dateToSource === "fallback_computed" ? [`google_ads_status_fallback: ${resolved.warning ?? "unknown"}`] : [],
    });
  }

  console.log("[dataforseo-history-probe] project=%s sample=%d requested_months=%d", projectId, keywords.length, requestedMonths);

  // Standard endpoint is the sole feasibility signal. Labs is informational only.
  const std = await probeStandard(keywords, DATAFORSEO_API_KEY, dateFrom, dateTo);
  const labs = await probeLabs(keywords, DATAFORSEO_API_KEY);

  console.log("[dataforseo-history-probe] std.status=%s months=%s labs.status=%s months=%s",
    std.status, std.months_returned, labs.status, labs.months_returned);

  // Feasibility from Standard only.
  const stdMax = std.months_returned_max ?? 0;
  const stdMin = std.months_returned_min ?? 0;
  const threshold = requestedMonths - 1;

  let feasible = false;
  let recommendation:
    | "standard_endpoint_feasible"
    | "standard_endpoint_partial_history"
    | "standard_endpoint_auth_failed"
    | "standard_endpoint_error"
    | "no_keywords_to_probe" = "standard_endpoint_error";
  let failureReason: string | null = null;
  let recommendedReason = "";
  let recommendedEndpoint = "none";
  let recommendedMonths = 0;

  if (std.status === "available") {
    recommendedMonths = stdMax;
    if (stdMax >= threshold) {
      feasible = true;
      recommendation = "standard_endpoint_feasible";
      recommendedEndpoint = "keywords_data_search_volume";
      recommendedReason = `Standard Google Ads Search Volume returned ${stdMin === stdMax ? stdMax : `${stdMin}–${stdMax}`} months per sample keyword for ${dateFrom} → ${dateTo}.`;
    } else {
      recommendation = "standard_endpoint_partial_history";
      recommendedEndpoint = "keywords_data_search_volume";
      failureReason = `Standard endpoint returned only ${stdMax} of ${requestedMonths} requested months for the best sample keyword.`;
      recommendedReason = failureReason;
    }
  } else if (std.status === "unauthorized") {
    recommendation = "standard_endpoint_auth_failed";
    failureReason = "Standard Google Ads Search Volume endpoint returned an auth error. This is a DataForSEO credentials/auth configuration problem — it is NOT evidence that 24-month history requires Labs.";
    recommendedReason = failureReason;
  } else {
    recommendation = "standard_endpoint_error";
    failureReason = `Standard endpoint probe failed: ${std.notes || std.api_status_message || "unknown error"}.`;
    recommendedReason = failureReason;
  }

  const warnings: string[] = [];
  if (dateToSource === "fallback_computed") {
    warnings.push(`google_ads_status_fallback: ${resolved.warning ?? "unknown"}`);
  }
  if (labs.status === "unauthorized") {
    warnings.push("Labs endpoint denied — informational only, does not affect 24-month feasibility.");
  } else if (labs.status === "available") {
    warnings.push(`Labs also available (${labs.months_returned ?? 0} months) — informational only, backfill uses the Standard endpoint.`);
  } else if (labs.status === "error" || labs.status === "not_available") {
    warnings.push(`Labs probe: ${labs.status} — informational only.`);
  }

  return json(200, {
    endpoint_checked: "keywords_data_search_volume",
    requested_months: requestedMonths,
    date_from: dateFrom,
    date_to: dateTo,
    date_to_source: dateToSource,
    status_probe: statusProbePublic,
    months_returned_min: std.status === "available" ? stdMin : null,
    months_returned_max: std.status === "available" ? stdMax : null,
    feasible,
    recommendation,
    failure_reason: failureReason,
    recommended: {
      endpoint: recommendedEndpoint,
      months_available_estimate: recommendedMonths,
      feasible_for_24_month_backfill: feasible,
      reason: recommendedReason,
    },
    probes: [std, labs],
    sample_used: { count: keywords.length, keywords },
    warnings,
  });
});
