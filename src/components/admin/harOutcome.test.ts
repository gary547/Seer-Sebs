import { describe, expect, it } from "vitest";
import { harOutcomeLabel } from "./calculationDiagnostics";

it("distinguishes no improvement from losing an observed rank", () => {
  expect(harOutcomeLabel({ inputs: { base_rank: 9 }, no_beat_reason: { reason: "authority_below_threshold" } }))
    .toBe("No improvement forecast (current rank 9)");
});
describe("HAR result labels", () => {
  it("distinguishes a verified client-only SERP from missing competitor inputs", () => {
    expect(harOutcomeLabel({
      clientDomain: "https://client.test", serpStatus: "matched",
      no_beat_reason: { reason: "no_comparable_competitors", ladder_considered: 0 },
      inputs: { base_rank: 2, competitor_count: 0, client_lps_source: "serp_row", client_lps_match: "ranking_url",
        client_resolved_url: "https://client.test/products" },
    })).toBe("Client-only SERP — no modelled uplift");
  });
  it("distinguishes no attainable rank from missing competitor data", () => {
    expect(harOutcomeLabel({ no_beat_reason: { reason: "authority_below_threshold" } })).toBe("No attainable target");
    expect(harOutcomeLabel({ no_beat_reason: { reason: "no_comparable_competitors" } })).toBe("Insufficient competitor data");
  });
  it.each([null, undefined, {}, { no_beat_reason: null }])("does not manufacture a no-target outcome from %j", (value) => {
    expect(harOutcomeLabel(value)).toBe("Not available");
  });
});
