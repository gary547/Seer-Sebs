import { describe, expect, it } from "vitest";

import {
  computeScenario,
  type CompositeInputs,
  type ScoringConfig,
} from "../src/har-v2.js";

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
