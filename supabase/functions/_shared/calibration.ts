// Pure calibration math for Prompt 2.5.
//
// Given matched (modelled, actual) click pairs plus per-pair window/intent/rank
// context, compute impression-weighted modelled/actual ratios overall and per
// intent / rank band. No I/O — Deno-safe for import from tests and edge fns.

export const CALIBRATION_MODEL_VERSION = "calibration_v1.0.0";

export type IntentBucket =
  | "informational"
  | "navigational"
  | "commercial"
  | "transactional"
  | "unknown";

export const INTENT_BUCKETS: IntentBucket[] = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
  "unknown",
];

export type RankBand = "1-3" | "4-10" | "11-20" | "21-30";
export const RANK_BANDS: RankBand[] = ["1-3", "4-10", "11-20", "21-30"];

/** Noise floor: pairs whose normalised actual < this are excluded from ratios. */
export const NOISE_FLOOR_CLICKS = 5;

export interface CalibrationPair {
  /** Modelled 30-day-equivalent clicks (caller-side: (V×CTR×SVM)/12). */
  modelled_monthly_clicks: number;
  /** Raw click total across `window_days`. */
  actual_clicks_raw: number;
  window_days: number;
  /** Impression total across `window_days`; used as the aggregation weight. */
  impressions: number;
  intent: IntentBucket;
  /**
   * base_rank; drives the band assignment. Caller must exclude pairs whose
   * curated keyword has a null/NaN base_rank (model_blind coverage rows) and
   * report them separately — computeCalibration also defensively skips any
   * pair with a non-finite rank so the two paths cannot diverge.
   */
  rank: number;
}

/**
 * Sum GSC rows across all devices sharing a normalised query. GSC exports one
 * row per (query, device); calibration compares against a curated keyword that
 * is one logical query, so per-device rows must be summed. Impressions-weighted
 * mean position is retained for the model-blind diagnostic.
 */
export interface GscAggRow {
  clicks: number;
  impressions: number;
  /** Impressions-weighted mean of `position` across the aggregated device rows. */
  position: number | null;
  /** First non-null `search_intent` seen across the device rows (informational default). */
  search_intent: string | null;
  /** Number of distinct source rows contributing to this aggregate. */
  device_rows: number;
}

export interface GscInputRow {
  keyword: string;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
  search_intent: string | null;
  device?: string | null;
  is_branded?: boolean | null;
}

export function aggregateGscByNormalised(
  rows: ReadonlyArray<GscInputRow>,
  normalise: (s: unknown) => string = (s) =>
    String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
): Map<string, GscAggRow> {
  const out = new Map<string, GscAggRow>();
  for (const r of rows) {
    const n = normalise(r.keyword);
    if (!n) continue;
    const clicks = Number.isFinite(Number(r.clicks)) ? Number(r.clicks) : 0;
    const imps = Number.isFinite(Number(r.impressions)) ? Number(r.impressions) : 0;
    const pos = r.position == null || !Number.isFinite(Number(r.position))
      ? null : Number(r.position);
    const prev = out.get(n);
    if (!prev) {
      out.set(n, {
        clicks,
        impressions: imps,
        // Seed weighted-position numerator on the aggregate — resolved on read.
        position: pos != null && imps > 0 ? pos : (pos ?? null),
        search_intent: r.search_intent ?? null,
        device_rows: 1,
      });
      continue;
    }
    // Recompute the impressions-weighted mean position incrementally. We track
    // it as (currentPos, currentImpressions) → weighted-mean, using the pre-add
    // totals. Rows without impressions still contribute unweighted if nothing
    // else has landed yet.
    const prevImps = prev.impressions;
    let newPos: number | null = prev.position;
    if (pos != null) {
      if (imps > 0 && prevImps > 0 && prev.position != null) {
        newPos = ((prev.position * prevImps) + (pos * imps)) / (prevImps + imps);
      } else if (prev.position == null) {
        newPos = pos;
      } else if (imps > 0 && prevImps === 0) {
        newPos = pos;
      }
      // else: keep prev.position (both zero-imp; first-write wins)
    }
    prev.clicks += clicks;
    prev.impressions += imps;
    prev.position = newPos;
    if (prev.search_intent == null && r.search_intent != null) {
      prev.search_intent = r.search_intent;
    }
    prev.device_rows += 1;
  }
  return out;
}


/**
 * Bucket aggregate. `ratio` is the ruled portfolio ratio
 * `Σ modelled_monthly / Σ actual_monthly` over the pairs in this bucket
 * (see operator ruling — impressions do NOT enter this computation).
 * `impressions_context` is reported for context only.
 */
export interface BucketAgg {
  ratio: number | null;
  median_per_pair_ratio: number | null;
  sum_modelled_monthly: number;
  sum_actual_monthly: number;
  impressions_context: number;
  matched: number;
}

export interface CalibrationResult {
  overall_ratio: number | null;
  median_per_pair_ratio: number | null;
  sum_modelled_monthly: number;
  sum_actual_monthly: number;
  impressions_context: number;
  by_intent: Record<IntentBucket, BucketAgg>;
  by_rank_band: Record<RankBand, BucketAgg>;
  matched: number;
  excluded_noise_floor: number;
  /** Legacy field kept for continuity — same value as sum_modelled_monthly. */
  total_modelled_monthly_clicks: number;
  /** Legacy field kept for continuity — same value as sum_actual_monthly. */
  total_actual_30d_clicks: number;
}

export function normaliseActualTo30d(raw: number, windowDays: number): number {
  if (!Number.isFinite(raw) || !Number.isFinite(windowDays) || windowDays <= 0) return 0;
  return (raw * 30) / windowDays;
}

export function rankBand(rank: number): RankBand | null {
  if (!Number.isFinite(rank)) return null;
  if (rank >= 1 && rank <= 3) return "1-3";
  if (rank >= 4 && rank <= 10) return "4-10";
  if (rank >= 11 && rank <= 20) return "11-20";
  if (rank >= 21 && rank <= 30) return "21-30";
  return null;
}

interface Accum {
  sum_modelled: number;
  sum_actual: number;
  impressions_context: number;
  per_pair_ratios: number[];
  matched: number;
}
const emptyAccum = (): Accum => ({
  sum_modelled: 0,
  sum_actual: 0,
  impressions_context: 0,
  per_pair_ratios: [],
  matched: 0,
});

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function finalise(a: Accum): BucketAgg {
  const ratio = a.sum_actual > 0 ? a.sum_modelled / a.sum_actual : null;
  return {
    ratio,
    median_per_pair_ratio: median(a.per_pair_ratios),
    sum_modelled_monthly: a.sum_modelled,
    sum_actual_monthly: a.sum_actual,
    impressions_context: a.impressions_context,
    matched: a.matched,
  };
}

export function computeCalibration(pairs: CalibrationPair[]): CalibrationResult {
  const overall = emptyAccum();
  const byIntent: Record<IntentBucket, Accum> = {
    informational: emptyAccum(),
    navigational: emptyAccum(),
    commercial: emptyAccum(),
    transactional: emptyAccum(),
    unknown: emptyAccum(),
  };
  const byBand: Record<RankBand, Accum> = {
    "1-3": emptyAccum(),
    "4-10": emptyAccum(),
    "11-20": emptyAccum(),
    "21-30": emptyAccum(),
  };

  let excluded = 0;

  for (const p of pairs) {
    // Defensive: pairs whose rank is non-finite are model_blind coverage rows.
    // Callers must not feed them here; skip if one slips through so overall
    // and by_intent totals cannot silently diverge from by_rank_band.
    if (!Number.isFinite(p.rank)) continue;
    const actual30 = normaliseActualTo30d(p.actual_clicks_raw, p.window_days);
    if (actual30 < NOISE_FLOOR_CLICKS) {
      excluded += 1;
      continue;
    }

    const m = Number.isFinite(p.modelled_monthly_clicks) ? p.modelled_monthly_clicks : 0;
    const imps = Number.isFinite(p.impressions) && p.impressions > 0 ? p.impressions : 0;
    // Per-pair ratio — the noise floor guarantees actual30 > 0 here.
    const perPair = m / actual30;

    const push = (acc: Accum) => {
      acc.sum_modelled += m;
      acc.sum_actual += actual30;
      acc.impressions_context += imps;
      acc.per_pair_ratios.push(perPair);
      acc.matched += 1;
    };

    push(overall);
    const ib = INTENT_BUCKETS.includes(p.intent) ? p.intent : "unknown";
    push(byIntent[ib]);
    const band = rankBand(p.rank);
    if (band) push(byBand[band]);
  }

  const byIntentOut: Record<IntentBucket, BucketAgg> = {
    informational: finalise(byIntent.informational),
    navigational: finalise(byIntent.navigational),
    commercial: finalise(byIntent.commercial),
    transactional: finalise(byIntent.transactional),
    unknown: finalise(byIntent.unknown),
  };
  const byBandOut: Record<RankBand, BucketAgg> = {
    "1-3": finalise(byBand["1-3"]),
    "4-10": finalise(byBand["4-10"]),
    "11-20": finalise(byBand["11-20"]),
    "21-30": finalise(byBand["21-30"]),
  };

  const overallOut = finalise(overall);

  return {
    overall_ratio: overallOut.ratio,
    median_per_pair_ratio: overallOut.median_per_pair_ratio,
    sum_modelled_monthly: overallOut.sum_modelled_monthly,
    sum_actual_monthly: overallOut.sum_actual_monthly,
    impressions_context: overallOut.impressions_context,
    by_intent: byIntentOut,
    by_rank_band: byBandOut,
    matched: overall.matched,
    excluded_noise_floor: excluded,
    total_modelled_monthly_clicks: overallOut.sum_modelled_monthly,
    total_actual_30d_clicks: overallOut.sum_actual_monthly,
  };
}

/**
 * Traffic-light bucket per the promotion-gate rules:
 *   green  : 0.5 ≤ r ≤ 2.0
 *   amber  : 0.33 ≤ r < 0.5 OR 2.0 < r ≤ 3.0
 *   red    : outside amber
 *   null   : ratio unavailable (no matched actuals)
 */
export type TrafficLight = "green" | "amber" | "red" | null;
export function trafficLight(ratio: number | null | undefined): TrafficLight {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio >= 0.5 && ratio <= 2.0) return "green";
  if (ratio >= 0.33 && ratio <= 3.0) return "amber";
  return "red";
}

/**
 * Promotion gate: overall must be green AND no intent bucket red. Buckets with
 * a null ratio (no matched actuals) are ignored — they neither pass nor fail.
 */
export function isPromotionEligible(result: CalibrationResult): boolean {
  if (trafficLight(result.overall_ratio) !== "green") return false;
  for (const ib of INTENT_BUCKETS) {
    if (trafficLight(result.by_intent[ib].ratio) === "red") return false;
  }
  return true;
}
