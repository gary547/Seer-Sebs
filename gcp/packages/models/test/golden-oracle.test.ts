import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeScenario,
  type CompositeInputs,
  type Scenario,
  type ScoringConfig,
} from "../src/har-v2.js";
import { computeRevenueV2 } from "../src/revenue-v2.js";

interface GoldenOracle {
  har: {
    noBeat: { attainablePosition: null; reason: string };
    scenarios: Record<Scenario, { attainablePosition: number; threshold: number }>;
  };
  revenue: {
    expected: {
      currentRevenue: number;
      expectedIncrementalRevenue: number;
      targetAbsoluteRevenue: number;
      targetIncrementalRevenue: number;
    };
    inputs: {
      annualForwardVolume: number;
      attainmentProbability: number;
      averageOrderValue: number;
      conversionRate: number;
      targetCtr: number;
      visibilityMultiplier: number;
    };
  };
}

const oracle = JSON.parse(
  readFileSync(
    resolve("gcp/fixtures/control-data/golden-pipeline/expected.json"),
    "utf8",
  ),
) as GoldenOracle;

const harInputs: CompositeInputs = {
  base_rank: null,
  client_dr: 50,
  client_lps: 50,
  client_ur: 50,
  competitors: [
    { domain: "strong.test", domain_rating: 70, lps_score: 70, rank_absolute: 1, url: "https://strong.test/", url_rating: 70 },
    { domain: "medium.test", domain_rating: 45, lps_score: 45, rank_absolute: 5, url: "https://medium.test/", url_rating: 45 },
    { domain: "weak.test", domain_rating: 25, lps_score: 25, rank_absolute: 10, url: "https://weak.test/", url_rating: 25 },
  ],
  content_fit_score: 0.5,
  has_client_authority: true,
  has_client_lps_row: true,
  latest_lps_run_exists: true,
  serp_feature_count: 0,
  snippet_opportunity: false,
  top_serp_feature: null,
};

const config: ScoringConfig = {
  scenario_floor_multipliers: { conservative: 0, realistic: 0, stretch: 0 },
  scenario_prob_factors: { conservative: 1, realistic: 1, stretch: 1 },
  scenario_temperatures: { conservative: 1, realistic: 1, stretch: 1 },
  scenario_thresholds: Object.fromEntries(
    Object.entries(oracle.har.scenarios).map(([scenario, value]) => [
      scenario,
      value.threshold,
    ]),
  ),
};

describe("autonomous pipeline golden oracle", () => {
  it("matches the agreed weakest-to-strongest HAR ladder for every scenario", () => {
    for (const scenario of ["conservative", "realistic", "stretch"] as const) {
      const result = computeScenario(harInputs, scenario, null, config);
      expect(result.har_position).toBe(
        oracle.har.scenarios[scenario].attainablePosition,
      );
    }

    const noBeat = computeScenario(
      { ...harInputs, client_lps: 0, client_ur: 0 },
      "conservative",
      null,
      config,
    );
    expect(noBeat.har_position).toBe(oracle.har.noBeat.attainablePosition);
    expect(noBeat.explanation_json.no_beat_reason).toMatchObject({
      reason: oracle.har.noBeat.reason,
    });
  });

  it("matches the exact agreed Revenue arithmetic", () => {
    const input = oracle.revenue.inputs;
    const result = computeRevenueV2(
      {
        aov: input.averageOrderValue,
        ctr_now: null,
        ctr_tp: input.targetCtr,
        cvr: input.conversionRate,
        har_confidence: 1,
        monthly_volumes: [],
        pos_now: null,
        pos_tp: 1,
        rank_attainment_probability: input.attainmentProbability,
        scenario: "realistic",
        svm: input.visibilityMultiplier,
        volume_annual: input.annualForwardVolume,
      },
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(result.current_revenue_annual).toBe(
      oracle.revenue.expected.currentRevenue,
    );
    expect(result.tp_absolute_revenue_annual).toBe(
      oracle.revenue.expected.targetAbsoluteRevenue,
    );
    expect(result.tp_incremental_revenue_annual).toBe(
      oracle.revenue.expected.targetIncrementalRevenue,
    );
    expect(result.expected_incremental_revenue_annual).toBe(
      oracle.revenue.expected.expectedIncrementalRevenue,
    );
  });
});
