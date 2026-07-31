import { describe, expect, it } from "vitest";

import { clusterKey, pickCanonical } from "../src/clustering.js";
import { computeCalibration } from "../src/calibration.js";
import { ctrConfidence, fallbackCtr } from "../src/ctr.js";
import { computeDemandSignal } from "../src/demand.js";
import { computeHarScenario } from "../src/har.js";
import { computeLps } from "../src/lps.js";
import { computeRevenue } from "../src/revenue.js";

describe("target calculation modules", () => {
  it("computes stable demand direction from a 24-month series", () => {
    const points = Array.from({ length: 24 }, (_, index) => {
      const date = new Date(Date.UTC(2024, index, 1));
      return {
        month: date.toISOString().slice(0, 7) + "-01",
        volume: index < 12 ? 100 : 130,
      };
    });

    expect(computeDemandSignal(points)).toMatchObject({
      coverageMonths: 24,
      demandWarning: false,
      trendConfidence: "high",
      trendDirection: "growing",
      trendPct: 30,
    });
  });

  it("scores complete link metrics with high confidence", () => {
    const rows = [
      {
        backlinks: 1000,
        domainRating: 80,
        keywordId: "one",
        referringDomains: 200,
        urlRating: 60,
      },
      {
        backlinks: 500,
        domainRating: 50,
        keywordId: "two",
        referringDomains: 100,
        urlRating: 40,
      },
    ];
    const result = computeLps(rows[0]!, rows);

    expect(result.confidence).toBe("high");
    expect(result.score).toBeGreaterThan(70);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("normalises surface forms and picks a GSC-led canonical", () => {
    expect(clusterKey("TV 55 inches")).toBe(clusterKey("55in television"));
    expect(
      pickCanonical([
        {
          annualVolume: 1_200,
          baseRank: 4,
          gscClicks: 2,
          id: "one",
          rankingUrl: null,
          text: "55 inch tv",
        },
        {
          annualVolume: 2_400,
          baseRank: 8,
          gscClicks: 10,
          id: "two",
          rankingUrl: null,
          text: "tv 55in",
        },
      ]),
    ).toMatchObject({ basis: "gsc_clicks", member: { id: "two" } });
  });

  it("provides monotonic fallback CTR and confidence bands", () => {
    expect(fallbackCtr(1)).toBeGreaterThan(fallbackCtr(10));
    expect(ctrConfidence(99)).toBe("low");
    expect(ctrConfidence(100)).toBe("medium");
    expect(ctrConfidence(1_000)).toBe("high");
  });

  it("computes bounded HAR scenarios with an observed-rank floor", () => {
    const result = computeHarScenario(
      {
        baseRank: 10,
        clientLinkPowerScore: 65,
        clientUrlRating: 60,
        competitors: [
          { linkPowerScore: 45, rank: 2, urlRating: 50 },
          { linkPowerScore: 55, rank: 4, urlRating: 55 },
          { linkPowerScore: 70, rank: 7, urlRating: 65 },
        ],
        contentFit: 0.9,
      },
      "realistic",
    );

    expect(result.harPosition).not.toBeNull();
    expect(result.harPosition).toBeGreaterThanOrEqual(5);
    expect(result.rankAttainmentProbability).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.05);
  });

  it("keeps Revenue v2 confidence bands ordered", () => {
    const result = computeRevenue({
      annualVolume: 12_000,
      averageOrderValue: 500,
      conversionRate: 0.02,
      ctrNow: 0.02,
      ctrTarget: 0.08,
      harConfidence: 0.75,
      rankAttainmentProbability: 0.6,
      scenario: "realistic",
      serpVisibilityMultiplier: 1,
      trendConfidence: "medium",
      trendPct: 20,
    });

    expect(result.currentRevenueAnnual).toBeGreaterThan(0);
    expect(result.expectedIncrementalLowAnnual).toBeLessThanOrEqual(
      result.expectedIncrementalAnnual!,
    );
    expect(result.expectedIncrementalAnnual).toBeLessThanOrEqual(
      result.expectedIncrementalHighAnnual!,
    );
    expect(result.expectedIncrementalHighAnnual).toBeLessThanOrEqual(
      result.targetIncrementalRevenueAnnual!,
    );
  });

  it("calibrates only pairs above the noise floor", () => {
    const result = computeCalibration([
      {
        actualClicks: 10,
        impressions: 1_000,
        intent: "commercial",
        modelledMonthlyClicks: 12,
        rank: 5,
        windowDays: 30,
      },
      {
        actualClicks: 2,
        impressions: 100,
        intent: "informational",
        modelledMonthlyClicks: 4,
        rank: 12,
        windowDays: 30,
      },
    ]);

    expect(result).toMatchObject({
      excludedNoiseFloor: 1,
      matched: 1,
      overallRatio: 1.2,
      status: "green",
    });
  });
});
