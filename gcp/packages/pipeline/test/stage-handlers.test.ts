import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  normaliseKeyword,
  parseRepresentativeProjectFixture,
} from "../../fixtures/src/representative-project.js";
import {
  executeDataDrivenStage,
  type AuthorityStageData,
  type BacklinksStageData,
  type BrandClassificationStageData,
  type CalibrationStageData,
  type CategorisationStageData,
  type ClusteringStageData,
  type CtrCurvesStageData,
  type DemandSignalsStageData,
  type DetoxStageData,
  type GscPromotionStageData,
  type GscIntentStageData,
  type HarV2StageData,
  type IntakeStageData,
  type KeywordEnrichmentStageData,
  type LinkPowerScoreStageData,
  type RankingUrlStageData,
  type RevenueV2StageData,
  type SerpCollectionStageData,
  type SiteArchitectureStageData,
} from "../src/stage-handlers.js";

const fixtureUrl = new URL("../../../fixtures/representative-project.json", import.meta.url);
const rawFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

function executeRepresentativeStages() {
  const fixture = parseRepresentativeProjectFixture(rawFixture);
  const intake = executeDataDrivenStage("intake", fixture, {}) as IntakeStageData;
  const promotion = executeDataDrivenStage("gsc-promotion", fixture, {
    intake,
  }) as GscPromotionStageData;
  const detox = executeDataDrivenStage("detox", fixture, {
    "gsc-promotion": promotion,
  }) as DetoxStageData;
  const categorisation = executeDataDrivenStage("categorisation", fixture, {
    detox,
  }) as CategorisationStageData;
  const enrichment = executeDataDrivenStage("keyword-enrichment", fixture, {
    categorisation,
  }) as KeywordEnrichmentStageData;
  const ranking = executeDataDrivenStage("ranking-url", fixture, {
    categorisation,
  }) as RankingUrlStageData;
  const gscIntent = executeDataDrivenStage("gsc-intent", fixture, {
    categorisation,
  }) as GscIntentStageData;
  const brandClassification = executeDataDrivenStage(
    "brand-classification",
    fixture,
    { "gsc-promotion": promotion },
  ) as BrandClassificationStageData;
  const serpCollection = executeDataDrivenStage("serp-collection", fixture, {
    "keyword-enrichment": enrichment,
  }) as SerpCollectionStageData;
  const authority = executeDataDrivenStage("authority", fixture, {
    "serp-collection": serpCollection,
  }) as AuthorityStageData;
  const backlinks = executeDataDrivenStage("backlinks", fixture, {
    authority,
  }) as BacklinksStageData;
  const siteArchitecture = executeDataDrivenStage("site-architecture", fixture, {
    "keyword-enrichment": enrichment,
    "ranking-url": ranking,
  }) as SiteArchitectureStageData;
  const linkPowerScore = executeDataDrivenStage("link-power-score", fixture, {
    authority,
    backlinks,
  }) as LinkPowerScoreStageData;
  const demandSignals = executeDataDrivenStage("demand-signals", fixture, {
    "keyword-enrichment": enrichment,
  }) as DemandSignalsStageData;
  const ctrCurves = executeDataDrivenStage("ctr-curves", fixture, {
    "brand-classification": brandClassification,
    "gsc-intent": gscIntent,
  }) as CtrCurvesStageData;
  const clustering = executeDataDrivenStage("clustering", fixture, {
    "keyword-enrichment": enrichment,
    "serp-collection": serpCollection,
  }) as ClusteringStageData;
  const har = executeDataDrivenStage("har-v2", fixture, {
    "brand-classification": brandClassification,
    clustering,
    "keyword-enrichment": enrichment,
    "link-power-score": linkPowerScore,
    "ranking-url": ranking,
    "serp-collection": serpCollection,
    "site-architecture": siteArchitecture,
  }) as HarV2StageData;
  const revenue = executeDataDrivenStage("revenue-v2", fixture, {
    categorisation,
    "ctr-curves": ctrCurves,
    "demand-signals": demandSignals,
    "har-v2": har,
    "ranking-url": ranking,
  }) as RevenueV2StageData;
  const calibration = executeDataDrivenStage("calibration", fixture, {
    "revenue-v2": revenue,
  }) as CalibrationStageData;
  return {
    authority,
    backlinks,
    brandClassification,
    calibration,
    categorisation,
    clustering,
    ctrCurves,
    demandSignals,
    detox,
    enrichment,
    fixture,
    gscIntent,
    har,
    intake,
    linkPowerScore,
    promotion,
    ranking,
    revenue,
    serpCollection,
    siteArchitecture,
  };
}

describe("data-driven pipeline handlers", () => {
  it("normalises intake and promotes only GSC-only queries", () => {
    const { intake, promotion } = executeRepresentativeStages();

    expect(intake.sourceKeywordCount).toBe(12);
    expect(promotion.processingKeywordCount).toBe(14);
    expect(promotion.promotedQueries).toEqual(["55 inch smart tv", "oled tv offers"]);

    const northstar = promotion.keywords.find(
      (keyword) => keyword.normalisedText === "northstar tv deals",
    );
    expect(northstar?.gsc).toMatchObject({
      clicks: 119,
      devices: ["desktop", "mobile"],
      impressions: 1750,
    });
    expect(northstar?.sources).toEqual(["source", "gsc"]);

    const repair = promotion.keywords.find(
      (keyword) => keyword.normalisedText === "tv repair near me",
    );
    expect(repair?.rankingUrl).toBe("https://northstar-home.test/services/tv-repair");
    expect(
      promotion.keywords.find(
        (keyword) => keyword.normalisedText === "currys tv deals",
      )?.rankingUrl,
    ).toBeNull();
  });

  it("computes detox, intent, tier and category outcomes from source data", () => {
    const { categorisation, detox, fixture } = executeRepresentativeStages();
    const categorised = new Map(
      categorisation.keywords.map((keyword) => [keyword.normalisedText, keyword]),
    );
    const actual = detox.keywords
      .map((keyword) => {
        const classification = categorised.get(keyword.normalisedText)?.categorisation;
        return {
          category: classification?.category ?? null,
          detoxDecision: keyword.detox.decision,
          intent: classification?.intent ?? null,
          text: keyword.normalisedText,
          tier: classification?.tier ?? null,
        };
      })
      .sort((left, right) => left.text.localeCompare(right.text));
    const expected = fixture.expected.keywordOutcomes
      .map((outcome) => ({
        ...outcome,
        text: normaliseKeyword(outcome.text),
      }))
      .sort((left, right) => left.text.localeCompare(right.text));

    expect(actual).toEqual(expected);
    expect(categorisation.summary).toEqual(fixture.expected.summary);
  });

  it("applies whitelist precedence before competitor removal", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const intake = executeDataDrivenStage("intake", fixture, {}) as IntakeStageData;
    const promotion = executeDataDrivenStage("gsc-promotion", fixture, {
      intake,
    }) as GscPromotionStageData;
    const withoutCompetitorException = {
      ...fixture,
      rules: {
        ...fixture.rules,
        whitelist: fixture.rules.whitelist.filter(
          (value) => normaliseKeyword(value) !== "currys tv deals",
        ),
      },
    };
    const detox = executeDataDrivenStage("detox", withoutCompetitorException, {
      "gsc-promotion": promotion,
    }) as DetoxStageData;

    expect(
      detox.keywords.find((keyword) => keyword.normalisedText === "currys tv deals")
        ?.detox,
    ).toMatchObject({ decision: "remove", rule: "competitor" });
  });

  it("uses explicit local provider inputs for enrichment and ranking", () => {
    const { enrichment, gscIntent, ranking } = executeRepresentativeStages();
    const smartTv = enrichment.keywords.find(
      (keyword) => keyword.normalisedText === "55 inch smart tv",
    );

    expect(smartTv?.enrichment).toMatchObject({
      avgMonthlyVolume: 5400,
      keywordDifficulty: 43,
      source: "local-provider",
    });
    expect(enrichment.enrichedKeywordCount).toBe(12);
    expect(enrichment.missingProviderCount).toBe(0);
    expect(ranking).toMatchObject({
      existingCount: 11,
      matchedCount: 1,
      noMatchCount: 0,
    });
    expect(gscIntent.resolvedCount).toBe(8);
    expect(gscIntent.genericCount).toBe(0);
  });

  it("classifies brand queries and builds the SERP authority branch", () => {
    const {
      authority,
      backlinks,
      brandClassification,
      serpCollection,
    } = executeRepresentativeStages();

    expect(brandClassification).toMatchObject({
      brandedCount: 1,
      nonBrandedCount: 13,
    });
    expect(
      brandClassification.keywords.find(
        (keyword) => keyword.normalisedText === "northstar tv deals",
      ),
    ).toMatchObject({
      confidence: 0.95,
      isBranded: true,
      matchedTerm: "northstar",
      source: "explicit-rule",
    });
    expect(serpCollection).toMatchObject({
      matchedKeywordCount: 4,
      missingProviderCount: 8,
      noResultCount: 0,
      resultCount: 12,
    });
    expect(authority).toMatchObject({
      clientResultCount: 4,
      resultCount: 12,
      authority: {
        backlinks: 18420,
        domain: "northstar-home.test",
        domainRating: 47,
        referringDomains: 1380,
      },
    });
    expect(backlinks).toMatchObject({
      enrichedResultCount: 12,
      missingResultCount: 0,
      resultCount: 12,
    });
  });

  it("computes site, power, demand, CTR and cluster outputs", () => {
    const {
      clustering,
      ctrCurves,
      demandSignals,
      linkPowerScore,
      siteArchitecture,
    } = executeRepresentativeStages();

    expect(siteArchitecture).toMatchObject({
      matchedCount: 5,
      missingProviderCount: 7,
    });
    expect(
      siteArchitecture.keywords.find(
        (keyword) => keyword.normalisedText === "55 inch smart tv",
      ),
    ).toMatchObject({
      contentStatus: "red",
      matchedUrl: null,
      relevancyScore: 0,
      tacticalStatus: "create_content",
    });
    expect(linkPowerScore).toMatchObject({
      resultCount: 12,
      scoredResultCount: 12,
    });
    expect(
      linkPowerScore.keywords
        .flatMap((keyword) => keyword.results)
        .every((result) => result.score >= 0 && result.score <= 100),
    ).toBe(true);
    expect(demandSignals).toMatchObject({
      sufficientHistoryCount: 2,
      warningCount: 10,
    });
    expect(
      demandSignals.keywords.find(
        (keyword) => keyword.normalisedText === "55 inch smart tv",
      ),
    ).toMatchObject({
      coverageMonths: 12,
      demandWarning: false,
    });
    expect(ctrCurves.curves.length).toBeGreaterThan(0);
    expect(ctrCurves.curves.every((curve) => curve.points.length === 20)).toBe(
      true,
    );
    expect(ctrCurves.observedPointCount).toBeGreaterThan(0);
    expect(clustering.clusterCount).toBeGreaterThan(0);
    expect(
      clustering.keywords.filter((keyword) => keyword.isCanonical).length,
    ).toBe(clustering.clusterCount);
  });

  it("computes HAR, Revenue and calibration outputs", () => {
    const { calibration, har, revenue } = executeRepresentativeStages();

    expect(har).toMatchObject({
      handlerVersion: "har-v2.1",
      modelVersion: "har_v2.1.0",
      scenarioCount: 36,
    });
    expect(har.keywords.every((keyword) => keyword.scenarios.length === 3)).toBe(
      true,
    );
    expect(revenue).toMatchObject({
      forecastCount: 36,
      handlerVersion: "revenue-v2.1",
      modelVersion: "revenue_v2.1.0",
    });
    expect(
      revenue.keywords
        .flatMap((keyword) => keyword.scenarios)
        .some((scenario) => scenario.currentRevenueAnnual !== null),
    ).toBe(true);
    expect(calibration).toMatchObject({
      handlerVersion: "calibration-v1",
      modelVersion: "calibration_v1.0.0",
    });
    expect(calibration.keywords.length).toBeGreaterThan(0);
    expect(calibration.matched).toBeGreaterThan(0);
    expect(["green", "amber", "red"]).toContain(calibration.status);
  });

  it("applies conversion overrides by URL, category, intent, then project", () => {
    const {
      categorisation,
      ctrCurves,
      demandSignals,
      fixture,
      har,
      ranking,
    } = executeRepresentativeStages();
    const rankedKeyword = ranking.keywords.find(
      (keyword) => keyword.rankingUrl !== null,
    );
    expect(rankedKeyword).toBeDefined();
    const harKeyword = har.keywords.find(
      (keyword) => keyword.id === rankedKeyword?.id,
    );
    const category = categorisation.keywords.find(
      (keyword) => keyword.id === rankedKeyword?.id,
    )?.categorisation.category;
    expect(harKeyword).toBeDefined();
    expect(category).toBeDefined();

    fixture.conversionOverrides = [
      {
        averageOrderValue: 10,
        conversionRate: 0.01,
        id: "00000000-0000-4000-8000-000000000001",
        scopeType: "project",
        scopeValue: null,
      },
      {
        averageOrderValue: 20,
        conversionRate: 0.02,
        id: "00000000-0000-4000-8000-000000000002",
        scopeType: "intent",
        scopeValue: harKeyword?.intent.toUpperCase() ?? "",
      },
      {
        averageOrderValue: 30,
        conversionRate: null,
        id: "00000000-0000-4000-8000-000000000003",
        scopeType: "category",
        scopeValue: `  ${category?.toUpperCase()}  `,
      },
      {
        averageOrderValue: null,
        conversionRate: 0.04,
        id: "00000000-0000-4000-8000-000000000004",
        scopeType: "url",
        scopeValue: `${rankedKeyword?.rankingUrl}/`,
      },
    ];

    const revenue = executeDataDrivenStage("revenue-v2", fixture, {
      categorisation,
      "ctr-curves": ctrCurves,
      "demand-signals": demandSignals,
      "har-v2": har,
      "ranking-url": ranking,
    }) as RevenueV2StageData;
    const scenario = revenue.keywords.find(
      (keyword) => keyword.id === rankedKeyword?.id,
    )?.scenarios[0];

    expect(scenario).toMatchObject({
      averageOrderValueOverrideId:
        "00000000-0000-4000-8000-000000000003",
      averageOrderValueUsed: 30,
      conversionRateOverrideId: "00000000-0000-4000-8000-000000000004",
      conversionRateUsed: 0.04,
    });
  });

  it("fails closed when a dependency output is malformed", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);

    expect(() =>
      executeDataDrivenStage("detox", fixture, {
        "gsc-promotion": { keywords: [] },
      }),
    ).toThrow("Dependency gsc-promotion does not contain gsc-promotion-v1 output");
  });
});
