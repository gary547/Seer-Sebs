export interface MonthlyPoint {
  month: string;
  volume: number;
}

export type TrendDirection =
  | "declining"
  | "growing"
  | "insufficient_data"
  | "stable"
  | "volatile";

export interface DemandSignal {
  coverageMonths: number;
  demandWarning: boolean;
  demandWarningReason: string | null;
  peakMonths: number[];
  seasonalityStrength: number | null;
  trendConfidence: "high" | "low" | "medium";
  trendDirection: TrendDirection;
  trendPct: number | null;
  trendSlope: number | null;
  volatilityScore: number | null;
}

const round = (value: number, precision = 4): number => {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
};

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function normaliseSeries(points: MonthlyPoint[]): MonthlyPoint[] {
  const byMonth = new Map<string, number>();
  for (const point of points) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(point.month)) continue;
    byMonth.set(point.month, Math.max(0, point.volume));
  }
  return [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, volume]) => ({ month, volume }));
}

function slope(values: number[]): number | null {
  if (values.length < 2) return null;
  const timeAverage = (values.length - 1) / 2;
  const valueAverage = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const timeDelta = index - timeAverage;
    numerator += timeDelta * (values[index]! - valueAverage);
    denominator += timeDelta ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function peakMonths(series: MonthlyPoint[]): number[] {
  const buckets = new Map<number, number[]>();
  for (const point of series) {
    const month = Number(point.month.slice(5, 7));
    const values = buckets.get(month) ?? [];
    values.push(point.volume);
    buckets.set(month, values);
  }
  const averages = [...buckets.entries()].map(([month, values]) => ({
    month,
    value: mean(values),
  }));
  const overall = mean(averages.map((item) => item.value));
  if (overall <= 0) return [];
  return averages
    .filter((item) => item.value / overall >= 1.3)
    .sort((left, right) => right.value - left.value)
    .slice(0, 3)
    .map((item) => item.month);
}

function seasonality(series: MonthlyPoint[]): number | null {
  if (series.length < 12) return null;
  const allVariance = variance(series.map((point) => point.volume));
  if (allVariance === 0) return 0;
  const buckets = new Map<number, number[]>();
  for (const point of series) {
    const month = Number(point.month.slice(5, 7));
    const values = buckets.get(month) ?? [];
    values.push(point.volume);
    buckets.set(month, values);
  }
  return round(
    Math.min(
      1,
      variance([...buckets.values()].map((values) => mean(values))) /
        allVariance,
    ),
  );
}

export function computeDemandSignal(points: MonthlyPoint[]): DemandSignal {
  const series = normaliseSeries(points);
  const values = series.map((point) => point.volume);
  const average = mean(values);
  const volatility =
    average <= 0 ? null : round(Math.sqrt(variance(values)) / average);
  const base = {
    coverageMonths: series.length,
    peakMonths: peakMonths(series),
    seasonalityStrength: seasonality(series),
    volatilityScore: volatility,
  };
  if (series.length < 12) {
    return {
      ...base,
      demandWarning: true,
      demandWarningReason:
        series.length === 0 ? "no_history" : "insufficient_history",
      trendConfidence: "low",
      trendDirection: "insufficient_data",
      trendPct: null,
      trendSlope: null,
    };
  }
  const highConfidence = series.length >= 24;
  const current = highConfidence
    ? series.slice(-12).reduce((sum, point) => sum + point.volume, 0)
    : series.slice(-3).reduce((sum, point) => sum + point.volume, 0);
  const previous = highConfidence
    ? series.slice(-24, -12).reduce((sum, point) => sum + point.volume, 0)
    : series.slice(-6, -3).reduce((sum, point) => sum + point.volume, 0);
  const trendPct =
    previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
  const threshold = highConfidence ? 10 : 15;
  const trendDirection: TrendDirection =
    volatility !== null && volatility > 1
      ? "volatile"
      : trendPct > threshold
        ? "growing"
        : trendPct < -threshold
          ? "declining"
          : "stable";
  return {
    ...base,
    demandWarning: trendDirection === "volatile",
    demandWarningReason:
      trendDirection === "volatile" ? "high_volatility" : null,
    trendConfidence:
      highConfidence && (volatility === null || volatility <= 0.7)
        ? "high"
        : "medium",
    trendDirection,
    trendPct: round(trendPct, 2),
    trendSlope: round(slope(values) ?? 0),
  };
}
