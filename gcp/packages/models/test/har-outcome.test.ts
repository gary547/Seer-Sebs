import { describe, expect, it } from "vitest";
import { verifiedHarNoTargetReason } from "../src/har-outcome.js";

const evidence = {
  clientDomain: "https://client.test/",
  serpStatus: "matched",
  no_beat_reason: { reason: "no_comparable_competitors", ladder_considered: 0 },
  inputs: { base_rank: 2, competitor_count: 0, client_lps_source: "serp_row", client_lps_match: "ranking_url",
    client_resolved_url: "https://client.test/products" },
};

describe("verified HAR no-target outcomes", () => {
  it("preserves authority-threshold outcomes, including unranked keywords", () => {
    expect(verifiedHarNoTargetReason({ no_beat_reason: { reason: "authority_below_threshold" } }))
      .toBe("authority_below_threshold");
  });
  it.each(["https://client.test/products", "https://www.client.test/products", "https://shop.client.test/products"])(
    "recognizes positively evidenced client-only SERPs for %s", (url) => {
      expect(verifiedHarNoTargetReason({ ...evidence, inputs: { ...evidence.inputs, client_resolved_url: url } }))
        .toBe("client_only_serp");
    });
  it.each([
    null, {}, { no_beat_reason: { reason: "no_comparable_competitors" } },
    { ...evidence, serpStatus: "missing-provider" },
    { ...evidence, serpStatus: "no-result" },
    { ...evidence, clientDomain: "" },
    { ...evidence, inputs: { ...evidence.inputs, competitor_count: 1 } },
    { ...evidence, inputs: { ...evidence.inputs, base_rank: null } },
    { ...evidence, inputs: { ...evidence.inputs, base_rank: 0 } },
    { ...evidence, inputs: { ...evidence.inputs, base_rank: NaN } },
    { ...evidence, inputs: { ...evidence.inputs, base_rank: "1" } },
    { ...evidence, inputs: { ...evidence.inputs, client_lps_source: "synthetic_client_domain" } },
    { ...evidence, inputs: { ...evidence.inputs, client_lps_match: "unavailable" } },
    { ...evidence, inputs: { ...evidence.inputs, client_resolved_url: "https://client.test.evil.test/" } },
    { ...evidence, inputs: { ...evidence.inputs, client_resolved_url: "https://otherclient.test/" } },
    { ...evidence, inputs: { ...evidence.inputs, client_resolved_url: "ftp://client.test/" } },
    { ...evidence, inputs: { ...evidence.inputs, client_resolved_url: "/relative" } },
    { ...evidence, no_beat_reason: { reason: "no_comparable_competitors", ladder_considered: 1 } },
  ])("does not turn missing or inconsistent evidence into zero uplift: %j", (value) => {
    expect(verifiedHarNoTargetReason(value)).toBeNull();
  });
});
