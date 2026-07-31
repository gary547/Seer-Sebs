import { describe, expect, it } from "vitest";

import {
  CALIBRATION_MODEL_VERSION,
  computeCalibration,
  isPromotionEligible,
} from "../src/calibration.js";
import {
  computeScenario,
  HAR_V2_MODEL_VERSION,
  serpPenalty,
  type CompositeInputs,
} from "../src/har-v2.js";
import {
  computeRevenueV2,
  REVENUE_V2_MODEL_VERSION,
} from "../src/revenue-v2.js";

const harInputs: CompositeInputs = {
  base_rank: 15,
  client_dr: 40,
  client_lps: 60,
  client_lps_source: "serp_row",
  client_ur: 20,
  competitors: [
    {
      domain: "a.test",
      domain_rating: 50,
      lps_score: 40,
      rank_absolute: 1,
      url: "https://a.test/a",
      url_rating: 30,
    },
    {
      domain: "b.test",
      domain_rating: 55,
      lps_score: 55,
      rank_absolute: 2,
      url: "https://b.test/b",
      url_rating: 40,
    },
  ],
  content_fit_score: 0.7,
  has_client_authority: true,
  has_client_lps_row: true,
  latest_lps_run_exists: true,
  serp_feature_count: 1,
  snippet_opportunity: null,
  top_serp_feature: null,
};

describe("canonical model contracts", () => {
  it("keeps the exact HAR v2.1 contract and SERP penalty", () => {
    const result = computeScenario(harInputs, "realistic", null);

    expect(HAR_V2_MODEL_VERSION).toBe("har_v2.1.0");
    expect(serpPenalty(100, "featured_snippet")).toBe(0.35);
    expect(result.har_position).not.toBeNull();
    expect(result.rank_attainment_probability).not.toBeNull();
  });

  it("keeps the exact Revenue v2.1 annual and monthly invariants", () => {
    const result = computeRevenueV2(
      {
        aov: 100,
        ctr_now: 0.05,
        ctr_tp: 0.2,
        cvr: 0.02,
        har_confidence: 0.5,
        monthly_volumes: [],
        pos_now: 8,
        pos_tp: 3,
        rank_attainment_probability: 0.5,
        scenario: "realistic",
        svm: 1,
        volume_annual: 12_000,
      },
      new Date("2026-07-01T00:00:00Z"),
    );

    expect(REVENUE_V2_MODEL_VERSION).toBe("revenue_v2.1.0");
    expect(result.tp_incremental_revenue_annual).toBe(3_600);
    expect(result.expected_incremental_revenue_annual).toBe(1_800);
    expect(result.expected_incremental_low_annual).toBe(900);
    expect(result.expected_incremental_high_annual).toBe(2_700);
    expect(result.monthly_revenue_json.months).toHaveLength(12);
    expect(result.band_method).toBe("conf_interp_band_v1");
  });

  it("keeps the exact calibration ruled ratio and promotion gate", () => {
    const result = computeCalibration([
      {
        actual_clicks_raw: 50,
        impressions: 999,
        intent: "commercial",
        modelled_monthly_clicks: 40,
        rank: 5,
        window_days: 30,
      },
      {
        actual_clicks_raw: 10,
        impressions: 1,
        intent: "commercial",
        modelled_monthly_clicks: 10,
        rank: 5,
        window_days: 30,
      },
    ]);

    expect(CALIBRATION_MODEL_VERSION).toBe("calibration_v1.0.0");
    expect(result.overall_ratio).toBeCloseTo(50 / 60, 10);
    expect(result.median_per_pair_ratio).toBeCloseTo(0.9, 10);
    expect(result.sum_modelled_monthly).toBe(50);
    expect(result.sum_actual_monthly).toBe(60);
    expect(isPromotionEligible(result)).toBe(true);
  });
});
