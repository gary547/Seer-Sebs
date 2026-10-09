import type { KeywordEnrichmentStageData, SerpCollectionStageData } from "./stage-handlers.js";

export const FORECAST_ELIGIBILITY_POLICY = "automatic-v1";
export type ForecastExclusionReason = "missing_volume" | "below_operator_threshold" | "no_organic_results";
export interface ForecastExclusion {
  id: string;
  normalisedText: string;
  sourceKeywordId: string;
  reason: ForecastExclusionReason;
}

export function automaticForecastEligibility(input: unknown): boolean {
  return !!input && typeof input === "object" && "forecastEligibilityPolicy" in input
    && input.forecastEligibilityPolicy === FORECAST_ELIGIBILITY_POLICY;
}

/** Only terminal, evidenced outcomes qualify. Missing collection/authority still fails readiness. */
export function deriveForecastExclusions(enrichment: KeywordEnrichmentStageData, serp: SerpCollectionStageData): ForecastExclusion[] {
  if (enrichment.handlerVersion !== "keyword-enrichment-v1" || serp.handlerVersion !== "serp-collection-v1") {
    throw new Error("Forecast eligibility requires saved enrichment and search observations.");
  }
  const searches = new Map(serp.keywords.map(keyword => [keyword.id, keyword]));
  return enrichment.keywords.flatMap(keyword => {
    const volume = keyword.enrichment.avgMonthlyVolume;
    const search = searches.get(keyword.id);
    const reason: ForecastExclusionReason | null = volume === null && keyword.enrichment.competitiveEligibilityReason === "missing_volume"
      ? "missing_volume"
      : volume !== null && Number.isFinite(volume) && volume >= 0 && !keyword.enrichment.competitiveEligible
        && keyword.enrichment.competitiveEligibilityReason === "below_operator_threshold" ? "below_operator_threshold"
        : search?.status === "no-result" && search.results.length === 0 ? "no_organic_results" : null;
    return reason ? [{ id: keyword.id, normalisedText: keyword.normalisedText,
      sourceKeywordId: search?.sourceKeywordId ?? keyword.id, reason }] : [];
  });
}

export function forecastEligibilitySummary(exclusions: ForecastExclusion[], retainedCount: number, evaluatedAt: string) {
  return {
    policy: FORECAST_ELIGIBILITY_POLICY, evaluatedAt,
    calculatedKeywordCount: retainedCount - exclusions.length,
    excludedKeywordCount: exclusions.length,
    countsByReason: Object.fromEntries((["missing_volume", "below_operator_threshold", "no_organic_results"] as const)
      .map(reason => [reason, exclusions.filter(keyword => keyword.reason === reason).length])),
    sample: exclusions.slice(0, 20),
  };
}
