export const fallbackCtr = (rank: number): number =>
  Math.round((0.32 / rank ** 0.85) * 1_000_000) / 1_000_000;

export function ctrConfidence(
  impressions: number,
): "high" | "low" | "medium" {
  if (impressions >= 1_000) return "high";
  if (impressions >= 100) return "medium";
  return "low";
}
