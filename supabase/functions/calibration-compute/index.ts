// calibration-compute
// Prompt 2.5 — Calibration snapshot.
//
// Admin-only, manual invocation from /admin/calculations.
// Reads stored data only. Matches non-brand keywords between a GSC upload and
// the project's keyword table, models 30-day-equivalent clicks with the same
// resolvers Revenue v2.1 uses (CTR curves + SVM), computes impression-weighted
// modelled/actual ratios, and writes one row to calibration_snapshots.
//
// Contract:
//   POST /functions/v1/calibration-compute
//   Body: { project_id: uuid, gsc_upload_id?: uuid }
//   If gsc_upload_id is omitted, the most recent upload for the project wins.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildCtrResolverV2,
  type CtrCurveRow,
  type CtrCurveMetaRow,
} from "../_shared/ctr-resolver-v2.ts";
import {
  resolveSerpVisibilityV2,
  type SerpAdjustmentRow,
  type SerpFeatureRow,
} from "../_shared/serp-visibility-v2.ts";
import {
  annualVolumeFromInputs,
  trendFactor,
  type MonthlyVolumeRow,
} from "../_shared/revenue-v2.ts";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";
import {
  aggregateGscByNormalised,
  CALIBRATION_MODEL_VERSION,
  computeCalibration,
  normaliseActualTo30d,
  type CalibrationPair,
  type GscAggRow,
  type IntentBucket,
  INTENT_BUCKETS,
} from "../_shared/calibration.ts";
import { normaliseKeyword } from "../_shared/keyword-cluster.ts";


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
const err = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json(status, { code, error, ...extra });

function serializeErr(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  if (e && typeof e === "object") return e as Record<string, unknown>;
  return { message: String(e) };
}

function normaliseKw(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function toIntent(raw: unknown): IntentBucket {
  const v = String(raw ?? "").toLowerCase().trim();
  return (INTENT_BUCKETS as readonly string[]).includes(v) ? (v as IntentBucket) : "unknown";
}

console.log("[calibration-compute] boot v5 cluster-level-actuals + rank-band-21-30");

// Consistency guard for defect-1 (docs: clustering-defect-fixes 2026-07-21).
// The by_intent / by_rank_band sub-totals persisted on a snapshot MUST derive
// from the same post-exclusion `pairs[]` array that produced totals.* — any
// silent divergence (e.g. a stale bucket result reused across runs) would leak
// baseline numbers into a cluster-aware snapshot. We assert equality on
// insert; band matched is `≤` overall because rank bands cap at 11-20.
function assertBucketConsistency(result: {
  sum_modelled_monthly: number;
  sum_actual_monthly: number;
  matched: number;
  by_intent: Record<string, { sum_modelled_monthly: number; sum_actual_monthly: number; matched: number }>;
  by_rank_band: Record<string, { sum_modelled_monthly: number; sum_actual_monthly: number; matched: number }>;
}): void {
  const eps = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);
  let bim = 0, bia = 0, bimatched = 0;
  for (const k of Object.keys(result.by_intent)) {
    const b = result.by_intent[k];
    bim += b.sum_modelled_monthly; bia += b.sum_actual_monthly; bimatched += b.matched;
  }
  let bbm = 0, bba = 0, bbmatched = 0;
  for (const k of Object.keys(result.by_rank_band)) {
    const b = result.by_rank_band[k];
    bbm += b.sum_modelled_monthly; bba += b.sum_actual_monthly; bbmatched += b.matched;
  }
  if (!eps(bim, result.sum_modelled_monthly) || !eps(bia, result.sum_actual_monthly) || bimatched !== result.matched) {
    throw new Error(
      `by_intent divergence: Σm=${bim} Σa=${bia} matched=${bimatched} vs totals m=${result.sum_modelled_monthly} a=${result.sum_actual_monthly} matched=${result.matched}`,
    );
  }
  if (bbm > result.sum_modelled_monthly + 1e-6 || bba > result.sum_actual_monthly + 1e-6 || bbmatched > result.matched) {
    throw new Error(
      `by_rank_band exceeds overall: Σm=${bbm} Σa=${bba} matched=${bbmatched} vs totals m=${result.sum_modelled_monthly} a=${result.sum_actual_monthly} matched=${result.matched}`,
    );
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return err(405, "method_not_allowed", "POST only.");

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err(401, "unauthorized", "Missing Authorization header.");

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );

  let payload: { project_id?: string; gsc_upload_id?: string } = {};
  try { payload = await req.json(); } catch { /* empty body ok */ }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }

  // Auth + admin
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;
  const { data: roles, error: roleErr } = await sb
    .from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // Project visibility
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, archived_at, conversion_rate, aov")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot run calibration for an archived project.");
  }

  try {
    // Pick the GSC upload
    let upload: { id: string; date_range_start: string | null; date_range_end: string | null } | null;
    if (payload?.gsc_upload_id) {
      const { data, error } = await sb
        .from("gsc_uploads")
        .select("id, date_range_start, date_range_end, project_id")
        .eq("id", payload.gsc_upload_id)
        .maybeSingle();
      if (error) throw error;
      if (!data || (data as any).project_id !== projectId) {
        return err(404, "gsc_upload_not_found", "GSC upload not found on this project.");
      }
      upload = data as any;
    } else {
      const { data, error } = await sb
        .from("gsc_uploads")
        .select("id, date_range_start, date_range_end")
        .eq("project_id", projectId)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      upload = data as any;
    }
    if (!upload) return err(404, "no_gsc_upload", "No GSC upload available for this project.");

    // Window in days (default 30 when the upload has no date range).
    let windowDays = 30;
    if (upload.date_range_start && upload.date_range_end) {
      const start = new Date(upload.date_range_start).getTime();
      const end = new Date(upload.date_range_end).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        windowDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
      }
    }

    // Load GSC rows (non-branded only) — paginated across PostgREST's 1,000-row
    // cap so the full upload is consumed (see incident-har-v2 remediation).
    const gscAll = await fetchAllRows<{
      keyword: string; clicks: number | null; impressions: number | null;
      position: number | null; search_intent: string | null;
      device: string | null; is_branded: boolean | null;
    }>(
      sb, "gsc_upload_keywords",
      "keyword, clicks, impressions, position, search_intent, device, is_branded",
      (q) => q.eq("upload_id", upload!.id),
    );
    const gscNonBrand = gscAll.filter((r) => r.is_branded !== true);

    // Sum clicks/impressions across per-device rows sharing the normalised query.
    const gscAggByNorm = aggregateGscByNormalised(gscNonBrand, normaliseKw);

    // Cluster-form aggregation: sum clicks across every GSC query whose
    // form-normalised key (see _shared/keyword-cluster.ts normaliseKeyword)
    // matches the canonical's cluster_key. Distinct from gscAggByNorm because
    // that map uses space/case normalisation only, while cluster keys use the
    // stronger form-based normaliser (size tokens, tv/inch synonyms, sort).
    const gscClicksByClusterKey = new Map<string, number>();
    const gscQueryCountByClusterKey = new Map<string, number>();
    for (const [normQuery, agg] of gscAggByNorm.entries()) {
      const clusterKey = normaliseKeyword(normQuery);
      if (!clusterKey) continue;
      const c = Number(agg.clicks ?? 0);
      if (!Number.isFinite(c)) continue;
      gscClicksByClusterKey.set(
        clusterKey,
        (gscClicksByClusterKey.get(clusterKey) ?? 0) + c,
      );
      gscQueryCountByClusterKey.set(
        clusterKey,
        (gscQueryCountByClusterKey.get(clusterKey) ?? 0) + 1,
      );
    }

    // Load kept, non-brand keywords for this project. Match on normalised
    // keyword text — the categorised curated set is the join universe.
    const kwAll = await fetchAllRows<{
      id: string; keyword: string; device: string | null;
      search_intent: string | null; avg_monthly_volume: number | null;
      base_rank: number | null; is_branded: boolean | null;
      cluster_key: string | null; cluster_canonical_keyword_id: string | null;
      cluster_member_count: number | null;
      cluster_volume_annual: number | null;
      cluster_base_rank: number | null;
      cluster_base_rank_keyword_id: string | null;
      cluster_ranking_url: string | null;
      cluster_url_conflict: boolean | null;
    }>(
      sb, "keywords",
      "id, keyword, device, search_intent, avg_monthly_volume, base_rank, is_branded, detox_status, cluster_key, cluster_canonical_keyword_id, cluster_member_count, cluster_volume_annual, cluster_base_rank, cluster_base_rank_keyword_id, cluster_ranking_url, cluster_url_conflict",
      (q) => q.eq("project_id", projectId).eq("detox_status", "keep"),
    );
    const kwByNorm = new Map<string, typeof kwAll[number]>();
    for (const k of kwAll) {
      if (k.is_branded === true) continue;
      const n = normaliseKw(k.keyword);
      if (n && !kwByNorm.has(n)) kwByNorm.set(n, k);
    }

    // Match curated keyword → aggregated GSC row.
    const matched: Array<{
      kw: typeof kwAll[number];
      gsc: GscAggRow;
    }> = [];
    for (const [n, kw] of kwByNorm.entries()) {
      const agg = gscAggByNorm.get(n);
      if (agg) matched.push({ kw, gsc: agg });
    }

    // Discovery preview: unmatched GSC queries (aggregated so click totals are
    // honest), sorted by summed clicks desc.
    const unmatchedByClicks: Array<{ keyword: string; clicks: number }> = [];
    for (const [n, agg] of gscAggByNorm.entries()) {
      if (kwByNorm.has(n)) continue;
      unmatchedByClicks.push({ keyword: n, clicks: agg.clicks });
    }
    unmatchedByClicks.sort((a, b) => b.clicks - a.clicks);
    const topUnmatched = unmatchedByClicks.slice(0, 10);


    // Resolvers
    const [{ data: curves }, { data: curveMeta }] = await Promise.all([
      sb.from("ctr_curves")
        .select("id, project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback")
        .or(`project_id.eq.${projectId},is_fallback.eq.true`),
      sb.from("ctr_curve_metadata")
        .select("ctr_curve_id, source, confidence, sample_impressions, sample_clicks, date_range_start, date_range_end"),
    ]);
    const ctrResolver = buildCtrResolverV2({
      curves: (curves ?? []) as CtrCurveRow[],
      metadata: (curveMeta ?? []) as CtrCurveMetaRow[],
    });

    const { data: adjRows, error: adjErr } = await sb
      .from("serp_feature_ctr_adjustments")
      .select("feature_type, device, intent, multiplier, confidence, is_active")
      .eq("is_active", true);
    if (adjErr) throw adjErr;
    const adjustments = (adjRows ?? []) as SerpAdjustmentRow[];

    const matchedIds = matched.map((m) => m.kw.id);

    // SERP features (paginated selectIn)
    const featuresByKw = new Map<string, SerpFeatureRow[]>();
    if (matchedIds.length > 0) {
      const rows = await selectIn<SerpFeatureRow>(
        sb, "serp_features",
        "keyword_id, result_type, serp_feature_count, serp_feature_owned, snippet_opportunity",
        "keyword_id", matchedIds, { paginate: true },
      );
      for (const r of rows) {
        const kk = String(r.keyword_id);
        const arr = featuresByKw.get(kk) ?? [];
        arr.push(r); featuresByKw.set(kk, arr);
      }
    }

    // Monthly volumes + trend for the forward-volume estimate (same inputs
    // Revenue v2.1 uses so calibration is apples-to-apples).
    const monthlyByKw = new Map<string, MonthlyVolumeRow[]>();
    const trendByKw = new Map<string, { pct: number | null; conf: "low" | "medium" | "high" | null }>();
    if (matchedIds.length > 0) {
      const [mvRows, tRows] = await Promise.all([
        selectIn<{ keyword_id: string; month: string; volume: number }>(
          sb, "keyword_monthly_volumes", "keyword_id, month, volume", "keyword_id",
          matchedIds, { paginate: true },
        ),
        selectIn<{ keyword_id: string; trend_pct: number | null; trend_confidence: string | null }>(
          sb, "keyword_demand_signals", "keyword_id, trend_pct, trend_confidence", "keyword_id",
          matchedIds, { paginate: true },
        ),
      ]);
      for (const r of mvRows) {
        const k = String(r.keyword_id);
        const arr = monthlyByKw.get(k) ?? [];
        arr.push({ month: String(r.month), volume: Number(r.volume) });
        monthlyByKw.set(k, arr);
      }
      for (const r of tRows) {
        const c = r.trend_confidence;
        trendByKw.set(String(r.keyword_id), {
          pct: r.trend_pct == null ? null : Number(r.trend_pct),
          conf: c === "low" || c === "medium" || c === "high" ? c : null,
        });
      }
    }

    // Build calibration pairs — split scored (rank NOT NULL, fed into ratios)
    // from model_blind (rank NULL, coverage-only diagnostic). Non-canonical
    // cluster members are excluded from ratio aggregates (double-counting
    // guard) and reported separately in summary_json.cluster_excluded.
    const pairs: CalibrationPair[] = [];
    // Per-pair diagnostic ledger — persisted to summary_json for audit.
    // These are what the calibrator itself computed, not any reconstruction.
    const pairsScored: Array<Record<string, unknown>> = [];
    const pairsModelBlind: Array<Record<string, unknown>> = [];
    const pairsClusterExcluded: Array<Record<string, unknown>> = [];
    const PAIR_CAP = 500;
    const modelBlindAgg = {
      pairs: 0,
      actual_clicks_30d_sum: 0,
      positions: [] as number[],
    };
    const clusterExcludedAgg = {
      pairs: 0,
      keywords: 0,
      sum_modelled_monthly_excluded: 0,
    };
    // Cluster-vs-exact click uplift summary (canonical scored pairs only).
    const clusterUplift = {
      clusters_with_uplift: 0,
      sum_uplift_clicks: 0,
    };
    for (const { kw, gsc } of matched) {
      const rank = kw.base_rank;
      const device = kw.device ?? null;
      const intent = toIntent(kw.search_intent);
      const impressions = Number(gsc.impressions ?? 0);
      const exactClicks = Number(gsc.clicks ?? 0);
      const normKw = normaliseKw(kw.keyword);
      const clusterKey = kw.cluster_key ?? null;
      const clusterMemberCount = kw.cluster_member_count ?? null;
      const isCanonical = clusterKey == null
        || kw.cluster_canonical_keyword_id == null
        || kw.cluster_canonical_keyword_id === kw.id;

      // Cluster-level actual clicks: sum across ALL upload rows whose form-
      // normalised query equals this keyword's cluster_key. For a canonical
      // scored pair we feed this into the ratio (measured demand pool per
      // cluster). Non-canonical or unclustered rows keep exact clicks.
      const cKey = clusterKey ?? normaliseKeyword(kw.keyword ?? "");
      const clusterClicks = cKey
        ? (gscClicksByClusterKey.get(cKey) ?? exactClicks)
        : exactClicks;
      const clusterQueryCount = cKey
        ? (gscQueryCountByClusterKey.get(cKey) ?? 1)
        : 1;
      const rawClicks = isCanonical ? clusterClicks : exactClicks;
      const actual30 = normaliseActualTo30d(rawClicks, windowDays);

      if (rank == null || !Number.isFinite(Number(rank))) {
        // Model-blind coverage row — no prediction possible.
        modelBlindAgg.pairs += 1;
        modelBlindAgg.actual_clicks_30d_sum += actual30;
        if (gsc.position != null && Number.isFinite(gsc.position)) {
          modelBlindAgg.positions.push(Number(gsc.position));
        }
        if (pairsModelBlind.length < PAIR_CAP) {
          pairsModelBlind.push({
            keyword: normKw,
            keyword_raw: kw.keyword,
            keyword_id: kw.id,
            device,
            intent,
            base_rank: null,
            gsc_position: gsc.position ?? null,
            impressions,
            actual_clicks_raw: rawClicks,
            actual_monthly: actual30,
            modelled_monthly: null,
            per_pair_ratio: null,
            reason: "base_rank_null",
            cluster_key: clusterKey,
            is_canonical: isCanonical,
            cluster_member_count: clusterMemberCount,
          });
        }
        continue;
      }

      const va = annualVolumeFromInputs(monthlyByKw.get(kw.id) ?? [], kw.avg_monthly_volume);
      const t = trendByKw.get(kw.id);
      const trendF = trendFactor(t?.pct ?? null, t?.conf ?? null);
      const factor = trendF.factor;

      // Scoring inputs use canonical-own volume and base_rank. Cluster-level
      // MAX volume / MIN rank were tested in snapshot 33997b73 and regressed
      // calibration overall ratio 1.0253 → 2.3728, green share 49.5% → 37.7%.
      // Canonical-own inputs are the empirically calibrated choice; cluster_*
      // fields (cluster_volume_annual, cluster_base_rank, cluster_base_rank_keyword_id,
      // cluster_url_conflict) remain informational in the pairs_scored ledger.
      const canonicalOwnVolume = va.volume_annual;
      const canonicalOwnBaseRank = Number(rank);

      const volumeAnnualUsed = canonicalOwnVolume == null ? null : Number(canonicalOwnVolume);
      const rankUsed = canonicalOwnBaseRank;


      const volFwd = volumeAnnualUsed == null ? null : volumeAnnualUsed * factor;

      let ctrNow: number | null = null;
      const res = ctrResolver.resolve({ device, intent: kw.search_intent, position: rankUsed });
      // Resolver contract (see _shared/ctr-resolver-v2.ts CtrResolution):
      //   res.ctr           — decimal fraction (already imps→clicks ratio)
      //   res.ctrPercentage — percentage points
      // Revenue v2.1 and this calibrator both want a decimal fraction; apply
      // exactly one conversion from ctrPercentage for explicit symmetry with
      // the resolver contract. Consuming res.ctr AND dividing by 100 is the
      // 100× double-division defect (see calibrator-per-pair-dump 2026-07-20 §3).
      ctrNow = res.ctrPercentage != null ? Number(res.ctrPercentage) / 100 : null;

      const svm = resolveSerpVisibilityV2({
        projectId, keywordId: kw.id, device, intent: kw.search_intent,
        features: featuresByKw.get(kw.id) ?? [], adjustments,
      }).multiplier ?? 1;

      let modelledMonthly = 0;
      if (volFwd != null && ctrNow != null) {
        modelledMonthly = (Number(volFwd) * Number(ctrNow) * Number(svm)) / 12;
      }

      if (!isCanonical) {
        // Non-canonical cluster member — excluded from ratio aggregates to
        // avoid double-counting the same demand pool. Modelled monthly is
        // still summed for the exclusion diagnostic.
        clusterExcludedAgg.pairs += 1;
        clusterExcludedAgg.keywords += 1;
        clusterExcludedAgg.sum_modelled_monthly_excluded += modelledMonthly;
        if (pairsClusterExcluded.length < PAIR_CAP) {
          pairsClusterExcluded.push({
            keyword: normKw,
            keyword_raw: kw.keyword,
            keyword_id: kw.id,
            device,
            intent,
            base_rank: Number(rank),
            impressions,
            actual_clicks_raw: rawClicks,
            actual_monthly: actual30,
            modelled_monthly: modelledMonthly,
            reason: "non_canonical_cluster_member",
            cluster_key: clusterKey,
            is_canonical: false,
            cluster_member_count: clusterMemberCount,
            canonical_keyword_id: kw.cluster_canonical_keyword_id,
          });
        }
        continue;
      }

      // Cluster-vs-exact uplift bookkeeping (canonical scored pairs only).
      if (clusterClicks > exactClicks) {
        clusterUplift.clusters_with_uplift += 1;
        clusterUplift.sum_uplift_clicks += (clusterClicks - exactClicks);
      }

      pairs.push({
        modelled_monthly_clicks: modelledMonthly,
        actual_clicks_raw: rawClicks,
        window_days: windowDays,
        impressions,
        intent,
        rank: rankUsed,
      });

      if (pairsScored.length < PAIR_CAP) {
        pairsScored.push({
          keyword: normKw,
          keyword_raw: kw.keyword,
          keyword_id: kw.id,
          device,
          intent,
          base_rank: Number(rank),
          annual_volume: va.volume_annual,
          annual_volume_source: va.source,
          months_used: va.months_used,
          trend_pct: t?.pct ?? null,
          trend_confidence: t?.conf ?? null,
          trend_factor: factor,
          trend_applied: trendF.applied,
          volume_forward_used: volFwd,
          ctr_used: ctrNow,
          ctr_resolver_tier: (res as { tier?: string }).tier ?? null,
          ctr_curve_key: `${device ?? "null"}|${kw.search_intent ?? "null"}|${rankUsed}`,
          svm_used: svm,
          impressions,
          actual_clicks_raw: rawClicks,
          actual_clicks_cluster: clusterClicks,
          actual_clicks_exact: exactClicks,
          cluster_query_count: clusterQueryCount,
          actual_monthly: actual30,
          modelled_monthly: modelledMonthly,
          per_pair_ratio: actual30 > 0 ? modelledMonthly / actual30 : null,
          cluster_key: clusterKey,
          is_canonical: true,
          cluster_member_count: clusterMemberCount,
          cluster_volume_annual: kw.cluster_volume_annual ?? null,
          cluster_base_rank: kw.cluster_base_rank ?? null,
          cluster_base_rank_keyword_id: kw.cluster_base_rank_keyword_id ?? null,
          canonical_own_volume: canonicalOwnVolume,
          canonical_own_base_rank: canonicalOwnBaseRank,
          cluster_url_conflict: kw.cluster_url_conflict ?? null,
        });
      }
    }

    const result = computeCalibration(pairs);

    // Median helper for the model-blind position distribution.
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const modelBlind = {
      pairs: modelBlindAgg.pairs,
      actual_clicks_30d_sum: Math.round(modelBlindAgg.actual_clicks_30d_sum * 100) / 100,
      avg_gsc_position_median: median(modelBlindAgg.positions),
    };

    // Revenue sanity block — informational only. Labels the CVR/AOV source
    // (assumed vs client-supplied) explicitly.
    const cvrDecimal =
      (proj as any).conversion_rate != null && Number.isFinite(Number((proj as any).conversion_rate))
        ? Number((proj as any).conversion_rate) / 100 : null;
    const aov = (proj as any).aov != null && Number.isFinite(Number((proj as any).aov))
      ? Number((proj as any).aov) : null;
    let revenueSanity: Record<string, unknown> | null = null;
    if (cvrDecimal != null && aov != null && result.matched > 0) {
      const modelledRev = result.total_modelled_monthly_clicks * cvrDecimal * aov;
      const actualRev = result.total_actual_30d_clicks * cvrDecimal * aov;
      revenueSanity = {
        modelled_current_monthly_revenue: Math.round(modelledRev * 100) / 100,
        actual_monthly_revenue: Math.round(actualRev * 100) / 100,
        ratio: actualRev > 0 ? Math.round((modelledRev / actualRev) * 1000) / 1000 : null,
        cvr_source: "project_default",
        aov_source: "project_default",
        label: "vs assumed conversion values",
      };
    }

    const rowsFetched = {
      gsc_upload_keywords: gscAll.length,
      keywords: kwAll.length,
      serp_features: Array.from(featuresByKw.values()).reduce((s, a) => s + a.length, 0),
      keyword_monthly_volumes: Array.from(monthlyByKw.values()).reduce((s, a) => s + a.length, 0),
      keyword_demand_signals: trendByKw.size,
    };

    const overallRatioStr = result.overall_ratio == null ? "null" : result.overall_ratio.toFixed(6);
    const notes = [
      `model_version=${CALIBRATION_MODEL_VERSION}`,
      `gsc_rows=${gscAll.length}`,
      `gsc_non_brand=${gscNonBrand.length}`,
      `gsc_norm_queries=${gscAggByNorm.size}`,
      `kw_universe=${kwByNorm.size}`,
      `scored=${pairs.length}`,
      `model_blind=${modelBlind.pairs}`,
      `overall=Σm/Σa=${result.sum_modelled_monthly.toFixed(2)}/${result.sum_actual_monthly.toFixed(2)}=${overallRatioStr}`,
    ].join(" · ");

    const totals = {
      overall_ratio: result.overall_ratio,
      median_per_pair_ratio: result.median_per_pair_ratio,
      sum_modelled_monthly: result.sum_modelled_monthly,
      sum_actual_monthly: result.sum_actual_monthly,
      impressions_context: result.impressions_context,
      matched: result.matched,
      // Legacy names retained for continuity with earlier snapshots.
      modelled_monthly_clicks: result.total_modelled_monthly_clicks,
      actual_30d_clicks: result.total_actual_30d_clicks,
    };

    // Guard: buckets must derive from the same post-exclusion pairs[] as
    // totals. Throws before insert if not.
    assertBucketConsistency(result);

    const { data: snapIns, error: snapErr } = await sb
      .from("calibration_snapshots")
      .insert({
        project_id: projectId,
        gsc_upload_id: upload.id,
        window_days: windowDays,
        overall_ratio: result.overall_ratio,
        by_intent: {
          ...result.by_intent,
          _meta: { model_version: CALIBRATION_MODEL_VERSION },
        },
        by_rank_band: {
          ...result.by_rank_band,
          top_unmatched: topUnmatched,
          revenue_sanity: revenueSanity,
          totals,
          model_blind: modelBlind,
          rows_fetched: rowsFetched,
          pairs_scored: pairsScored,
          pairs_scored_truncated: Math.max(0, pairs.length - pairsScored.length),
          pairs_model_blind: pairsModelBlind,
          pairs_model_blind_truncated: Math.max(0, modelBlindAgg.pairs - pairsModelBlind.length),
          cluster_excluded: {
            pairs: clusterExcludedAgg.pairs,
            keywords: clusterExcludedAgg.keywords,
            sum_modelled_monthly_excluded:
              Math.round(clusterExcludedAgg.sum_modelled_monthly_excluded * 100) / 100,
          },
          pairs_cluster_excluded: pairsClusterExcluded,
          pairs_cluster_excluded_truncated: Math.max(
            0, clusterExcludedAgg.pairs - pairsClusterExcluded.length,
          ),
          cluster_actuals_uplift: {
            clusters_with_uplift: clusterUplift.clusters_with_uplift,
            sum_uplift_clicks:
              Math.round(clusterUplift.sum_uplift_clicks * 100) / 100,
          },
        },
        keywords_matched: result.matched,
        keywords_unmatched: gscAggByNorm.size - matched.length,
        notes,
      })
      .select("id, created_at")
      .single();
    if (snapErr) throw snapErr;


    return json(200, {
      snapshot_id: (snapIns as any).id,
      created_at: (snapIns as any).created_at,
      overall_ratio: result.overall_ratio,
      matched: result.matched,
      unmatched: gscAggByNorm.size - matched.length,
      excluded_noise_floor: result.excluded_noise_floor,
      window_days: windowDays,
      gsc_upload_id: upload.id,
    });
  } catch (e) {
    console.error("[calibration-compute] error", serializeErr(e));
    return err(500, "internal_error", (e as Error)?.message ?? "Unhandled error", {
      details: serializeErr(e),
    });
  }
});
