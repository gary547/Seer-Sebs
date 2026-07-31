// Phase 6 readiness classifier — single source of truth for the thresholds
// that decide whether Demand Intelligence can run in 24-month, partial,
// fallback 12-month or no-history mode.
//
// KEEP IN SYNC with src/lib/phase6Readiness.ts (mirrored constants — Deno
// edge functions cannot import from src/).

export const READY_24_MONTH_THRESHOLD = 80;
export const PARTIAL_24_MONTH_THRESHOLD = 40;
export const FALLBACK_12_MONTH_THRESHOLD = 50;
export const READY_MIN_MONTHS = 24;
export const FALLBACK_MIN_MONTHS = 12;

export type ReadinessStatus =
  | "ready_24_month"
  | "partial_24_month"
  | "fallback_12_month"
  | "no_history";

export interface CoverageSummary {
  keywords_with_history: number;
  kept_keywords_total: number;
  min_months: number;
  median_months: number;
  max_months: number;
  percent_keywords_at_or_above_24_months: number;
  percent_keywords_at_or_above_12_months: number;
}

export interface ReadinessThresholds {
  ready_24_month_threshold: number;
  partial_24_month_threshold: number;
  fallback_12_month_threshold: number;
  ready_min_months: number;
  fallback_min_months: number;
}

export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = {
  ready_24_month_threshold: READY_24_MONTH_THRESHOLD,
  partial_24_month_threshold: PARTIAL_24_MONTH_THRESHOLD,
  fallback_12_month_threshold: FALLBACK_12_MONTH_THRESHOLD,
  ready_min_months: READY_MIN_MONTHS,
  fallback_min_months: FALLBACK_MIN_MONTHS,
};

export interface ReadinessResult {
  status: ReadinessStatus;
  reason: string;
  thresholds_used: ReadinessThresholds;
}

export function classifyReadiness(
  coverage: CoverageSummary,
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): ReadinessResult {
  const t = thresholds;
  const p24 = coverage.percent_keywords_at_or_above_24_months ?? 0;
  const p12 = coverage.percent_keywords_at_or_above_12_months ?? 0;
  const withHistory = coverage.keywords_with_history ?? 0;

  if (withHistory <= 0) {
    return {
      status: "no_history",
      reason: "No kept keywords have any monthly volume history.",
      thresholds_used: t,
    };
  }
  if (p24 >= t.ready_24_month_threshold) {
    return {
      status: "ready_24_month",
      reason: `${p24}% of kept keywords have >= ${t.ready_min_months} months (>= ${t.ready_24_month_threshold}% required).`,
      thresholds_used: t,
    };
  }
  if (p24 >= t.partial_24_month_threshold) {
    return {
      status: "partial_24_month",
      reason: `${p24}% of kept keywords have >= ${t.ready_min_months} months (between ${t.partial_24_month_threshold}% and ${t.ready_24_month_threshold}%).`,
      thresholds_used: t,
    };
  }
  if (p12 >= t.fallback_12_month_threshold) {
    return {
      status: "fallback_12_month",
      reason: `${p12}% of kept keywords have >= ${t.fallback_min_months} months (>= ${t.fallback_12_month_threshold}% required); 24-month coverage insufficient.`,
      thresholds_used: t,
    };
  }
  return {
    status: "no_history",
    reason: `Only ${p12}% at >= ${t.fallback_min_months} months and ${p24}% at >= ${t.ready_min_months} months — below all thresholds.`,
    thresholds_used: t,
  };
}
