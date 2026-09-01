import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseRepresentativeProjectFixture,
  type ProjectPipelineSource,
} from "../../fixtures/src/representative-project.js";
import { PIPELINE_STAGES, type PipelineStageId } from "../src/definition.js";
import {
  executeDataDrivenStage,
  type ClusteringStageData,
  type CalibrationStageData,
  type CtrCurvesStageData,
  type DemandSignalsStageData,
  type DetoxStageData,
  type GscPromotionStageData,
  type IntakeStageData,
  type KeywordEnrichmentStageData,
  type LinkPowerScoreStageData,
  type PreflightStageData,
  type RevenueV2StageData,
  type RollupOutputStageData,
  type SerpCollectionStageData,
  type SiteArchitectureStageData,
} from "../src/stage-handlers.js";

const fixtureUrl = new URL("../../../fixtures/representative-project.json", import.meta.url);
const rawFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

function execute(
  fixture: ProjectPipelineSource,
  through: PipelineStageId = "rollup-output",
): Partial<Record<PipelineStageId, unknown>> {
  const outputs: Partial<Record<PipelineStageId, unknown>> = {};
  for (const stage of PIPELINE_STAGES) {
    const dependencies = Object.fromEntries(
      stage.dependencies.map((dependency) => [dependency, outputs[dependency]]),
    );
    outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, dependencies);
    if (stage.id === through) break;
  }
  return outputs;
}

describe("autonomous pipeline acceptance contract", () => {
  it("fails before paid work when a hard configuration gate is missing", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    fixture.client.brandTerms = [];
    fixture.rules.ownBrands = [];
    const intake = executeDataDrivenStage("intake", fixture, {}) as IntakeStageData;
    const promotion = executeDataDrivenStage("gsc-promotion", fixture, {
      intake,
    }) as GscPromotionStageData;
    const detox = executeDataDrivenStage("detox", fixture, {
      "gsc-promotion": promotion,
    }) as DetoxStageData;

    expect(() =>
      executeDataDrivenStage("preflight", fixture, { detox }),
    ).toThrow("explicit_brand_terms");
  });

  it("applies operator thresholds without overwriting positive manual volume", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    fixture.project.policy = {
      competitiveEnrichmentVolumeFloor: 2000,
      gscPromotionImpressionsFloor: 500,
      reviewedAt: "2026-08-13T00:00:00.000Z",
    };
    fixture.providerInputs.keywords.push({
      avgMonthlyVolume: 0,
      coreKeyword: "northstar tv",
      intent: "transactional",
      keywordDifficulty: 30,
      monthlyVolumes: [],
      rank: 3,
      rankingUrl: "https://northstar-home.test/televisions/northstar",
      text: "northstar tv deals",
    });
    const outputs = execute(fixture, "keyword-enrichment");
    const promotion = outputs["gsc-promotion"] as GscPromotionStageData;
    const preflight = outputs.preflight as PreflightStageData;
    const enrichment = outputs["keyword-enrichment"] as KeywordEnrichmentStageData;
    const keyword = enrichment.keywords.find(
      (item) => item.normalisedText === "northstar tv deals",
    );

    expect(promotion.impressionsFloor).toBe(500);
    expect(promotion.excludedBelowFloorCount).toBeGreaterThan(0);
    expect(preflight.policy.competitiveEnrichmentVolumeFloor).toBe(2000);
    expect(keyword?.enrichment).toMatchObject({
      avgMonthlyVolume: 1600,
      competitiveEligible: false,
      volumeSource: "manual",
    });
  });

  it("fetches SERP data once per cluster, keeps content-fit null semantics and emits monotone CTR curves", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const outputs = execute(fixture);
    const clusters = outputs.clustering as ClusteringStageData;
    const serp = outputs["serp-collection"] as SerpCollectionStageData;
    const site = outputs["site-architecture"] as SiteArchitectureStageData;
    const ctr = outputs["ctr-curves"] as CtrCurvesStageData;

    expect(serp.clusterFetchCount).toBe(clusters.clusterCount);
    expect(serp.clusterFetchCount).toBeLessThanOrEqual(serp.keywords.length);
    expect(
      site.keywords
        .filter((keyword) => keyword.status === "missing-provider")
        .every((keyword) => keyword.relevancyScore === null),
    ).toBe(true);
    expect(ctr.curves.every((curve) => curve.isBranded === false)).toBe(true);
    expect(
      ctr.curves.every((curve) =>
        curve.points.every(
          (point, index) => index === 0 || point.ctr <= curve.points[index - 1]!.ctr,
        ),
      ),
    ).toBe(true);
  });

  it("builds CTR curves for all-device GSC exports", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    fixture.gscRows = fixture.gscRows.map((row) => ({
      ...row,
      device: "all",
    }));
    const outputs = execute(fixture, "ctr-curves");
    const ctr = outputs["ctr-curves"] as CtrCurvesStageData;

    expect(ctr.curves.length).toBeGreaterThan(0);
    expect(ctr.curves.every((curve) => curve.device === "all")).toBe(true);
  });

  it("uses Revenue-only SERP visibility and returns a defensible deduplicated rollup", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const serpKeyword = fixture.providerInputs.serpKeywords.find(
      (keyword) => keyword.text === "buy 55 inch oled tv",
    );
    if (!serpKeyword) throw new Error("Representative SERP keyword is missing.");
    serpKeyword.features = ["ai_overview"];
    const outputs = execute(fixture);
    const revenue = outputs["revenue-v2"] as RevenueV2StageData;
    const rollup = outputs["rollup-output"] as RollupOutputStageData;
    const keyword = revenue.keywords.find(
      (item) => item.normalisedText === "buy 55 inch oled tv",
    );

    expect(keyword?.scenarios[0]?.serpVisibilityMultiplierUsed).toBe(0.86);
    expect(
      rollup.scenarios.every(
        (scenario) =>
          scenario.clusterDedupedExpectedIncrementalAnnual <=
          scenario.naiveExpectedIncrementalAnnual,
      ),
    ).toBe(true);
    expect(
      rollup.scenarios.every(
        (scenario) =>
          scenario.doubleCountAnnual ===
          scenario.naiveExpectedIncrementalAnnual -
            scenario.clusterDedupedExpectedIncrementalAnnual,
      ),
    ).toBe(true);
  });

  it("processes demand and LPS for more than 5,000 kept keywords without truncation", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    fixture.gscRows = [];
    fixture.keywords = Array.from({ length: 5_101 }, (_, index) => ({
      avgMonthlyVolume: 100 + index,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      keywordDifficulty: 20,
      rankingUrl: null,
      text: `television model ${index}`,
    }));
    fixture.providerInputs.keywords = [];
    fixture.providerInputs.serpKeywords = fixture.keywords.map((keyword, index) => ({
      results: [
        {
          ahrefsRank: 100_000 + index,
          backlinks: 500 + index,
          domain: "scale-competitor.test",
          domainRating: 45,
          rankAbsolute: 1,
          referringDomains: 100 + (index % 1_000),
          url: `https://scale-competitor.test/tv-model-${index}`,
          urlRating: 35,
        },
      ],
      text: keyword.text,
    }));
    fixture.providerInputs.siteArchitectureKeywords = [];

    const outputs = execute(fixture, "demand-signals");
    const enrichment = outputs["keyword-enrichment"] as KeywordEnrichmentStageData;
    const clustering = outputs.clustering as ClusteringStageData;
    const lps = outputs["link-power-score"] as LinkPowerScoreStageData;
    const demand = outputs["demand-signals"] as DemandSignalsStageData;

    expect(enrichment.keywords).toHaveLength(5_101);
    expect(clustering.keywords).toHaveLength(5_101);
    expect(lps.keywords).toHaveLength(5_101);
    expect(lps.resultCount).toBe(5_101);
    expect(demand.keywords).toHaveLength(5_101);
  });

  it("completes a manual-only project with fallback CTR and an explicit unavailable calibration", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    fixture.gscRows = [];
    const outputs = execute(fixture);
    const ctr = outputs["ctr-curves"] as CtrCurvesStageData;
    const calibration = outputs.calibration as CalibrationStageData;

    expect(ctr.curves).toHaveLength(0);
    expect(calibration.status).toBe("unavailable");
    expect(calibration.unavailableReason).toBe(
      "calibration_unavailable_no_gsc",
    );
  });
});
