import { describe, expect, it } from "vitest";

import {
  domainBrandTerms,
  resolveBrandTerms,
} from "../src/brand-terms.js";

describe("pipeline brand terms", () => {
  it("uses a safe registrable-domain fallback when explicit terms are absent", () => {
    expect(domainBrandTerms("https://www.pilltime.co.uk/path")).toEqual([
      "pilltime",
    ]);
    expect(resolveBrandTerms([], "pilltime.co.uk")).toEqual({
      source: "domain_fallback",
      terms: ["pilltime"],
    });
  });

  it("does not derive short or generic domain labels", () => {
    expect(domainBrandTerms("ao.com")).toEqual([]);
    expect(domainBrandTerms("tvs.co.uk")).toEqual([]);
  });

  it("keeps explicit operator terms ahead of the domain fallback", () => {
    expect(
      resolveBrandTerms(["PillTime", "pilltime", "Pill Time"], "pilltime.co.uk"),
    ).toEqual({
      source: "explicit",
      terms: ["PillTime", "Pill Time"],
    });
  });
});
