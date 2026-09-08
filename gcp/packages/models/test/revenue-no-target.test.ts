import { describe, expect, it } from "vitest";
import { computeRevenueV2, type RevenueV2Inputs } from "../src/revenue-v2.js";

const inputs: RevenueV2Inputs = {
  scenario: "conservative", volume_annual: 12000, ctr_now: 0.05, ctr_tp: null,
  svm: 0.85, cvr: 0.03, aov: 50, pos_now: 7, pos_tp: null,
  rank_attainment_probability: null, har_confidence: 0.9, monthly_volumes: [],
  no_attainable_target: true,
};
describe("revenue when the HAR ladder finds no attainable target", () => {
  it.each([7, null])("preserves current revenue and gives zero uplift for current rank %s", (pos_now) => {
    const result = computeRevenueV2({ ...inputs, pos_now, ctr_now: pos_now ? 0.05 : null });
    expect(result.current_revenue_annual).toBe(pos_now ? 765 : 0);
    expect(result.tp_absolute_revenue_annual).toBe(result.current_revenue_annual);
    expect(result.tp_incremental_revenue_annual).toBe(0);
    expect(result.expected_incremental_revenue_annual).toBe(0);
    expect(result.expected_incremental_low_annual).toBe(0);
    expect(result.expected_incremental_high_annual).toBe(0);
    expect(result.ctr_tp).toBe(pos_now ? 0.05 : 0);
    expect(result.monthly_revenue_json.months).toHaveLength(12);
    expect(result.monthly_revenue_json.months.every(month => month.tp_incremental === 0)).toBe(true);
    expect(result.warnings).toContain("no_attainable_target");
    expect(result.warnings).not.toContain("missing_pos_tp");
    expect(result.warnings).not.toContain("missing_rank_prob");
  });
  it("does not interpret missing HAR data as a verified no-target result", () => {
    const result = computeRevenueV2({ ...inputs, no_attainable_target: false });
    expect(result.expected_incremental_revenue_annual).toBeNull();
    expect(result.warnings).toContain("missing_pos_tp");
  });
  it.each(["aov", "cvr", "volume_annual", "ctr_now"] as const)("does not hide missing %s", (key) => {
    expect(computeRevenueV2({ ...inputs, [key]: null }).expected_incremental_revenue_annual).toBeNull();
  });
  it("does not override an attainable target", () => {
    const result = computeRevenueV2({ ...inputs, pos_tp: 2, ctr_tp: 0.2, rank_attainment_probability: 0.8 });
    expect(result.expected_incremental_revenue_annual).toBeGreaterThan(0);
    expect(result.warnings).not.toContain("no_attainable_target");
  });
});
