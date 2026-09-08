import { describe, expect, it } from "vitest";
import { harOutcomeLabel } from "./calculationDiagnostics";
describe("HAR result labels", () => {
  it("distinguishes no attainable rank from missing competitor data", () => {
    expect(harOutcomeLabel({ no_beat_reason: { reason: "authority_below_threshold" } })).toBe("No attainable target");
    expect(harOutcomeLabel({ no_beat_reason: { reason: "no_comparable_competitors" } })).toBe("Insufficient competitor data");
  });
  it.each([null, undefined, {}, { no_beat_reason: null }])("does not manufacture a no-target outcome from %j", (value) => {
    expect(harOutcomeLabel(value)).toBe("Not available");
  });
});
