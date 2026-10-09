import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRepresentativeProjectFixture } from "../../fixtures/src/representative-project.js";
import { PIPELINE_STAGES } from "../src/definition.js";
import { deriveForecastExclusions, forecastEligibilitySummary } from "../src/forecast-eligibility.js";
import { scopeDependencyOutputs } from "../src/forecast-scope.js";
import { executeDataDrivenStage, type KeywordEnrichmentStageData, type SerpCollectionStageData, type RevenueV2StageData } from "../src/stage-handlers.js";

function setup() {
  const fixture = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
  const outputs: Record<string, unknown> = {};
  for (const stage of PIPELINE_STAGES) outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, outputs);
  return { fixture, outputs, enrichment: outputs["keyword-enrichment"] as KeywordEnrichmentStageData,
    serp: outputs["serp-collection"] as SerpCollectionStageData };
}

describe("automatic forecast eligibility", () => {
  it("continues every calculation on the remaining keywords without changing paid results or qualification", () => {
    const { fixture, outputs, enrichment, serp } = setup();
    Object.assign(enrichment.keywords[0]!.enrichment, { avgMonthlyVolume: null, competitiveEligible: false, competitiveEligibilityReason: "missing_volume" });
    const search = serp.keywords.find(row => row.id === enrichment.keywords[1]!.id)!;
    Object.assign(search, { status: "no-result", results: [], features: ["ai_overview"] });
    const saved = structuredClone(outputs);
    const exclusions = deriveForecastExclusions(enrichment, serp);
    expect(exclusions.map(row => row.reason)).toEqual(["missing_volume", "no_organic_results"]);
    for (const stage of PIPELINE_STAGES.slice(18)) {
      outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, scopeDependencyOutputs(stage.id, outputs, null, exclusions));
    }
    for (const stage of PIPELINE_STAGES.slice(0, 18)) expect(outputs[stage.id]).toEqual(saved[stage.id]);
    const revenue = outputs["revenue-v2"] as RevenueV2StageData;
    expect(revenue.keywords).toHaveLength(enrichment.keywords.length - 2);
    expect(revenue.keywords.every(keyword => keyword.scenarios.every(row => Number.isFinite(row.expectedIncrementalAnnual)))).toBe(true);
    expect(revenue.keywords.some(keyword => exclusions.some(excluded => excluded.id === keyword.id))).toBe(false);
    expect(forecastEligibilitySummary(exclusions, enrichment.keywords.length, "2026-10-09T09:00:00Z")).toMatchObject({
      excludedKeywordCount: 2, countsByReason: { missing_volume: 1, no_organic_results: 1 } });
  });

  it("preserves genuine zero volume and blocks an unexplained collection or authority gap", () => {
    const { fixture, outputs, enrichment, serp } = setup();
    Object.assign(enrichment.keywords[0]!.enrichment, { avgMonthlyVolume: 0, competitiveEligible: true, competitiveEligibilityReason: "meets_operator_threshold" });
    Object.assign(serp.keywords[0]!, { status: "missing-provider", results: [] });
    expect(deriveForecastExclusions(enrichment, serp)).toEqual([]);
    expect(() => executeDataDrivenStage("har-readiness", fixture, outputs)).toThrow("fresh_serp_results");
    const original = setup();
    const lps = original.outputs["link-power-score"] as { keywords: Array<{ results: unknown[] }> };
    lps.keywords[0]!.results = [];
    expect(() => executeDataDrivenStage("har-readiness", original.fixture, original.outputs)).toThrow("serp_link_power");
  });

  it("covers inherited empty searches, configured volume thresholds and an empty remaining scope", () => {
    const { fixture, outputs, enrichment, serp } = setup();
    for (const row of serp.keywords) Object.assign(row, { status: "no-result", results: [], sourceKeywordId: serp.keywords[0]!.id });
    Object.assign(enrichment.keywords[0]!.enrichment, { avgMonthlyVolume: 1, competitiveEligible: false, competitiveEligibilityReason: "below_operator_threshold" });
    const exclusions = deriveForecastExclusions(enrichment, serp);
    expect(exclusions).toHaveLength(enrichment.keywords.length);
    expect(exclusions[0]!.reason).toBe("below_operator_threshold");
    expect(exclusions.every(row => row.sourceKeywordId === serp.keywords[0]!.id)).toBe(true);
    expect(() => executeDataDrivenStage("har-readiness", fixture, scopeDependencyOutputs("har-readiness", outputs, null, exclusions))).toThrow("kept_keywords");
    expect(scopeDependencyOutputs("detox", outputs, null, exclusions)).toBe(outputs);
  });
});
