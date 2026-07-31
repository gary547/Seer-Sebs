// Pure Revenue v2 per-keyword computation.
// No I/O. Callers pass fully resolved inputs (CTRs, SVM, CVR/AOV, HAR values).

// Source of truth for the Revenue v2 model version. All producers/consumers
// MUST import this constant — no string literals for "revenue_v2.*" are
// allowed outside supabase/functions/_shared/ (enforced by drift guard test).
export const REVENUE_V2_MODEL_VERSION = "revenue_v2.1.0";


export type ScenarioName = "conservative" | "realistic" | "stretch";
export type TrendConfidence = "low" | "medium" | "high";

export interface MonthlyVolumeRow {
  month: string; // "YYYY-MM-01" or "YYYY-MM"
  volume: number;
}

export interface RevenueV2Inputs {
  scenario: ScenarioName;
  volume_annual: number | null; // Vy — sum of last 12 monthly volumes or avg*12
  ctr_now: number | null; // decimal
  ctr_tp: number | null;
  svm: number | null; // serp visibility multiplier (default 1 if null)
  cvr: number | null; // decimal 0..1
  aov: number | null;
  pos_now: number | null;
  pos_tp: number | null;
  rank_attainment_probability: number | null;
  har_confidence: number | null;
  monthly_volumes: MonthlyVolumeRow[]; // may be empty
  /**
   * Prompt 2.4 — trend-adjusted forward volume. Both optional; when either is
   * absent/low-confidence the factor collapses to 1 and behaviour is identical
   * to a pre-2.4 run. `trend_pct` is stored as PERCENT (e.g. 15 = +15%),
   * matching `keyword_demand_signals.trend_pct`.
   */
  trend_pct?: number | null;
  trend_confidence?: TrendConfidence | null;
}

export interface RevenueV2Outputs {
  current_revenue_annual: number | null;
  tp_absolute_revenue_annual: number | null;
  tp_incremental_revenue_annual: number | null;
  /**
   * Expected incremental revenue = tp_incremental × clamp01(p_att).
   * har_conf is intentionally NOT part of this product (v2.1.0). Confidence
   * is expressed via [expected_low, expected_high] instead. Invariant:
   * expected_low ≤ expected ≤ expected_high ≤ tp_incremental.
   */
  expected_incremental_revenue_annual: number | null;
  expected_incremental_low_annual: number | null;
  expected_incremental_high_annual: number | null;
  monthly_revenue_json: MonthlyRevenueJson;
  warnings: string[];
  ctr_now: number | null;
  ctr_tp: number | null;
  svm_used: number;
  p_att_used: number;
  har_conf_used: number;
  band_method: "conf_interp_band_v1";
  /** Prompt 2.4: annual volume after clamped trend factor (null if base was null). */
  volume_forward: number | null;
  /** Prompt 2.4: clamped multiplicative factor actually applied (1 when no adjustment). */
  factor_applied: number;
}

export interface MonthlyRevenueMonth {
  month: string;
  volume: number;
  current: number | null;
  tp_absolute: number | null;
  tp_incremental: number | null;
}

export interface MonthlyRevenueJson {
  months: MonthlyRevenueMonth[];
  monthly_source: "keyword_monthly_volumes" | "avg" | "mixed" | "none";
  months_used: number;
  /**
   * v2.1.0+ month-key semantics indicator:
   * - "forward_projected": historical month-of-year mapped onto the next 12 calendar months
   * - "forward": next 12 calendar months populated from avg / mixed inputs
   * - "none": no months produced
   */
  label_mode: "forward_projected" | "forward" | "none";
  totals: {
    current: number | null;
    tp_absolute: number | null;
    tp_incremental: number | null;
    expected_incremental: number | null;
    expected_incremental_low: number | null;
    expected_incremental_high: number | null;
  };
}

const round2 = (n: number | null): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

const clamp01 = (n: number | null | undefined): number => {
  if (n == null || !Number.isFinite(Number(n))) return 0;
  const v = Number(n);
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
};

/** Build a rolling 12-month window starting at (nowUtc month + 1). */
function nextTwelveMonths(nowUtc: Date): string[] {
  const out: string[] = [];
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth(); // 0..11
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(y, m + i, 1));
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${d.getUTCFullYear()}-${mm}`);
  }
  return out;
}

function normaliseMonthKey(raw: string): string {
  // Accept "YYYY-MM-DD" or "YYYY-MM"
  if (raw.length >= 7) return raw.slice(0, 7);
  return raw;
}

/** Public helper: sum monthly volumes if 12+ available; else avg*12; else null. */
export function annualVolumeFromInputs(
  monthly: MonthlyVolumeRow[],
  avgMonthlyVolume: number | null,
): { volume_annual: number | null; source: "keyword_monthly_volumes" | "avg" | "none"; months_used: number } {
  const valid = (monthly ?? []).filter((r) => Number.isFinite(r.volume));
  if (valid.length >= 12) {
    // sort desc by month, take latest 12
    const sorted = [...valid].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 12);
    const sum = sorted.reduce((s, r) => s + Number(r.volume ?? 0), 0);
    return { volume_annual: sum, source: "keyword_monthly_volumes", months_used: 12 };
  }
  if (avgMonthlyVolume != null && Number.isFinite(avgMonthlyVolume)) {
    return { volume_annual: avgMonthlyVolume * 12, source: "avg", months_used: 12 };
  }
  return { volume_annual: null, source: "none", months_used: 0 };
}

/**
 * Prompt 2.4 — clamped forward-volume factor.
 * `trend_pct` is percent (15 = +15%). Only applied when confidence is
 * medium/high AND trend_pct is finite. Clamped hard to [0.7, 1.3].
 */
export function trendFactor(
  trend_pct: number | null | undefined,
  trend_confidence: TrendConfidence | null | undefined,
): { factor: number; applied: boolean } {
  if (trend_pct == null || !Number.isFinite(Number(trend_pct))) return { factor: 1, applied: false };
  if (trend_confidence !== "medium" && trend_confidence !== "high") return { factor: 1, applied: false };
  const raw = 1 + Number(trend_pct) / 100;
  const clamped = Math.min(1.3, Math.max(0.7, raw));
  return { factor: clamped, applied: clamped !== 1 };
}

export function computeRevenueV2(
  inputs: RevenueV2Inputs,
  nowUtc: Date = new Date(),
): RevenueV2Outputs {
  const warnings: string[] = [];
  const svm = inputs.svm != null && Number.isFinite(inputs.svm) ? Number(inputs.svm) : 1;
  if (inputs.svm == null) warnings.push("missing_svm");
  const pAtt = clamp01(inputs.rank_attainment_probability);
  const harConf = clamp01(inputs.har_confidence);
  if (inputs.rank_attainment_probability == null) warnings.push("missing_rank_prob");
  if (pAtt < 0.2) warnings.push("low_rank_prob");
  if (inputs.har_confidence == null) warnings.push("missing_har_confidence");
  else if (harConf < 0.5) warnings.push("low_har_confidence");

  // v2.1.0+: "not ranking" (no current position) is a legitimate case —
  // current revenue is 0, not null. This unblocks tp_incremental for
  // unranked keywords. missing_ctr_now is suppressed here because CTR at
  // an absent position is not a resolver miss.
  const isNotRanking = inputs.pos_now == null;
  if (!isNotRanking && inputs.ctr_now == null) warnings.push("missing_ctr_now");
  if (isNotRanking) warnings.push("not_ranking");
  if (inputs.ctr_tp == null) warnings.push("missing_ctr_tp");
  if (inputs.cvr == null) warnings.push("missing_cvr");
  if (inputs.aov == null) warnings.push("missing_aov");
  if (inputs.pos_tp == null) warnings.push("missing_pos_tp");
  if (inputs.volume_annual == null) warnings.push("missing_volume");

  // Prompt 2.4 — trend-adjusted forward volume. Base volume stays intact in
  // provenance; every arithmetic use of the annual volume from this point
  // forward runs on `volumeForward = base × factor`.
  const factorRes = trendFactor(inputs.trend_pct, inputs.trend_confidence);
  const volumeForward: number | null =
    inputs.volume_annual == null ? null : Number(inputs.volume_annual) * factorRes.factor;
  if (factorRes.applied) warnings.push("trend_adjusted");
  if (factorRes.applied && factorRes.factor < 0.85) warnings.push("trend_declining");

  const canCurrent =
    volumeForward != null &&
    inputs.cvr != null &&
    inputs.aov != null &&
    (isNotRanking || inputs.ctr_now != null);
  const canTp =
    volumeForward != null &&
    inputs.ctr_tp != null &&
    inputs.pos_tp != null &&
    inputs.cvr != null &&
    inputs.aov != null;

  const current = canCurrent
    ? (isNotRanking
        ? 0
        : Number(volumeForward) * Number(inputs.ctr_now) * svm *
          Number(inputs.cvr) * Number(inputs.aov))
    : null;
  const tpAbs = canTp
    ? Number(volumeForward) * Number(inputs.ctr_tp) * svm *
      Number(inputs.cvr) * Number(inputs.aov)
    : null;

  let tpIncr: number | null = null;
  if (canCurrent && canTp && current != null && tpAbs != null) {
    tpIncr = Math.max(0, tpAbs - current);
  }

  // v2.1.0: expected = tp_incremental × p_att (har_conf removed from product).
  // Confidence is expressed as a [low, high] band instead.
  const expected = tpIncr != null ? tpIncr * pAtt : null;

  // Band uses har_conf if provided; if har_conf is null, band collapses to
  // [expected, expected] (we still emit the missing_har_confidence warning
  // above so callers can see the gap).
  const harConfProvided =
    inputs.har_confidence != null && Number.isFinite(Number(inputs.har_confidence));
  const harConfForBand = harConfProvided ? clamp01(inputs.har_confidence) : 1;
  let expectedLow: number | null = null;
  let expectedHigh: number | null = null;
  if (expected != null && tpIncr != null) {
    expectedLow = expected * harConfForBand;
    expectedHigh = expected + (tpIncr - expected) * (1 - harConfForBand);
  }

  // Monthly split. Search-demand shape comes from keyword_monthly_volumes
  // (or the flat avg fallback), which exists independently of whether the
  // client currently ranks. Ranking status affects only the current side,
  // which we already forced to 0 above for not_ranking; buildMonthly needs
  // no branching — current * weight = 0 across all months naturally.
  const monthly = buildMonthly(
    inputs,
    volumeForward,
    current,
    tpAbs,
    tpIncr,
    expected,
    expectedLow,
    expectedHigh,
    nowUtc,
  );


  return {
    current_revenue_annual: round2(current),
    tp_absolute_revenue_annual: round2(tpAbs),
    tp_incremental_revenue_annual: round2(tpIncr),
    expected_incremental_revenue_annual: round2(expected),
    expected_incremental_low_annual: round2(expectedLow),
    expected_incremental_high_annual: round2(expectedHigh),
    monthly_revenue_json: monthly,
    warnings,
    ctr_now: inputs.ctr_now,
    ctr_tp: inputs.ctr_tp,
    svm_used: svm,
    p_att_used: pAtt,
    har_conf_used: harConf,
    band_method: "conf_interp_band_v1",
    volume_forward: volumeForward == null ? null : Math.round(volumeForward * 100) / 100,
    factor_applied: factorRes.factor,
  };
}

function buildMonthly(
  inputs: RevenueV2Inputs,
  volumeForwardAnnual: number | null,
  current: number | null,
  tpAbs: number | null,
  tpIncr: number | null,
  expected: number | null,
  expectedLow: number | null,
  expectedHigh: number | null,
  nowUtc: Date,
): MonthlyRevenueJson {
  const rawMonthly = (inputs.monthly_volumes ?? []).filter((r) => Number.isFinite(r.volume));
  const sorted = [...rawMonthly].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 12);
  let source: MonthlyRevenueJson["monthly_source"];
  let labelMode: MonthlyRevenueJson["label_mode"];
  let volumesByMonth: Array<{ month: string; volume: number }> = [];
  if (sorted.length >= 12) {
    source = "keyword_monthly_volumes";
    labelMode = "forward_projected";
    // Map historical month-of-year -> volume. `sorted` is newest-first, so
    // iterating in reverse ensures the newest row wins on any month-of-year
    // collision (edge case from duplicate/bad data).
    const byMoy = new Map<string, number>();
    for (let i = sorted.length - 1; i >= 0; i--) {
      const key = normaliseMonthKey(sorted[i].month).slice(5, 7);
      byMoy.set(key, Number(sorted[i].volume));
    }
    const forwardMonths = nextTwelveMonths(nowUtc);
    volumesByMonth = forwardMonths.map((m) => ({
      month: m,
      volume: byMoy.get(m.slice(5, 7)) ?? 0,
    }));
  } else if (volumeForwardAnnual != null) {
    source = sorted.length > 0 ? "mixed" : "avg";
    labelMode = "forward";
    const evenly = volumeForwardAnnual / 12;
    const months = nextTwelveMonths(nowUtc);
    const map = new Map<string, number>(
      sorted.map((r) => [normaliseMonthKey(r.month), Number(r.volume)]),
    );
    volumesByMonth = months.map((m) => ({ month: m, volume: map.get(m) ?? evenly }));
  } else {
    source = "none";
    labelMode = "none";
    volumesByMonth = [];
  }

  // Prompt 2.4 — rescale printed month.volume so Σ conserves to volume_forward.
  // Revenue math already uses volume_forward via `current`/`tpAbs` (weight is a
  // pure fraction), so this only reconciles the displayed volume column.
  const rawTotalVol = volumesByMonth.reduce((s, r) => s + r.volume, 0);
  if (volumeForwardAnnual != null && rawTotalVol > 0 && volumesByMonth.length > 0) {
    const scale = volumeForwardAnnual / rawTotalVol;
    if (scale !== 1) {
      volumesByMonth = volumesByMonth.map((r) => ({ month: r.month, volume: r.volume * scale }));
    }
  }

  const totalVol = volumesByMonth.reduce((s, r) => s + r.volume, 0);
  const perMonth: MonthlyRevenueMonth[] = volumesByMonth.map((r) => {
    const weight = totalVol > 0 ? r.volume / totalVol : 0;
    return {
      month: r.month,
      volume: Math.round(r.volume),
      current: current != null ? round2(current * weight) : null,
      tp_absolute: tpAbs != null ? round2(tpAbs * weight) : null,
      tp_incremental: tpIncr != null ? round2(tpIncr * weight) : null,
    };
  });

  return {
    months: perMonth,
    monthly_source: source,
    months_used: perMonth.length,
    label_mode: labelMode,
    totals: {
      current: round2(current),
      tp_absolute: round2(tpAbs),
      tp_incremental: round2(tpIncr),
      expected_incremental: round2(expected),
      expected_incremental_low: round2(expectedLow),
      expected_incremental_high: round2(expectedHigh),
    },
  };
}
