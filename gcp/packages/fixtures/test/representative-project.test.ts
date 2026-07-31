import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseRepresentativeProjectFixture,
  summariseRepresentativeFixture,
} from "../src/representative-project.js";

const fixtureUrl = new URL("../../../fixtures/representative-project.json", import.meta.url);
const rawFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;

describe("representative project fixture", () => {
  it("keeps source data separate from expected pipeline outcomes", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);

    expect(summariseRepresentativeFixture(fixture)).toEqual({
      gscDistinctQueryCount: 8,
      gscPromotionCandidateCount: 2,
      gscRowCount: 9,
      sourceKeywordCount: 12,
      sourceMissingRankingUrlCount: 4,
    });
    expect(fixture.expected.summary).toEqual({
      deferredKeywordCount: 2,
      keptKeywordCount: 12,
      liveKeywordCount: 10,
      missingRankingUrlCount: 1,
      processingKeywordCount: 14,
      removedKeywordCount: 2,
      reviewKeywordCount: 0,
    });
    expect(
      Object.keys(fixture.keywords[0] ?? {}).some((key) =>
        ["category", "detoxDecision", "intent", "tier"].includes(key),
      ),
    ).toBe(false);
  });

  it("covers promotions, removals, long-tail routing and missing data", () => {
    const fixture = parseRepresentativeProjectFixture(rawFixture);

    expect(fixture.expected.promotedQueries).toEqual([
      "55 inch smart tv",
      "oled tv offers",
    ]);
    expect(
      fixture.expected.keywordOutcomes.some((keyword) => keyword.tier === "deferred"),
    ).toBe(true);
    expect(
      fixture.expected.keywordOutcomes.some(
        (keyword) => keyword.detoxDecision === "remove",
      ),
    ).toBe(true);
    expect(fixture.keywords.some((keyword) => keyword.avgMonthlyVolume === null)).toBe(
      true,
    );
    expect(fixture.keywords.some((keyword) => keyword.rankingUrl === null)).toBe(true);
    expect(fixture.providerInputs.serpKeywords).toHaveLength(4);
    expect(
      fixture.providerInputs.serpKeywords.reduce(
        (count, keyword) => count + keyword.results.length,
        0,
      ),
    ).toBe(12);
  });

  it("rejects duplicate source keywords before a run can start", () => {
    const invalid = structuredClone(rawFixture) as {
      keywords: Array<{ id: string; text: string }>;
    };
    invalid.keywords[1]!.text = `  ${invalid.keywords[0]!.text.toUpperCase()}  `;

    expect(() => parseRepresentativeProjectFixture(invalid)).toThrow(
      "fixture keywords must contain unique normalised values",
    );
  });

  it("rejects an internally inconsistent expected summary", () => {
    const invalid = structuredClone(rawFixture) as {
      expected: { summary: { keptKeywordCount: number } };
    };
    invalid.expected.summary.keptKeywordCount = 999;

    expect(() => parseRepresentativeProjectFixture(invalid)).toThrow(
      "expected.summary.keptKeywordCount=999",
    );
  });

  it("rejects inconsistent SERP provider domains", () => {
    const invalid = structuredClone(rawFixture) as {
      providerInputs: {
        serpKeywords: Array<{ results: Array<{ domain: string }> }>;
      };
    };
    invalid.providerInputs.serpKeywords[0]!.results[0]!.domain =
      "unexpected.example";

    expect(() => parseRepresentativeProjectFixture(invalid)).toThrow(
      "domain must match the URL hostname",
    );
  });
});
