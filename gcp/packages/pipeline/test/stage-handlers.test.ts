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
import { PIPELINE_STAGES, type PipelineStageId } from "../src/definition.js";

const fixtureUrl = new URL("../../../fixtures/representative-project.json", import.meta.url);
const rawFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

function executeRepresentativeStages(fixture = parseRepresentativeProjectFixture(rawFixture)) {
  const outputs: Partial<Record<PipelineStageId, unknown>> = {};
  for (const stage of PIPELINE_STAGES) {
    const dependencies = Object.fromEntries(
      stage.dependencies.map((dependency) => [dependency, outputs[dependency]]),
    );
    outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, dependencies);
  }
  const intake = outputs.intake as IntakeStageData;
  const promotion = outputs["gsc-promotion"] as GscPromotionStageData;
  const detox = outputs.detox as DetoxStageData;
  const categorisation = outputs.categorisation as CategorisationStageData;
  const enrichment = outputs["keyword-enrichment"] as KeywordEnrichmentStageData;
  const ranking = outputs["ranking-url"] as RankingUrlStageData;
  const gscIntent = outputs["gsc-intent"] as GscIntentStageData;
  const brandClassification = outputs["brand-classification"] as BrandClassificationStageData;
  const serpCollection = outputs["serp-collection"] as SerpCollectionStageData;
  const authority = outputs.authority as AuthorityStageData;
  const backlinks = outputs.backlinks as BacklinksStageData;
  const siteArchitecture = outputs["site-architecture"] as SiteArchitectureStageData;
  const linkPowerScore = outputs["link-power-score"] as LinkPowerScoreStageData;
  const demandSignals = outputs["demand-signals"] as DemandSignalsStageData;
  const ctrCurves = outputs["ctr-curves"] as CtrCurvesStageData;
  const clustering = outputs.clustering as ClusteringStageData;
  const har = outputs["har-v2"] as HarV2StageData;
  const revenue = outputs["revenue-v2"] as RevenueV2StageData;
  const calibration = outputs.calibration as CalibrationStageData;
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
    outputs,
    promotion,
    ranking,
    revenue,
    serpCollection,
    siteArchitecture,
  };
}

describe("data-driven pipeline handlers", () => {
  it.each(["absent", "conflicting"])("inherits canonical authority through HAR and Revenue when member metrics are %s", (memberMetrics) => {
    const { fixture, outputs, clustering } = executeRepresentativeStages();
    const canonical = clustering.keywords.find((row) => row.normalisedText === "buy 55 inch oled tv")!;
    const member = clustering.keywords.find((row) => row.normalisedText === "best 4k television")!;
    Object.assign(member, { canonicalKeywordId: canonical.id, clusterKey: canonical.clusterKey, isCanonical: false });
    const provider = fixture.providerInputs.serpKeywords.find((row) => row.text === canonical.normalisedText)!;
    for (const row of provider.results) {
      row.metricSource = "dataforseo";
      row.authorityScope = "page";
    }
    const client = provider.results.find((row) => row.domain === fixture.client.domain)!;
    Object.assign(client, { urlRating: 0, domainRating: 67, referringDomains: 0, backlinks: 0 });
    fixture.providerInputs.serpKeywords = fixture.providerInputs.serpKeywords.filter((row) => row.text !== member.normalisedText);
    if (memberMetrics === "conflicting") {
      fixture.providerInputs.serpKeywords.push({ ...provider, text: member.normalisedText,
        results: provider.results.map((row) => ({ ...row, urlRating: 100, domainRating: 100 })) });
    }
    for (const stageId of ["serp-collection", "authority", "backlinks", "link-power-score", "har-readiness",
      "har-v2", "revenue-readiness", "revenue-v2", "calibration", "rollup-output"] as const) {
      outputs[stageId] = executeDataDrivenStage(stageId, fixture, outputs);
    }
    const serp = outputs["serp-collection"] as SerpCollectionStageData;
    expect(serp.keywords.find((row) => row.id === member.id)?.sourceKeywordId).toBe(canonical.id);
    const lps = outputs["link-power-score"] as LinkPowerScoreStageData;
    const canonicalScores = lps.keywords.find((row) => row.id === canonical.id)!.results;
    const memberScores = lps.keywords.find((row) => row.id === member.id)!.results;
    expect(memberScores).toEqual(canonicalScores);
    expect(memberScores.find((row) => row.isClientDomain)).toMatchObject({ score: 20.1,
      urlRating: 0, domainRating: 67, referringDomains: 0, backlinks: 0, metricSource: "dataforseo", authorityScope: "page" });
    expect(lps.scoredResultCount).toBe(lps.resultCount);
    const har = outputs["har-v2"] as HarV2StageData;
    for (const scenario of har.keywords.find((row) => row.id === member.id)!.scenarios) {
      expect(scenario.linkPowerScore).toBe(20.1);
      expect(scenario.explanation.inputs).toMatchObject({ client_lps_source: "serp_row", client_ur: 0 });
    }
    const revenue = outputs["revenue-v2"] as RevenueV2StageData;
    expect(revenue.keywords.find((row) => row.id === member.id)!.scenarios).toHaveLength(3);
    expect(outputs["rollup-output"]).toBeDefined();
  });

  it.each(["missing-keyword", "missing-row", "missing-client-metrics", "missing-competitor-metrics",
    "wrong-url", "wrong-rank", "non-finite-score", "invalid-metric", "missing-provenance"])(
    "rejects %s authority at readiness and HAR even with healthy aggregate counts", (mode) => {
      const { fixture, outputs, linkPowerScore } = executeRepresentativeStages();
      const broken = structuredClone(linkPowerScore);
      const keyword = broken.keywords.find((row) => row.normalisedText === "buy 55 inch oled tv")!;
      const row = keyword.results.find((result) => mode === "missing-client-metrics" ? result.isClientDomain : !result.isClientDomain)!;
      if (mode === "missing-keyword") broken.keywords = broken.keywords.filter((item) => item.id !== keyword.id);
      else if (mode === "missing-row") keyword.results.pop();
      else if (mode === "wrong-url") row.url = "https://unrelated.test/page";
      else if (mode === "wrong-rank") row.rankAbsolute = 100;
      else if (mode === "non-finite-score") row.score = NaN;
      else if (mode === "invalid-metric") row.backlinks = -1;
      else if (mode === "missing-provenance") row.metricSource = "missing-provider";
      else Object.assign(row, { urlRating: null, domainRating: null, referringDomains: null, backlinks: null,
        ahrefsRank: 100, score: 0 });
      for (const stage of ["har-readiness", "har-v2"] as const) {
        expect(() => executeDataDrivenStage(stage, fixture, { ...outputs, "link-power-score": broken }))
          .toThrow("serp_link_power");
      }
    },
  );

  it("keeps measured zeros and declared partial domain fallback metrics usable", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    for (const keyword of fixture.providerInputs.serpKeywords) {
      keyword.results.forEach((row, index) => Object.assign(row, { metricSource: "dataforseo",
        authorityScope: index === 0 ? "page" : "domain_fallback", urlRating: index === 0 ? 0 : null,
        domainRating: 0, referringDomains: 0, backlinks: 0 }));
    }
    const { linkPowerScore, har } = executeRepresentativeStages(fixture);
    expect(linkPowerScore.scoredResultCount).toBe(linkPowerScore.resultCount);
    expect(linkPowerScore.keywords.flatMap((row) => row.results).every((row) => row.score === 0)).toBe(true);
    expect(linkPowerScore.keywords.flatMap((row) => row.results).filter((row) => row.authorityScope === "domain_fallback")
      .every((row) => row.confidence === "low")).toBe(true);
    expect(har.scenarioCount).toBe(36);
  });

  it("uses period-normalised GSC impressions only for absent volume and retains the evidence", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const provider = fixture.providerInputs.keywords.find(row => row.text === "55 inch smart tv")!;
    provider.avgMonthlyVolume = null;
    provider.monthlyVolumes = Array.from({ length: 12 }, (_, index) => ({ month: `2025-${String(index + 1).padStart(2, "0")}-01`, volume: 0 }));
    fixture.economics = { ...fixture.economics, gscWindowDays: 365, gscDateRangeStart: "2025-01-01", gscDateRangeEnd: "2025-12-31" };
    const { enrichment, demandSignals, har, revenue } = executeRepresentativeStages(fixture);
    const keyword = enrichment.keywords.find(row => row.normalisedText === "55 inch smart tv")!;
    const expected = Math.floor(keyword.gsc!.impressions / 12);
    expect(keyword.enrichment).toMatchObject({ avgMonthlyVolume: expected, competitiveEligible: true,
      volumeSource: "gsc_impressions", volumeEstimate: { impressions: keyword.gsc!.impressions, windowDays: 365,
        dateRangeStart: "2025-01-01", dateRangeEnd: "2025-12-31", monthlyEstimate: expected } });
    expect(demandSignals.keywords.find(row => row.id === keyword.id)).toMatchObject({ monthlyVolumes: [], coverageMonths: 0,
      demandWarning: true, demandWarningReason: "gsc_impressions_estimate", trendConfidence: "low" });
    expect(provider.monthlyVolumes).toHaveLength(12);
    for (const scenario of har.keywords.find(row => row.id === keyword.id)!.scenarios) {
      expect(scenario.explanation).toMatchObject({ volumeSource: "gsc_impressions", volumeEstimate: { monthlyEstimate: expected } });
    }
    for (const scenario of revenue.keywords.find(row => row.id === keyword.id)!.scenarios) {
      expect(scenario.annualVolume).toBe(expected * 12);
      expect(scenario.factorApplied).toBe(1);
      expect(scenario.warnings).toContain("gsc_impressions_estimate");
      expect(scenario.expectedIncrementalAnnual).not.toBeNull();
    }
  });

  it.each(["provider", "manual"] as const)("preserves verified %s zero volumes instead of estimating", (source) => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const target = "northstar tv deals";
    const keyword = fixture.keywords.find(row => row.text === target)!;
    keyword.avgMonthlyVolume = source === "manual" ? 0 : null;
    keyword.volumeSource = source === "manual" ? "manual" : null;
    const provider = fixture.providerInputs.keywords.find(row => row.text === target);
    if (provider) provider.avgMonthlyVolume = source === "provider" ? 0 : 100;
    else fixture.providerInputs.keywords.push({ text: target, avgMonthlyVolume: 0, intent: null, keywordDifficulty: null, monthlyVolumes: [], rank: null, rankingUrl: null });
    const result = executeRepresentativeStages(fixture).enrichment.keywords.find(row => row.normalisedText === target)!;
    expect(result.enrichment).toMatchObject({ avgMonthlyVolume: 0, volumeSource: source, volumeEstimate: null });
  });

  it("replaces old estimates with provider volume and recalculates them when GSC changes", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const target = fixture.keywords.find(row => row.text === "currys tv deals")!;
    target.avgMonthlyVolume = 123;
    target.volumeSource = "gsc_impressions";
    fixture.gscRows.push({ query: target.text, impressions: 1200, clicks: 20, ctr: 20 / 1200,
      device: "all", page: target.rankingUrl ?? "", position: 14 });
    const provider = fixture.providerInputs.keywords.find(row => row.text === target.text)!;
    provider.avgMonthlyVolume = 250;
    expect(executeRepresentativeStages(fixture).enrichment.keywords.find(row => row.id === target.id)?.enrichment)
      .toMatchObject({ avgMonthlyVolume: 250, volumeSource: "provider", volumeEstimate: null });
    provider.avgMonthlyVolume = null;
    fixture.economics.gscWindowDays = 365;
    const result = executeRepresentativeStages(fixture).enrichment.keywords.find(row => row.id === target.id)!;
    expect(result.enrichment.avgMonthlyVolume).toBe(Math.floor(result.gsc!.impressions / 12));
    expect(result.enrichment.volumeSource).toBe("gsc_impressions");
  });

  it("rejects one missing SERP even when every other keyword has results", () => {
    const { fixture, outputs, serpCollection } = executeRepresentativeStages();
    const incomplete = { ...serpCollection, keywords: serpCollection.keywords.slice(1) };
    expect(() => executeDataDrivenStage("har-readiness", fixture, { ...outputs, "serp-collection": incomplete }))
      .toThrow("fresh_serp_results");
  });

  it("rejects absent volume and HAR outcomes before revenue runs", () => {
    const { fixture, outputs, demandSignals, har } = executeRepresentativeStages();
    const demand = { ...demandSignals, keywords: demandSignals.keywords.map((keyword, index) => index === 0
      ? { ...keyword, avgMonthlyVolume: null, monthlyVolumes: [] } : keyword) };
    expect(() => executeDataDrivenStage("revenue-readiness", fixture, { ...outputs, "demand-signals": demand }))
      .toThrow("search_volume");
    const noCompetitors = { ...har, keywords: har.keywords.map((keyword, index) => index === 0 ? {
      ...keyword, scenarios: keyword.scenarios.map((scenario) => ({ ...scenario, harPosition: null,
        explanation: { ...scenario.explanation, no_beat_reason: { reason: "no_comparable_competitors" } } })),
    } : keyword) };
    expect(() => executeDataDrivenStage("revenue-readiness", fixture, { ...outputs, "har-v2": noCompetitors }))
      .toThrow("attainable_rank_or_verified_no_target");
  });

  it("completes revenue for a verified client-only SERP without inventing rank or uplift", () => {
    const { fixture, outputs, har } = executeRepresentativeStages();
    const resolved = structuredClone(har);
    const keyword = resolved.keywords[0]!;
    keyword.baseRank = 2;
    for (const scenario of keyword.scenarios) {
      scenario.harPosition = null;
      scenario.rankAttainmentProbability = null;
      scenario.explanation = {
        ...scenario.explanation, clientDomain: "https://client.test", serpStatus: "matched",
        no_beat_reason: { reason: "no_comparable_competitors", ladder_considered: 0 },
        inputs: { base_rank: 2, competitor_count: 0, client_lps_source: "serp_row", client_lps_match: "ranking_url",
          client_resolved_url: "https://client.test/products" },
      };
    }
    const dependencies = { ...outputs, "har-v2": resolved };
    const readiness = executeDataDrivenStage("revenue-readiness", fixture, dependencies);
    const revenue = executeDataDrivenStage("revenue-v2", fixture, { ...dependencies, "revenue-readiness": readiness });
    expect(revenue?.handlerVersion).toBe("revenue-v2.1");
    if (!revenue || revenue.handlerVersion !== "revenue-v2.1") throw new Error("Unexpected revenue output.");
    const forecasts = revenue.keywords.find(row => row.id === keyword.id)!.scenarios;
    expect(forecasts).toHaveLength(3);
    for (const row of forecasts) {
      expect(row.expectedIncrementalAnnual).toBe(0);
      expect(row.targetIncrementalRevenueAnnual).toBe(0);
      expect(row.targetAbsoluteRevenueAnnual).toBe(row.currentRevenueAnnual);
      expect(row.warnings).toContain("no_attainable_target");
    }
    expect(keyword.scenarios.every(row => row.harPosition === null)).toBe(true);
    expect(() => executeDataDrivenStage("rollup-output", fixture, { ...dependencies, "revenue-v2": revenue })).not.toThrow();
  });

  it.each(["missing-keyword", "missing-scenario", "null-revenue", "non-finite"])("does not finalise %s results", (mode) => {
    const { fixture, outputs, revenue } = executeRepresentativeStages();
    const incomplete = structuredClone(revenue);
    if (mode === "missing-keyword") incomplete.keywords.shift();
    else if (mode === "missing-scenario") incomplete.keywords[0]!.scenarios.pop();
    else incomplete.keywords[0]!.scenarios[0]!.expectedIncrementalAnnual = mode === "non-finite" ? NaN : null;
    expect(() => executeDataDrivenStage("rollup-output", fixture, { ...outputs, "revenue-v2": incomplete }))
      .toThrow("complete_forecasts_for_every_kept_keyword");
  });

  it("finalises verified zero revenue without requiring an invented target rank", () => {
    const { fixture, outputs, revenue } = executeRepresentativeStages();
    const zero = structuredClone(revenue);
    for (const keyword of zero.keywords) for (const row of keyword.scenarios) row.expectedIncrementalAnnual = 0;
    expect(() => executeDataDrivenStage("rollup-output", fixture, { ...outputs, "revenue-v2": zero })).not.toThrow();
    expect(revenue.keywords.every(keyword => keyword.scenarios.every(row => row.expectedIncrementalAnnual !== null))).toBe(true);
  });

  it("persists zero forecast uplift for verified no-target HAR outcomes without manufacturing a rank", () => {
    const { fixture } = executeRepresentativeStages();
    const { har, revenue } = executeRepresentativeStages({ ...fixture,
      scoringConfig: { ...fixture.scoringConfig, scenario_thresholds: { conservative: 1, realistic: 1, stretch: 1 } },
    });
    expect(har.keywords.length).toBeGreaterThan(0);
    let verifiedNoTarget = 0;
    for (const keyword of har.keywords) {
      for (const scenario of keyword.scenarios) {
        expect(scenario.harPosition).toBeNull();
      }
      const forecasts = revenue.keywords.find(row => row.id === keyword.id)!.scenarios;
      expect(forecasts).toHaveLength(3);
      for (const forecast of forecasts) {
        const source = keyword.scenarios.find(row => row.scenario === forecast.scenario)!;
        if ((source.explanation.no_beat_reason as { reason: string }).reason === "authority_below_threshold") {
          verifiedNoTarget++;
          expect(forecast.expectedIncrementalAnnual).toBe(0);
          expect(forecast.targetAbsoluteRevenueAnnual).toBe(forecast.currentRevenueAnnual);
          expect(forecast.warnings).toContain("no_attainable_target");
        } else {
          expect(forecast.expectedIncrementalAnnual).toBeNull();
          expect(forecast.warnings).not.toContain("no_attainable_target");
        }
      }
    }
    expect(verifiedNoTarget).toBeGreaterThan(0);
  });
  it("accepts verified zero DataForSEO authority but rejects unknown zero authority", () => {
    const { fixture, detox, categorisation } = executeRepresentativeStages();
    const zeroAuthority = { ...fixture, authority: { domainRating: 0, referringDomains: 0, backlinks: 0, source: "dataforseo" } };
    expect(() => executeDataDrivenStage("preflight", zeroAuthority, { detox, categorisation })).not.toThrow();
    const { har } = executeRepresentativeStages(zeroAuthority);
    for (const keyword of har.keywords) {
      for (const scenario of keyword.scenarios) expect(scenario.explanation.missing).not.toContain("client_authority");
    }
    expect(() => executeDataDrivenStage("preflight", { ...zeroAuthority, authority: { ...zeroAuthority.authority, source: undefined } }, { detox, categorisation })).toThrow();
  });

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

  it("uses the project focus instead of the television taxonomy for other industries", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const projectFixture = {
      ...fixture,
      project: {
        ...fixture.project,
        categoryFocus: "Weightloss",
      },
    };
    const intake = executeDataDrivenStage("intake", projectFixture, {}) as IntakeStageData;
    const promotion = executeDataDrivenStage("gsc-promotion", projectFixture, {
      intake,
    }) as GscPromotionStageData;
    const detox = executeDataDrivenStage("detox", projectFixture, {
      "gsc-promotion": promotion,
    }) as DetoxStageData;
    const categorisation = executeDataDrivenStage("categorisation", projectFixture, {
      detox,
    }) as CategorisationStageData;

    expect(
      categorisation.keywords
        .filter((keyword) => keyword.categorisation.category !== "Brand")
        .filter((keyword) => keyword.categorisation.category !== "Competitor")
        .every((keyword) => keyword.categorisation.category === "Weightloss"),
    ).toBe(true);
  });

  it("handles projects without category focus or client industry", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);
    const projectFixture = {
      ...fixture,
      client: {
        ...fixture.client,
        industry: null,
      },
      project: {
        ...fixture.project,
        categoryFocus: null,
      },
    };
    const intake = executeDataDrivenStage("intake", projectFixture, {}) as IntakeStageData;
    const promotion = executeDataDrivenStage("gsc-promotion", projectFixture, {
      intake,
    }) as GscPromotionStageData;
    const detox = executeDataDrivenStage("detox", projectFixture, {
      "gsc-promotion": promotion,
    }) as DetoxStageData;
    const categorisation = executeDataDrivenStage("categorisation", projectFixture, {
      detox,
    }) as CategorisationStageData;

    expect(detox.keywords).toHaveLength(promotion.keywords.length);
    expect(detox.keywords.every((keyword) => !keyword.detox.reason.includes("null"))).toBe(true);
    expect(
      categorisation.keywords.some(
        (keyword) => keyword.categorisation.category === "Uncategorised",
      ),
    ).toBe(true);
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
      matchedKeywordCount: 12,
      missingProviderCount: 0,
      noResultCount: 0,
      resultCount: 20,
    });
    expect(authority).toMatchObject({
      clientResultCount: 4,
      resultCount: 20,
      authority: {
        backlinks: 18420,
        domain: "northstar-home.test",
        domainRating: 47,
        referringDomains: 1380,
      },
    });
    expect(backlinks).toMatchObject({
      enrichedResultCount: 20,
      missingResultCount: 0,
      resultCount: 20,
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
      resultCount: 20,
      scoredResultCount: 20,
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
      modelVersion: "har_v2.1.1",
      scenarioCount: 36,
    });
    expect(har.keywords.every((keyword) => keyword.scenarios.length === 3)).toBe(
      true,
    );
    expect(revenue).toMatchObject({
      forecastCount: 36,
      handlerVersion: "revenue-v2.1",
      modelVersion: "revenue_v2.1.1",
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
      "ctr-curves": ctrCurves,
      "demand-signals": demandSignals,
      "har-v2": har,
      "ranking-url": ranking,
      "revenue-readiness": {
        handlerVersion: "revenue-readiness-v1",
        keywords: har.keywords.map(({ id, normalisedText }) => ({ id, normalisedText })),
        ready: true,
        substitutions: [],
      },
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
