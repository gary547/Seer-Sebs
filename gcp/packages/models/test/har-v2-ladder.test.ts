import { describe, expect, it } from "vitest";

import {
  computeScenario,
  type CompositeInputs,
  type ScoringConfig,
} from "../src/har-v2.js";
import { computeRevenueV2 } from "../src/revenue-v2.js";

const inputs: CompositeInputs = {
  base_rank: null,
  client_dr: 50,
  client_lps: 50,
  client_ur: 50,
  competitors: [
    { domain: "strong.test", lps_score: 70, rank_absolute: 1, url: "https://strong.test/", url_rating: 70, domain_rating: 70 },
    { domain: "medium.test", lps_score: 45, rank_absolute: 5, url: "https://medium.test/", url_rating: 45, domain_rating: 45 },
    { domain: "weak.test", lps_score: 25, rank_absolute: 10, url: "https://weak.test/", url_rating: 25, domain_rating: 25 },
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
  scenario_thresholds: { conservative: 0.6, realistic: 0.5, stretch: 0.3 },
};

describe("HAR v2 competitor ladder", () => {
  it.each(["conservative", "realistic", "stretch"] as const)("never forecasts a numeric %s target worse than the observed baseline", (scenario) => {
    const result = computeScenario({ ...inputs, base_rank: 3 }, scenario, null, config);
    expect(result.har_position).toBeLessThanOrEqual(3);
    expect(result.explanation_json.clamps).toMatchObject({ baseline_ceiling: 3 });
  });

  it("keeps rank one as the baseline when the ladder cannot improve it", () => {
    expect(computeScenario({ ...inputs, base_rank: 1 }, "realistic", null, config).har_position).toBe(1);
  });
  it("fixes the reported base-8 / stretch-10 regression and keeps the raw diagnostic", () => {
    const result = computeScenario({
      ...inputs, base_rank: 8, client_dr: 30, client_ur: 30, client_lps: 30,
      content_fit_score: 0.93, serp_feature_count: 4, top_serp_feature: "featured_snippet",
      competitors: [
        { rank_absolute: 10, domain: "weaker.example", url: "https://weaker.example/", lps_score: 15, url_rating: 15, domain_rating: 15 },
        { rank_absolute: 1, domain: "stronger.example", url: "https://stronger.example/", lps_score: 100, url_rating: 100, domain_rating: 100 },
      ],
    }, "stretch", null);
    expect(result.har_position).toBe(8);
    expect(result.explanation_json.clamps).toMatchObject({ raw_har_position: 10, clamped_har_position: 8 });
  });
  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not invent a baseline from invalid observed rank %s", (base_rank) => {
    expect(computeScenario({ ...inputs, base_rank }, "realistic", null, config).har_position).toBe(5);
  });
  it("retains explicit manual override precedence", () => {
    expect(computeScenario({ ...inputs, base_rank: 3 }, "realistic", { har: 7, v1_forecast_id: "manual" }, config).har_position).toBe(7);
  });
  it("preserves the no-attainable-target outcome even with a known current rank", () => {
    const result = computeScenario({ ...inputs, base_rank: 9, client_lps: 0, client_ur: 0 }, "conservative", null, config);
    expect(result.har_position).toBeNull();
    expect(result.explanation_json.no_beat_reason).toMatchObject({ reason: "authority_below_threshold" });
  });
  it("reconciles a baseline-clamped target to current revenue and zero uplift", () => {
    const har = computeScenario({ ...inputs, base_rank: 3 }, "realistic", null, config);
    const revenue = computeRevenueV2({
      scenario: "realistic", pos_now: 3, pos_tp: har.har_position,
      ctr_now: 0.1, ctr_tp: 0.1, volume_annual: 1_200, svm: 1, cvr: 0.02, aov: 100,
      rank_attainment_probability: har.rank_attainment_probability, har_confidence: har.har_confidence, monthly_volumes: [],
    });
    expect(revenue.tp_absolute_revenue_annual).toBe(revenue.current_revenue_annual);
    expect(revenue.expected_incremental_revenue_annual).toBe(0);
    expect(revenue.tp_incremental_revenue_annual).toBe(0);
  });

  it("walks from the weakest competitor and stops at the first one it cannot beat", () => {
    const result = computeScenario(inputs, "realistic", null, config);

    expect(result.har_position).toBe(5);
    expect(result.explanation_json.ladder).toMatchObject([
      { rank: 10, beaten: true },
      { rank: 5, beaten: true },
      { rank: 1, beaten: false },
    ]);
  });

  it("returns no invented rank when even the weakest competitor cannot be beaten", () => {
    const result = computeScenario(
      { ...inputs, client_lps: 0, client_ur: 0 },
      "conservative",
      null,
      config,
    );

    expect(result.har_position).toBeNull();
    expect(result.rank_attainment_probability).toBeNull();
    expect(result.explanation_json.no_beat_reason).toMatchObject({
      reason: "authority_below_threshold",
    });
  });
});
