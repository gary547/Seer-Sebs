import type { PipelineStageId } from "./definition.js";

export interface ForecastScope {
  reason: "dataforseo_no_results";
  approvedBy: string;
  approvedAt: string;
  queries: string[];
  keywords: Array<{ id: string; normalisedText: string; sourceKeywordId: string }>;
}

export const MAX_FORECAST_EXCLUSIONS = 1_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopedStages = new Set<PipelineStageId>([
  "serp-collection", "authority", "backlinks", "site-architecture", "link-power-score",
  "har-readiness", "har-v2", "revenue-readiness", "revenue-v2", "calibration", "rollup-output",
]);

export function forecastScope(input: unknown): ForecastScope | null {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("forecastScope" in input)) return null;
  const scope = input.forecastScope as ForecastScope | null;
  if (!scope || scope.reason !== "dataforseo_no_results" || !uuid.test(scope.approvedBy)
    || !Number.isFinite(Date.parse(scope.approvedAt)) || !Array.isArray(scope.queries)
    || scope.queries.length === 0 || scope.queries.length > MAX_FORECAST_EXCLUSIONS
    || scope.queries.some(query => typeof query !== "string" || !query.trim() || query.length > 200)
    || new Set(scope.queries).size !== scope.queries.length || !Array.isArray(scope.keywords)
    || scope.keywords.length === 0 || scope.keywords.length > MAX_FORECAST_EXCLUSIONS
    || scope.keywords.some(keyword => !keyword || !uuid.test(keyword.id) || !uuid.test(keyword.sourceKeywordId)
      || typeof keyword.normalisedText !== "string" || !keyword.normalisedText.trim() || keyword.normalisedText.length > 200)
    || new Set(scope.keywords.map(keyword => keyword.id)).size !== scope.keywords.length) {
    throw new Error("The approved forecast exclusion scope is invalid.");
  }
  return scope;
}

export function scopeDependencyOutputs(
  stageId: PipelineStageId,
  outputs: Record<string, unknown>,
  scope: ForecastScope | null,
  automaticExclusions: ReadonlyArray<{ id: string }> = [],
): Record<string, unknown> {
  if ((!scope && !automaticExclusions.length) || !scopedStages.has(stageId)) return outputs;
  const ids = new Set([...(scope?.keywords ?? []), ...automaticExclusions].map(keyword => keyword.id));
  const texts = new Set(scope?.keywords.map(keyword => keyword.normalisedText) ?? []);
  return Object.fromEntries(Object.entries(outputs).map(([id, output]) => {
    if (!output || typeof output !== "object" || Array.isArray(output) || !("keywords" in output)
      || !Array.isArray(output.keywords)) return [id, output];
    const keywords = output.keywords.filter(keyword => !ids.has(keyword.id) && !texts.has(keyword.normalisedText));
    return [id, { ...output, keywords,
      ...(id === "clustering" ? { clusterCount: new Set(keywords.map(keyword => keyword.clusterKey)).size } : {}),
    }];
  }));
}
