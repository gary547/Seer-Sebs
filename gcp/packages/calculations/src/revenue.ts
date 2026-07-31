import type { HarScenario } from "./har.js";

export const REVENUE_MODEL_VERSION = "revenue_v2.1.0";

export interface RevenueInputs {
  annualVolume: number | null;
  averageOrderValue: number | null;
  conversionRate: number | null;
  ctrNow: number | null;
  ctrTarget: number | null;
  harConfidence: number | null;
  rankAttainmentProbability: number | null;
  scenario: HarScenario;
  serpVisibilityMultiplier: number | null;
  trendConfidence: "high" | "low" | "medium";
  trendPct: number | null;
}

export interface RevenueResult {
  currentRevenueAnnual: number | null;
  expectedIncrementalAnnual: number | null;
  expectedIncrementalHighAnnual: number | null;
  expectedIncrementalLowAnnual: number | null;
  factorApplied: number;
  scenario: HarScenario;
  targetAbsoluteRevenueAnnual: number | null;
  targetIncrementalRevenueAnnual: number | null;
  volumeForward: number | null;
  warnings: string[];
}

const roundMoney = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;

const clamp01 = (value: number | null): number =>
  value === null ? 0 : Math.max(0, Math.min(1, value));

export function trendFactor(
  trendPct: number | null,
  confidence: RevenueInputs["trendConfidence"],
): number {
  if (
    trendPct === null ||
    (confidence !== "medium" && confidence !== "high")
  ) {
    return 1;
  }
  return Math.max(0.7, Math.min(1.3, 1 + trendPct / 100));
}

export function computeRevenue(inputs: RevenueInputs): RevenueResult {
  const warnings: string[] = [];
  const factor = trendFactor(inputs.trendPct, inputs.trendConfidence);
  const volumeForward =
    inputs.annualVolume === null ? null : inputs.annualVolume * factor;
  if (factor !== 1) warnings.push("trend_adjusted");
  if (inputs.annualVolume === null) warnings.push("missing_volume");
  if (inputs.conversionRate === null) warnings.push("missing_conversion_rate");
  if (inputs.averageOrderValue === null) warnings.push("missing_average_order_value");
  if (inputs.ctrTarget === null) warnings.push("missing_target_ctr");
  if (inputs.ctrNow === null) warnings.push("not_ranking");
  if (inputs.rankAttainmentProbability === null) {
    warnings.push("missing_rank_probability");
  }
  const economicsAvailable =
    volumeForward !== null &&
    inputs.conversionRate !== null &&
    inputs.averageOrderValue !== null;
  const visibility = inputs.serpVisibilityMultiplier ?? 1;
  const current =
    economicsAvailable && inputs.ctrNow !== null
      ? volumeForward *
        inputs.ctrNow *
        visibility *
        Number(inputs.conversionRate) *
        Number(inputs.averageOrderValue)
      : economicsAvailable
        ? 0
        : null;
  const target =
    economicsAvailable && inputs.ctrTarget !== null
      ? volumeForward *
        inputs.ctrTarget *
        visibility *
        Number(inputs.conversionRate) *
        Number(inputs.averageOrderValue)
      : null;
  const incremental =
    current === null || target === null ? null : Math.max(0, target - current);
  const probability = clamp01(inputs.rankAttainmentProbability);
  const confidence = clamp01(inputs.harConfidence);
  const expected = incremental === null ? null : incremental * probability;
  const low = expected === null ? null : expected * confidence;
  const high =
    expected === null || incremental === null
      ? null
      : expected + (incremental - expected) * (1 - confidence);
  return {
    currentRevenueAnnual: roundMoney(current),
    expectedIncrementalAnnual: roundMoney(expected),
    expectedIncrementalHighAnnual: roundMoney(high),
    expectedIncrementalLowAnnual: roundMoney(low),
    factorApplied: factor,
    scenario: inputs.scenario,
    targetAbsoluteRevenueAnnual: roundMoney(target),
    targetIncrementalRevenueAnnual: roundMoney(incremental),
    volumeForward: roundMoney(volumeForward),
    warnings,
  };
}
