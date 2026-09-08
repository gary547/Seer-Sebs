import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { computeRevenueV2, type RevenueV2Inputs } from "../src/revenue-v2.js";

const historicalSource = readFileSync(new URL("../../../../supabase/functions/_shared/revenue-v2.ts", import.meta.url), "utf8");
const historicalJavaScript = stripTypeScriptTypes(historicalSource).replace(/\bexport\s+/g, "");
const legacy = runInNewContext(`${historicalJavaScript}; computeRevenueV2`, { Date, Math, Number }) as typeof computeRevenueV2;

describe("Revenue compatibility with the historical source", () => {
  it("preserves all historical financial results when the explicit no-target outcome is absent", () => {
    const date = new Date("2026-09-08T00:00:00Z");
    let checked = 0;
    for (const scenario of ["conservative", "realistic", "stretch"] as const)
      for (const pos_now of [null, 1, 7, 25])
        for (const pos_tp of [null, 1, 5])
          for (const volume_annual of [null, 0, 12000])
            for (const cvr of [null, 0, 0.03])
              for (const rank_attainment_probability of [null, 0, 0.7, 1]) {
                const input: RevenueV2Inputs = { scenario, pos_now, pos_tp, volume_annual, cvr, rank_attainment_probability,
                  aov: 50, ctr_now: pos_now === null ? null : 0.05, ctr_tp: pos_tp === null ? null : 0.2,
                  svm: 0.85, har_confidence: 0.8, monthly_volumes: [], trend_pct: 15, trend_confidence: "high" };
                const previous = legacy(input, date);
                const current = computeRevenueV2(input, date);
                expect({ ...current, ctr_now: previous.ctr_now }).toEqual(previous);
                expect(current.ctr_now).toBe(pos_now === null ? 0 : previous.ctr_now);
                checked++;
              }
    expect(checked).toBe(1296);
  });
});
