// Demand Intelligence v1 — pure compute helpers.
// Consumed by supabase/functions/demand-signals-compute/index.ts.
// No I/O, no DataForSEO, no DB. Deterministic given the input series.

export type MonthlyPoint = {
  month: string; // YYYY-MM-01
  volume: number;
};

export type TrendDirection =
  | "growing"
  | "stable"
  | "declining"
  | "volatile"
  | "insufficient_data";

export type TrendConfidence = "high" | "medium" | "low";

export type PeakMonth = {
  month: number; // 1..12
  mean_volume: number;
  index_vs_avg: number;
};

export type DemandSignalRow = {
  data_coverage_months: number;
  trend_direction: TrendDirection;
  trend_pct: number | null;
  trend_slope: number | null;
  trend_confidence: TrendConfidence;
  volatility_score: number | null;
  seasonality_strength: number | null;
  peak_months_json: PeakMonth[];
  shoulder_months_json: PeakMonth[];
  demand_warning: boolean;
  demand_warning_reason: string | null;
  // Diagnostic fields — not persisted, useful for tests & inspector aggregation.
  branch: "high_confidence_24" | "momentum_12" | "insufficient";
  trailing12?: number;
  prior12?: number;
  yoy_same_month_pct?: number | null;
  recent3?: number;
  prior3?: number;
};

// ---------- utility maths ----------

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / xs.length;
}

function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

// OLS slope of y vs t (t = 0..n-1). Returns null if fewer than 2 points.
function olsSlope(ys: number[]): number | null {
  const n = ys.length;
  if (n < 2) return null;
  const tMean = (n - 1) / 2;
  const yMean = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = i - tMean;
    num += dt * (ys[i] - yMean);
    den += dt * dt;
  }
  if (den === 0) return null;
  return num / den;
}

function round(n: number, dp = 4): number {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

// ---------- public API ----------

// Sort chronologically and dedupe by month (last write wins if duplicates leaked in).
export function normaliseSeries(points: MonthlyPoint[]): MonthlyPoint[] {
  const byMonth = new Map<string, number>();
  for (const p of points) {
    if (!p || !p.month) continue;
    byMonth.set(p.month, Number.isFinite(p.volume) ? p.volume : 0);
  }
  return Array.from(byMonth.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([month, volume]) => ({ month, volume }));
}

function peakAndShoulderMonths(series: MonthlyPoint[]): {
  peak: PeakMonth[];
  shoulder: PeakMonth[];
} {
  // Aggregate by calendar month (1..12) using mean across years present.
  const buckets = new Map<number, number[]>();
  for (const p of series) {
    const m = Number(p.month.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const arr = buckets.get(m) ?? [];
    arr.push(p.volume);
    buckets.set(m, arr);
  }
  if (buckets.size === 0) return { peak: [], shoulder: [] };
  const perMonth: PeakMonth[] = [];
  for (const [m, vs] of buckets) {
    const mv = mean(vs);
    perMonth.push({ month: m, mean_volume: round(mv, 2), index_vs_avg: 0 });
  }
  const overall = mean(perMonth.map((p) => p.mean_volume));
  for (const p of perMonth) {
    p.index_vs_avg = overall > 0 ? round(p.mean_volume / overall, 3) : 0;
  }
  const peak = perMonth
    .filter((p) => p.index_vs_avg >= 1.3)
    .sort((a, b) => b.index_vs_avg - a.index_vs_avg)
    .slice(0, 3);
  const shoulder = perMonth
    .filter((p) => p.index_vs_avg >= 0.8 && p.index_vs_avg < 1.3)
    .sort((a, b) => b.index_vs_avg - a.index_vs_avg)
    .slice(0, 4);
  return { peak, shoulder };
}

// variance-of-monthly-means ÷ variance-of-all-months, clamped [0,1].
// Null when we have fewer than 12 months of history.
function seasonalityStrength(series: MonthlyPoint[]): number | null {
  if (series.length < 12) return null;
  const allV = variance(series.map((p) => p.volume));
  if (allV === 0) return 0;
  const byM = new Map<number, number[]>();
  for (const p of series) {
    const m = Number(p.month.slice(5, 7));
    const arr = byM.get(m) ?? [];
    arr.push(p.volume);
    byM.set(m, arr);
  }
  const means = Array.from(byM.values()).map(mean);
  const bV = variance(means);
  const raw = bV / allV;
  return round(Math.max(0, Math.min(1, raw)), 4);
}

function volatilityScore(series: MonthlyPoint[]): number | null {
  const vs = series.map((p) => p.volume);
  const m = mean(vs);
  if (m <= 0) return null;
  return round(stdev(vs) / m, 4);
}

export function computeDemandSignal(rawSeries: MonthlyPoint[]): DemandSignalRow {
  const series = normaliseSeries(rawSeries);
  const coverage = series.length;
  const vol = volatilityScore(series);
  const seasonality = seasonalityStrength(series);
  const { peak, shoulder } = peakAndShoulderMonths(series);

  // Insufficient-history branch (0..11 months, or 0 kept rows).
  if (coverage < 12) {
    return {
      data_coverage_months: coverage,
      trend_direction: "insufficient_data",
      trend_pct: null,
      trend_slope: null,
      trend_confidence: "low",
      volatility_score: vol,
      seasonality_strength: seasonality,
      peak_months_json: peak,
      shoulder_months_json: shoulder,
      demand_warning: true,
      demand_warning_reason: coverage === 0 ? "no_history" : "insufficient_history",
      branch: "insufficient",
    };
  }

  // High-confidence branch (>=24 months).
  if (coverage >= 24) {
    const latest24 = series.slice(-24);
    const trailing12 = latest24.slice(12).reduce((s, p) => s + p.volume, 0);
    const prior12 = latest24.slice(0, 12).reduce((s, p) => s + p.volume, 0);
    const trendPct =
      prior12 > 0 ? ((trailing12 - prior12) / prior12) * 100 : trailing12 > 0 ? 100 : 0;
    const slope = olsSlope(latest24.map((p) => p.volume));

    // YoY same-month comparison across the last 12 comparable months.
    const last12 = series.slice(-12);
    const prior = new Map(series.slice(-24, -12).map((p) => [p.month.slice(5, 7), p.volume]));
    const yoyPcts: number[] = [];
    for (const p of last12) {
      const pv = prior.get(p.month.slice(5, 7));
      if (pv != null && pv > 0) yoyPcts.push(((p.volume - pv) / pv) * 100);
    }
    const yoy = yoyPcts.length ? round(mean(yoyPcts), 2) : null;

    let direction: TrendDirection;
    if (vol != null && vol > 1.0) direction = "volatile";
    else if (trendPct > 10) direction = "growing";
    else if (trendPct < -10) direction = "declining";
    else direction = "stable";

    const confidence: TrendConfidence = vol != null && vol > 0.7 ? "medium" : "high";

    return {
      data_coverage_months: coverage,
      trend_direction: direction,
      trend_pct: round(trendPct, 2),
      trend_slope: slope == null ? null : round(slope, 4),
      trend_confidence: confidence,
      volatility_score: vol,
      seasonality_strength: seasonality,
      peak_months_json: peak,
      shoulder_months_json: shoulder,
      demand_warning: direction === "volatile",
      demand_warning_reason: direction === "volatile" ? "high_volatility" : null,
      branch: "high_confidence_24",
      trailing12,
      prior12,
      yoy_same_month_pct: yoy,
    };
  }

  // Momentum branch (12..23 months).
  const recent3 = series.slice(-3).reduce((s, p) => s + p.volume, 0);
  const prior3 = series.slice(-6, -3).reduce((s, p) => s + p.volume, 0);
  const trendPct =
    prior3 > 0 ? ((recent3 - prior3) / prior3) * 100 : recent3 > 0 ? 100 : 0;
  const slope = olsSlope(series.map((p) => p.volume));

  let direction: TrendDirection;
  if (vol != null && vol > 1.0) direction = "volatile";
  else if (trendPct > 15) direction = "growing";
  else if (trendPct < -15) direction = "declining";
  else direction = "stable";

  return {
    data_coverage_months: coverage,
    trend_direction: direction,
    trend_pct: round(trendPct, 2),
    trend_slope: slope == null ? null : round(slope, 4),
    trend_confidence: "low",
    volatility_score: vol,
    seasonality_strength: seasonality,
    peak_months_json: peak,
    shoulder_months_json: shoulder,
    demand_warning: true,
    demand_warning_reason: "limited_history_lt_24_months",
    branch: "momentum_12",
    recent3,
    prior3,
  };
}

// ============================================================================
// Category rollups (Prompt 6.2)
// ----------------------------------------------------------------------------
// Aggregate per-keyword DemandSignalRow values into a category-level summary.
// Pure function. No I/O. Group filtering (missing tag_1, empty group) is the
// caller's responsibility.
// ============================================================================

export const CATEGORY_ROLLUP_THRESHOLDS = {
  MIN_KW_FOR_TREND: 3,           // below → insufficient_data
  MIN_KW_FOR_MEDIUM_CONF: 5,
  MIN_KW_FOR_HIGH_CONF: 15,
  VOLATILE_MEMBER_SHARE: 0.3,    // ≥30% volatile members → volatile group
  GROWING_PCT: 10,
  DECLINING_PCT: -10,
  PEAK_INDEX_FLOOR: 1.15,        // weighted index_vs_avg ≥ 1.15× → peak month
  MAX_PEAKS: 3,
} as const;

export type CategoryRollupMember = {
  signal: Pick<
    DemandSignalRow,
    "trend_direction" | "trend_pct" | "trend_confidence" | "seasonality_strength" | "peak_months_json"
  >;
  avg_monthly_volume: number | null;
};

export type CategoryRollupResult = {
  keyword_count: number;
  total_volume: number;
  trend_direction: TrendDirection;
  trend_pct: number | null;
  trend_confidence: TrendConfidence;
  seasonality_strength: number | null;
  peak_months_json: PeakMonth[];
};

export function rollupCategorySignals(members: CategoryRollupMember[]): CategoryRollupResult {
  const T = CATEGORY_ROLLUP_THRESHOLDS;
  const n = members.length;

  const total_volume = members.reduce(
    (s, m) => s + (Number.isFinite(m.avg_monthly_volume as number) ? Number(m.avg_monthly_volume) : 0),
    0,
  );

  if (n === 0) {
    return {
      keyword_count: 0,
      total_volume: 0,
      trend_direction: "insufficient_data",
      trend_pct: null,
      trend_confidence: "low",
      seasonality_strength: null,
      peak_months_json: [],
    };
  }

  // Weight = volume + 1 (Laplace smoothing so zero-volume kws still count).
  const weight = (m: CategoryRollupMember) =>
    Math.max(0, Number(m.avg_monthly_volume ?? 0)) + 1;

  // Weighted mean trend_pct across members with numeric trend_pct.
  let numPct = 0;
  let denPct = 0;
  for (const m of members) {
    if (m.signal.trend_pct == null || !Number.isFinite(m.signal.trend_pct)) continue;
    const w = weight(m);
    numPct += m.signal.trend_pct * w;
    denPct += w;
  }
  const weightedPct = denPct > 0 ? numPct / denPct : null;

  // Seasonality: mean of non-null member values.
  const seaVals = members
    .map((m) => m.signal.seasonality_strength)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const seasonality = seaVals.length ? round(mean(seaVals), 4) : null;

  // Volatility share.
  const volatileCount = members.filter((m) => m.signal.trend_direction === "volatile").length;
  const insufCount = members.filter((m) => m.signal.trend_direction === "insufficient_data").length;

  // Direction.
  let direction: TrendDirection;
  if (n < T.MIN_KW_FOR_TREND || insufCount === n) {
    direction = "insufficient_data";
  } else if (volatileCount / n >= T.VOLATILE_MEMBER_SHARE) {
    direction = "volatile";
  } else if (weightedPct == null) {
    direction = "insufficient_data";
  } else if (weightedPct > T.GROWING_PCT) {
    direction = "growing";
  } else if (weightedPct < T.DECLINING_PCT) {
    direction = "declining";
  } else {
    direction = "stable";
  }

  // Confidence.
  const lowShare = members.filter((m) => m.signal.trend_confidence === "low").length / n;
  const medShare = members.filter((m) => m.signal.trend_confidence === "medium").length / n;
  let confidence: TrendConfidence;
  if (n < T.MIN_KW_FOR_MEDIUM_CONF || lowShare >= 0.5 || direction === "insufficient_data") {
    confidence = "low";
  } else if (n < T.MIN_KW_FOR_HIGH_CONF || medShare >= 0.5) {
    confidence = "medium";
  } else {
    confidence = "high";
  }

  // Peak months: weighted mean of index_vs_avg per calendar month across members.
  const monthNum = new Map<number, number>(); // sum(weight * index)
  const monthDen = new Map<number, number>(); // sum(weight)
  for (const m of members) {
    const w = weight(m);
    for (const p of m.signal.peak_months_json ?? []) {
      if (!(p.month >= 1 && p.month <= 12)) continue;
      monthNum.set(p.month, (monthNum.get(p.month) ?? 0) + w * (p.index_vs_avg ?? 0));
      monthDen.set(p.month, (monthDen.get(p.month) ?? 0) + w);
    }
  }
  const peakCandidates: PeakMonth[] = [];
  for (const [month, num] of monthNum) {
    const den = monthDen.get(month) ?? 0;
    if (den <= 0) continue;
    const idx = num / den;
    if (idx >= T.PEAK_INDEX_FLOOR) {
      peakCandidates.push({ month, mean_volume: 0, index_vs_avg: round(idx, 3) });
    }
  }
  const peak_months_json = peakCandidates
    .sort((a, b) => b.index_vs_avg - a.index_vs_avg)
    .slice(0, T.MAX_PEAKS);

  return {
    keyword_count: n,
    total_volume: round(total_volume, 2),
    trend_direction: direction,
    trend_pct: weightedPct == null ? null : round(weightedPct, 2),
    trend_confidence: confidence,
    seasonality_strength: seasonality,
    peak_months_json,
  };
}

