// compute-forecasts-v2
// Phase 10 · Prompt 10.2 — Revenue v2 shadow computation.
//
// Admin-only, manual invocation. Reads stored data only (no external calls).
// Updates revenue columns on the existing HAR v2 keyword_forecast_scenarios
// rows produced by har-calculation-v2. HAR v1 (compute-forecasts,
// keyword_forecasts) is NOT touched.
//
// Contract:
//   POST /functions/v1/compute-forecasts-v2
//   Body: { project_id: uuid, har_calc_run_id?: uuid }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_PARTIAL_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import { buildCtrResolverV2 } from "../_shared/ctr-resolver-v2.ts";
import {
  indexOverrides,
  resolveConversionOverride,
  type OverrideRow,
} from "../_shared/conversion-override-resolver.ts";
import {
  annualVolumeFromInputs,
  computeRevenueV2,
  REVENUE_V2_MODEL_VERSION,
  type MonthlyVolumeRow,
} from "../_shared/revenue-v2.ts";
// HAR_V2_MODEL_VERSION is intentionally NOT imported here — the HAR guard
// accepts any latest terminal har_v2.* run (see prefix query below).

import {
  resolveSerpVisibilityV2,
  type SerpAdjustmentRow,
  type SerpFeatureRow,
} from "../_shared/serp-visibility-v2.ts";
import { selectIn } from "../_shared/pgrst-in.ts";

const KW_CHUNK = 200;
const UPDATE_CHUNK = 100;


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
function serializeErr(e: unknown): { code?: string; message: string; details?: string; hint?: string } {
  if (e instanceof Error) return { message: e.message };
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : undefined,
      message: typeof o.message === "string" ? o.message : JSON.stringify(e),
      details: typeof o.details === "string" ? o.details : undefined,
      hint: typeof o.hint === "string" ? o.hint : undefined,
    };
  }
  return { message: String(e) };
}

type WarningBag = Map<string, { count: number; samples: string[] }>;
function bump(bag: WarningBag, code: string, sample?: string) {
  const cur = bag.get(code) ?? { count: 0, samples: [] };
  cur.count += 1;
  if (sample && cur.samples.length < 10) cur.samples.push(sample);
  bag.set(code, cur);
}
/**
 * Dedupe-aware bump: no-ops if `seen` already contains `code`. Used to ensure
 * each (scenario, code) pair contributes at most once to `warnings_count`
 * (fixes the double-count where index.ts and computeRevenueV2 both emit the
 * same code for the same scenario row).
 */
function bumpOnce(bag: WarningBag, seen: Set<string>, code: string, sample?: string) {
  if (seen.has(code)) return;
  seen.add(code);
  bump(bag, code, sample);
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

  let payload: { project_id?: string; har_calc_run_id?: string };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }
  const requestedHarRunId = payload?.har_calc_run_id ?? null;

  // Auth + admin
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;
  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // Project visibility
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at, conversion_rate, aov")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot compute Revenue v2 for an archived project.");
  }
  const project = proj as { id: string; conversion_rate: number | null; aov: number | null };
  const projectCvrDecimal =
    project.conversion_rate != null && Number.isFinite(Number(project.conversion_rate))
      ? Number(project.conversion_rate) / 100
      : null;
  const projectAov =
    project.aov != null && Number.isFinite(Number(project.aov)) ? Number(project.aov) : null;

  // Duplicate-run guard
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", REVENUE_V2_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    return err(409, "revenue_v2_run_in_progress", "Another Revenue v2 run is already in progress.", {
      calc_run_id: (inflight[0] as { id: string }).id,
    });
  }

  // Resolve target HAR v2 run — accept any har_v2.* terminal run (latest wins).
  // This decouples Revenue v2 from HAR v2 patch/minor bumps: the consumed
  // version is recorded in summary_json.har_model_version below.
  let harCalcRunId = requestedHarRunId;
  let harModelVersion: string | null = null;
  if (!harCalcRunId) {
    const { data: latestHar, error: harErr } = await sb
      .from("calc_run_registry")
      .select("id, model_version")
      .eq("project_id", projectId)
      .like("model_version", "har_v2%")
      .in("status", ["succeeded", "partial"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (harErr) return err(500, "db_error", harErr.message);
    const row = latestHar as { id: string; model_version: string } | null;
    harCalcRunId = row?.id ?? null;
    harModelVersion = row?.model_version ?? null;
  } else {
    // Requested explicitly — look up its version for audit.
    const { data: reqRow, error: reqErr } = await sb
      .from("calc_run_registry")
      .select("model_version")
      .eq("id", harCalcRunId)
      .maybeSingle();
    if (reqErr) return err(500, "db_error", reqErr.message);
    harModelVersion = (reqRow as { model_version: string } | null)?.model_version ?? null;
  }
  if (!harCalcRunId) {
    return err(409, "missing_har_v2_run", "No successful HAR v2 run for this project. Run HAR v2 first.");
  }




  // Open calc_run
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: REVENUE_V2_MODEL_VERSION,
      scope: { kind: "revenue_v2", har_calc_run_id: harCalcRunId, har_model_version: harModelVersion },
      status: "running",
      warnings: [],
      errors: [],
      summary_json: {},
    })
    .select("id")
    .single();
  if (runErr || !runIns) return err(500, "db_error", runErr?.message ?? "Failed to open calc run.");
  const calcRunId = (runIns as { id: string }).id;

  const dbErrors: unknown[] = [];
  const warnings: WarningBag = new Map();

  const closeRun = async (
    status: CalcRunTerminalStatus,
    summary: Record<string, unknown>,
  ) => {
    const warningsArr = Array.from(warnings.entries()).map(([code, v]) => ({
      code, count: v.count, samples: v.samples,
    }));
    const { error: closeErr } = await sb.from("calc_run_registry").update({
      status,
      finished_at: new Date().toISOString(),
      summary_json: summary,
      warnings: warningsArr,
      errors: dbErrors,
    }).eq("id", calcRunId);
    if (closeErr) console.error("[compute-forecasts-v2] close-on-error failed", closeErr);
  };

  try {
    // Load CTR curves (+ metadata for tie-break)
    const [{ data: curves }, { data: curveMeta }] = await Promise.all([
      sb.from("ctr_curves")
        .select("id, project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback")
        .or(`project_id.eq.${projectId},is_fallback.eq.true`),
      sb.from("ctr_curve_metadata")
        .select("ctr_curve_id, source, confidence, sample_impressions, sample_clicks, date_range_start, date_range_end"),
    ]);
    const ctrResolver = buildCtrResolverV2({
      curves: (curves ?? []) as any,
      metadata: (curveMeta ?? []) as any,
    });

    // Load conversion overrides for this project
    const { data: overrideRows } = await sb
      .from("project_conversion_overrides")
      .select("id, scope_type, scope_value, conversion_rate, average_order_value, confidence, source")
      .eq("project_id", projectId);
    const overrideIdx = indexOverrides((overrideRows ?? []) as OverrideRow[]);

    // Load HAR v2 scenario rows for the target run.
    // NOTE: we intentionally do NOT read serp_visibility_multiplier here for
    // revenue purposes — Revenue v2.1 resolves SVM live via
    // resolveSerpVisibilityV2 from serp_features + serp_feature_ctr_adjustments.
    // HAR v2 continues to write that column as a diagnostic.
    const scenarioRows: Array<{
      id: string;
      keyword_id: string;
      scenario: string;
      har_position: number | null;
      har_confidence: number | null;
      rank_attainment_probability: number | null;
      explanation_json: Record<string, unknown> | null;
    }> = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from("keyword_forecast_scenarios")
        .select("id, keyword_id, scenario, har_position, har_confidence, rank_attainment_probability, explanation_json")
        .eq("calc_run_id", harCalcRunId)
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as typeof scenarioRows;
      scenarioRows.push(...rows);
      if (rows.length < 1000) break;
      offset += 1000;
    }

    if (scenarioRows.length === 0) {
      const summary = {
        model_version: REVENUE_V2_MODEL_VERSION,
        har_calc_run_id: harCalcRunId,
        har_model_version: harModelVersion,

        scenarios_updated: 0,
        keywords_covered: 0,
        rows_fetched: { keyword_forecast_scenarios: 0, keywords: 0, keyword_monthly_volumes: 0, serp_features: 0 },
        skipped_reason: "no_scenarios_for_har_run",
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // Group scenarios by keyword
    const byKw = new Map<string, typeof scenarioRows>();
    for (const r of scenarioRows) {
      const arr = byKw.get(r.keyword_id) ?? [];
      arr.push(r);
      byKw.set(r.keyword_id, arr);
    }
    const keywordIds = Array.from(byKw.keys());

    // Fetch kept keywords (only those with scenarios in scope)
    const kwMeta = new Map<string, {
      id: string; device: string | null; search_intent: string | null;
      avg_monthly_volume: number | null; base_rank: number | null;
      ranking_url: string | null;
      tags: (string | null)[];
    }>();
    // Incident 2026-07-16-part2: keep every IN-list URL under the edge-runtime
    // cap by routing prefetches through selectIn (MAX_IN_CHUNK=100).
    const rowsFetched = {
      keyword_forecast_scenarios: scenarioRows.length,
      keywords: 0,
      keyword_monthly_volumes: 0,
      serp_features: 0,
      keyword_demand_signals: 0,
    };
    {
      const rows = await selectIn<any>(
        sb,
        "keywords",
        "id, device, search_intent, avg_monthly_volume, base_rank, ranking_url, tag_1, tag_2, tag_3, tag_4, tag_5",
        "id",
        keywordIds,
      );
      rowsFetched.keywords = rows.length;
      for (const r of rows) {
        kwMeta.set(String(r.id), {
          id: String(r.id),
          device: r.device,
          search_intent: r.search_intent,
          avg_monthly_volume: r.avg_monthly_volume,
          base_rank: r.base_rank,
          ranking_url: r.ranking_url,
          tags: [r.tag_1, r.tag_2, r.tag_3, r.tag_4, r.tag_5],
        });
      }
    }

    // Fetch last 12 months of monthly volumes per keyword
    const monthlyByKw = new Map<string, MonthlyVolumeRow[]>();
    {
      const rows = await selectIn<{ keyword_id: string; month: string; volume: number }>(
        sb,
        "keyword_monthly_volumes",
        "keyword_id, month, volume",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.keyword_monthly_volumes = rows.length;
      for (const r of rows) {
        const key = String(r.keyword_id);
        const arr = monthlyByKw.get(key) ?? [];
        arr.push({ month: String(r.month), volume: Number(r.volume) });
        monthlyByKw.set(key, arr);
      }
    }

    // Prompt 2.4 — trend signals per keyword. Optional inputs to revenue-v2;
    // absent/low-confidence entries collapse to factor=1 (zero-behaviour).
    const trendByKw = new Map<string, { trend_pct: number | null; trend_confidence: "low" | "medium" | "high" | null }>();
    {
      const rows = await selectIn<{ keyword_id: string; trend_pct: number | null; trend_confidence: string | null }>(
        sb,
        "keyword_demand_signals",
        "keyword_id, trend_pct, trend_confidence",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.keyword_demand_signals = rows.length;
      for (const r of rows) {
        const conf = r.trend_confidence;
        trendByKw.set(String(r.keyword_id), {
          trend_pct: r.trend_pct == null ? null : Number(r.trend_pct),
          trend_confidence:
            conf === "low" || conf === "medium" || conf === "high" ? conf : null,
        });
      }
    }

    // Load active SERP CTR adjustments once (small, project-agnostic).
    const { data: adjRows, error: adjErr } = await sb
      .from("serp_feature_ctr_adjustments")
      .select("feature_type, device, intent, multiplier, confidence, is_active")
      .eq("is_active", true);
    if (adjErr) throw adjErr;
    const adjustments = (adjRows ?? []) as SerpAdjustmentRow[];

    // Batch-load serp_features per keyword chunk.
    // Truncation guard: this table accumulates rows per ingest (~23 rows/kw on
    // TVs Ongoing, max 82). 100-kw chunks routinely exceed the 1,000-row
    // PostgREST cap, so paginate each chunk. Consumer (resolveSerpVisibilityV2)
    // dedupes by result_type; we also record a distinct-pair count for
    // observability.
    const featuresByKw = new Map<string, SerpFeatureRow[]>();
    let serpFeaturesDistinct = 0;
    {
      const rows = await selectIn<SerpFeatureRow>(
        sb,
        "serp_features",
        "keyword_id, result_type, serp_feature_count, serp_feature_owned, snippet_opportunity",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.serp_features = rows.length;
      const seenPairs = new Set<string>();
      for (const r of rows) {
        const kk = String(r.keyword_id);
        const rt = (r.result_type ?? "").toString().toLowerCase().trim();
        if (rt) seenPairs.add(`${kk}::${rt}`);
        const arr = featuresByKw.get(kk) ?? [];
        arr.push(r);
        featuresByKw.set(kk, arr);
      }
      serpFeaturesDistinct = seenPairs.size;
    }
    (rowsFetched as any).serp_features_distinct = serpFeaturesDistinct;

    // Process and update
    let scenariosUpdated = 0;
    let keywordsCovered = 0;
    const updatesBuffer: Array<Record<string, unknown>> = [];

    // Per-scenario running totals for calc_run_registry.summary_json.totals.
    // Aggregated from computeRevenueV2 outputs; no separate DB read at close.
    const emptyBucket = () => ({
      current_revenue_annual: 0,
      tp_absolute_revenue_annual: 0,
      tp_incremental_revenue_annual: 0,
      expected_incremental_revenue_annual: 0,
      keywords_with_tp: 0,
      tp_abs_without_incremental_count: 0,
      tp_abs_without_incremental_sum: 0,
    });

    const totalsAcc: Record<string, ReturnType<typeof emptyBucket>> = {
      conservative: emptyBucket(),
      realistic: emptyBucket(),
      stretch: emptyBucket(),
    };


    const flush = async () => {
      if (updatesBuffer.length === 0) return;
      const batch = updatesBuffer.splice(0, updatesBuffer.length);
      // UPDATE per row by primary key. We must not upsert on (id) — that would
      // treat the payload as an INSERT and violate NOT NULL on project_id /
      // keyword_id / scenario / calc_run_id (all of which already live on the
      // target row and must not be rewritten from here).
      const results = await Promise.all(
        batch.map(async (row) => {
          const { id, ...fields } = row as { id: string } & Record<string, unknown>;
          const { error } = await sb
            .from("keyword_forecast_scenarios")
            .update(fields)
            .eq("id", id);
          return { id, error };
        }),
      );
      for (const r of results) {
        if (r.error) {
          dbErrors.push({ code: "update_failed", message: r.error.message, id: r.id });
        } else {
          scenariosUpdated += 1;
        }
      }
    };


    for (const kid of keywordIds) {
      const kw = kwMeta.get(kid);
      const scenarios = byKw.get(kid) ?? [];
      if (!kw) {
        bump(warnings, "missing_keyword_row", kid);
        continue;
      }

      const monthly = monthlyByKw.get(kid) ?? [];
      const va = annualVolumeFromInputs(monthly, kw.avg_monthly_volume);
      if (va.source === "none") bump(warnings, "keyword_monthly_volumes_absent", kid);
      else if (va.source === "avg") bump(warnings, "keyword_monthly_volumes_partial", kid);

      // Resolve CVR/AOV once per keyword
      const conv = resolveConversionOverride(
        {
          keyword_id: kid,
          ranking_url: kw.ranking_url,
          search_intent: kw.search_intent,
          tags: kw.tags,
        },
        overrideIdx,
        { cvr: projectCvrDecimal, aov: projectAov },
      );
      if (conv.cvr.value == null) bump(warnings, "missing_cvr", kid);
      if (conv.aov.value == null) bump(warnings, "missing_aov", kid);
      if (conv.cvr.value != null && conv.cvr.value > 0.2) bump(warnings, "override_cvr_high", kid);
      if (conv.aov.value != null && conv.aov.value === 0) bump(warnings, "override_aov_zero", kid);

      const ctrNowRes = ctrResolver.resolve({
        device: kw.device,
        intent: kw.search_intent,
        position: kw.base_rank,
      });
      if (ctrNowRes.tier === "none" && kw.base_rank != null) bump(warnings, "missing_ctr_now", kid);

      // SERP features act through two SEPARATE mechanisms by design: serpPenalty
      // inside HAR's pBeat suppresses rank ATTAINMENT (feature-heavy SERPs are
      // more entrenched); this SVM suppresses CLICK YIELD at a given rank. There
      // is no arithmetic double-count within a single term, but the combined
      // suppression on feature-heavy keywords is intentionally strong and is
      // scheduled for review against calibration data at Gate B (Prompt 2.5).
      // Do not remove either mechanism without that evidence.
      const svmRes = resolveSerpVisibilityV2({
        projectId,
        keywordId: kid,
        device: kw.device,
        intent: kw.search_intent,
        features: featuresByKw.get(kid) ?? [],
        adjustments,
      });
      if (svmRes.featureCount === 0) bump(warnings, "missing_svm", kid);
      else if (svmRes.unmatchedFeatureTypes.length > 0) {
        bump(
          warnings,
          "svm_unmatched_features",
          `${kid}: ${svmRes.unmatchedFeatureTypes.join(",")}`,
        );
      }

      let scenariosForKw = 0;
      for (const s of scenarios) {
        // Per-scenario dedupe set — ensures each (scenario, code) pair is
        // counted at most once even when index.ts and computeRevenueV2 both
        // want to emit the same code.
        const seen = new Set<string>();

        const ctrTpRes = ctrResolver.resolve({
          device: kw.device,
          intent: kw.search_intent,
          position: s.har_position,
        });
        if (ctrTpRes.tier === "none") bumpOnce(warnings, seen, "missing_ctr_tp", kid);
        if (s.har_confidence == null) bumpOnce(warnings, seen, "missing_har_confidence", kid);
        if (s.rank_attainment_probability == null) bumpOnce(warnings, seen, "missing_rank_prob", kid);

        const trendSig = trendByKw.get(kid) ?? null;
        const result = computeRevenueV2({
          scenario: s.scenario as any,
          volume_annual: va.volume_annual,
          ctr_now: ctrNowRes.tier === "none" ? null : ctrNowRes.ctr,
          ctr_tp: ctrTpRes.tier === "none" ? null : ctrTpRes.ctr,
          svm: svmRes.multiplier,
          cvr: conv.cvr.value,
          aov: conv.aov.value,
          pos_now: kw.base_rank,
          pos_tp: s.har_position,
          rank_attainment_probability: s.rank_attainment_probability,
          har_confidence: s.har_confidence,
          monthly_volumes: monthly,
          trend_pct: trendSig?.trend_pct ?? null,
          trend_confidence: trendSig?.trend_confidence ?? null,
        });

        for (const w of result.warnings) bumpOnce(warnings, seen, w, kid);

        // Accumulate per-scenario totals for summary_json.totals.
        const bucket = totalsAcc[s.scenario as string];
        if (bucket) {
          const tpAbs = Number(result.tp_absolute_revenue_annual) || 0;
          bucket.current_revenue_annual += Number(result.current_revenue_annual) || 0;
          bucket.tp_absolute_revenue_annual += tpAbs;
          bucket.tp_incremental_revenue_annual += Number(result.tp_incremental_revenue_annual) || 0;
          bucket.expected_incremental_revenue_annual += Number(result.expected_incremental_revenue_annual) || 0;
          if (tpAbs > 0) bucket.keywords_with_tp += 1;
          // Identity honesty: rows with tp_abs present but tp_incremental
          // absent (typically not_ranking + missing_ctr_now cohort) contribute
          // to Σtp_abs − Σtp_inc without any offset from current_revenue.
          // Surfacing this makes the identity check verifiable from summary_json alone:
          //   Σtp_abs − Σtp_inc − tp_abs_without_incremental.sum ≤ current_revenue
          if (
            result.tp_absolute_revenue_annual != null &&
            result.tp_incremental_revenue_annual == null
          ) {
            bucket.tp_abs_without_incremental_count += 1;
            bucket.tp_abs_without_incremental_sum += tpAbs;
          }
        }




        const merged = {
          ...(s.explanation_json ?? {}),
          revenue_v2: {
            model_version: REVENUE_V2_MODEL_VERSION,
            calc_run_id: calcRunId,
            cvr: {
              value: conv.cvr.value,
              source: conv.cvr.source,
              override_id: conv.cvr.override_id,
              confidence: conv.cvr.confidence,
            },
            aov: {
              value: conv.aov.value,
              source: conv.aov.source,
              override_id: conv.aov.override_id,
              confidence: conv.aov.confidence,
            },
            ctr: {
              now: result.ctr_now,
              tp: result.ctr_tp,
              resolver_tier_now: ctrNowRes.tier,
              resolver_tier_tp: ctrTpRes.tier,
            },
            svm: {
              value: svmRes.multiplier,
              multiplier: result.svm_used,
              matched: svmRes.matched.map((m) => ({
                feature: m.featureType,
                multiplier: m.multiplier,
                tier: m.tier,
              })),
              confidence: svmRes.confidence,
              dataQualityWarning: svmRes.dataQualityWarning,
              source: svmRes.featureCount === 0 ? "no_features_default_1" : "serp_features_v2",
            },
            volume: {
              // legacy alias — kept so existing admin cards / verification
              // queries that read `annual` don't break at Gate B pre-work.
              annual: va.volume_annual,
              base_annual: va.volume_annual,
              source: va.source,
              months_used: va.months_used,
              trend_pct: trendSig?.trend_pct ?? null,
              trend_confidence: trendSig?.trend_confidence ?? null,
              factor_applied: result.factor_applied,
              forward_annual: result.volume_forward,
            },
            confidence_weighting: {
              p_att: result.p_att_used,
              har_conf: result.har_conf_used,
              band_method: result.band_method,
            },
            warnings: result.warnings,
          },
        };

        updatesBuffer.push({
          id: s.id,
          current_revenue_annual: result.current_revenue_annual,
          tp_absolute_revenue_annual: result.tp_absolute_revenue_annual,
          tp_incremental_revenue_annual: result.tp_incremental_revenue_annual,
          expected_incremental_revenue_annual: result.expected_incremental_revenue_annual,
          expected_incremental_low_annual: result.expected_incremental_low_annual,
          expected_incremental_high_annual: result.expected_incremental_high_annual,
          monthly_revenue_json: result.monthly_revenue_json,
          explanation_json: merged,
          calculated_at: new Date().toISOString(),
        });
        scenariosForKw += 1;
        if (updatesBuffer.length >= UPDATE_CHUNK) await flush();
      }
      if (scenariosForKw > 0) keywordsCovered += 1;
    }
    await flush();

    const totals = {
      by_scenario: Object.fromEntries(
        Object.entries(totalsAcc).map(([k, v]) => [k, {
          current_revenue_annual: Math.round(v.current_revenue_annual),
          tp_absolute_revenue_annual: Math.round(v.tp_absolute_revenue_annual),
          tp_incremental_revenue_annual: Math.round(v.tp_incremental_revenue_annual),
          expected_incremental_revenue_annual: Math.round(v.expected_incremental_revenue_annual),
          keywords_with_tp: v.keywords_with_tp,
          tp_abs_without_incremental: {
            count: v.tp_abs_without_incremental_count,
            sum_annual: Math.round(v.tp_abs_without_incremental_sum),
          },
        }]),
      ),
    };


    const summary = {
      model_version: REVENUE_V2_MODEL_VERSION,
      har_calc_run_id: harCalcRunId,
      har_model_version: harModelVersion,

      scenarios_updated: scenariosUpdated,
      keywords_covered: keywordsCovered,
      keywords_total: keywordIds.length,
      warnings_count: Array.from(warnings.values()).reduce((s, v) => s + v.count, 0),
      errors_count: dbErrors.length,
      project_cvr_decimal: projectCvrDecimal,
      project_aov: projectAov,
      totals,
      rows_fetched: rowsFetched,
      note:
        "Expected incremental is confidence-weighted and typically lower than theoretical TP incremental.",
    };


    let status: CalcRunTerminalStatus = CALC_RUN_SUCCESS_STATUS;
    if (dbErrors.length && scenariosUpdated === 0) status = CALC_RUN_FAILED_STATUS;
    else if (dbErrors.length || warnings.size > 0) status = CALC_RUN_PARTIAL_STATUS;

    await closeRun(status, summary);
    console.log(
      "[compute-forecasts-v2] project=%s kw=%d scenarios_updated=%d warnings=%d",
      projectId, keywordIds.length, scenariosUpdated, summary.warnings_count,
    );
    return json(200, { calc_run_id: calcRunId, summary });
  } catch (e) {
    const se = serializeErr(e);
    console.error("[compute-forecasts-v2] unhandled", JSON.stringify(se), e);
    dbErrors.push({ code: se.code ?? "unhandled", message: se.message, details: se.details, hint: se.hint });
    await closeRun(CALC_RUN_FAILED_STATUS, {
      model_version: REVENUE_V2_MODEL_VERSION,
      har_calc_run_id: harCalcRunId,
      har_model_version: harModelVersion,
      error: se,
    });
    return err(500, se.code ?? "unhandled", se.message, { calc_run_id: calcRunId });
  }
});
