import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseRepresentativeProjectFixture, normaliseKeyword } from "../../fixtures/src/representative-project.js";
import { PIPELINE_STAGES, type PipelineStageId } from "../src/definition.js";
import { forecastScope, scopeDependencyOutputs, type ForecastScope } from "../src/forecast-scope.js";
import { executeDataDrivenStage, type ClusteringStageData, type RevenueV2StageData } from "../src/stage-handlers.js";

const raw = JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8"));

function setup() {
  const source = parseRepresentativeProjectFixture(raw);
  const outputs: Record<string, unknown> = {};
  for (const stage of PIPELINE_STAGES) outputs[stage.id] = executeDataDrivenStage(stage.id, source, outputs);
  const cluster = outputs.clustering as ClusteringStageData;
  const canonical = cluster.keywords.find(keyword => keyword.normalisedText === "buy 55 inch oled tv")!;
  const member = cluster.keywords.find(keyword => keyword.normalisedText === "best 4k television")!;
  Object.assign(member, { canonicalKeywordId: canonical.id, clusterKey: canonical.clusterKey, isCanonical: false });
  source.providerInputs.serpKeywords = source.providerInputs.serpKeywords.filter(keyword => normaliseKeyword(keyword.text) !== canonical.normalisedText);
  const scope: ForecastScope = { reason: "dataforseo_no_results", approvedBy: "00000000-0000-4000-8000-000000000001",
    approvedAt: "2026-10-08T13:00:00Z", queries: [canonical.normalisedText],
    keywords: [canonical, member].map(keyword => ({ id: keyword.id, normalisedText: keyword.normalisedText, sourceKeywordId: canonical.id })) };
  return { source, outputs, scope, canonical, member };
}

const downstream: PipelineStageId[] = ["serp-collection", "authority", "backlinks", "site-architecture", "link-power-score",
  "har-readiness", "har-v2", "revenue-readiness", "revenue-v2", "calibration", "rollup-output"];

describe("explicit forecast scope", () => {
  it("completes forecasts for the remaining scope without changing saved classification or creating excluded forecasts", () => {
    const { source, outputs, scope } = setup();
    const saved = structuredClone(Object.fromEntries(["detox", "categorisation", "ranking-url", "clustering", "demand-signals", "ctr-curves"]
      .map(id => [id, outputs[id]])));
    for (const stage of downstream) outputs[stage] = executeDataDrivenStage(stage, source, scopeDependencyOutputs(stage, outputs, scope));
    for (const [id, output] of Object.entries(saved)) expect(outputs[id]).toEqual(output);
    const revenue = outputs["revenue-v2"] as RevenueV2StageData;
    expect(revenue.keywords.length).toBeGreaterThan(0);
    for (const keyword of scope.keywords) expect(revenue.keywords.some(row => row.id === keyword.id)).toBe(false);
    expect(revenue.keywords.every(keyword => keyword.scenarios.length === 3
      && keyword.scenarios.every(scenario => Number.isFinite(scenario.expectedIncrementalAnnual)))).toBe(true);
    expect(outputs["rollup-output"]).toBeDefined();
  });

  it("keeps missing SERPs blocked without approval and when another cluster member is missing", () => {
    const { source, outputs, scope } = setup();
    for (const stage of ["serp-collection", "authority", "backlinks", "site-architecture", "link-power-score"] as const) {
      outputs[stage] = executeDataDrivenStage(stage, source, outputs);
    }
    expect(() => executeDataDrivenStage("har-readiness", source, outputs)).toThrow("fresh_serp_results");
    const incomplete = { ...scope, keywords: scope.keywords.slice(0, 1) };
    expect(() => executeDataDrivenStage("har-readiness", source, scopeDependencyOutputs("har-readiness", outputs, incomplete)))
      .toThrow("fresh_serp_results");
  });

  it("does not change qualification inputs and rejects malformed approval records", () => {
    const { outputs, scope } = setup();
    expect(scopeDependencyOutputs("detox", outputs, scope)).toBe(outputs);
    expect(forecastScope({ forecastScope: scope })).toEqual(scope);
    expect(forecastScope({})).toBeNull();
    expect(() => forecastScope({ forecastScope: { ...scope, approvedBy: "unknown" } })).toThrow("invalid");
    expect(() => forecastScope({ forecastScope: { ...scope, keywords: [scope.keywords[0], scope.keywords[0]] } })).toThrow("invalid");
  });
});
