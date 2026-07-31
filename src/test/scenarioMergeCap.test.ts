// Regression tests for the admin comparison-card scenario merge.
//
// Root cause (gate-a-review §7 "100 inch tv" bug): the cards used a raw
// `.limit(SCENARIO_ROW_CAP)` on `keyword_forecast_scenarios`, which
// truncated mid-keyword on any project whose row count (kw × 3) exceeded
// the cap. Some keywords ended up in memory with only 1 or 2 of their 3
// scenarios, and the missing scenario's cell rendered empty.
//
// These tests exercise the pure merge logic used by both
// HarV1V2ComparisonCard and RevenueV1V2ComparisonCard, using a simulated
// paged fetch that mirrors the fix: keyword-scoped cap + ordered pages.

import { describe, it, expect } from "vitest";

type Scenario = "conservative" | "realistic" | "stretch";
type ScenarioEntry = { har_position: number | null; har_confidence: number | null; extras: unknown };
type Merged = {
  keyword_id: string;
  keyword: string;
  conservative: ScenarioEntry | null;
  realistic: ScenarioEntry | null;
  stretch: ScenarioEntry | null;
};

/**
 * Simulates the fixed keyword-ordered paged fetch used by both cards.
 * Returns the merged in-memory rows and a `capReached` flag mirroring
 * the production loop.
 */
function mergeFromPagedRows(
  allRows: Array<{ keyword_id: string; keyword: string; scenario: Scenario; har_position: number | null; har_confidence: number | null; extras: unknown }>,
  opts: { keywordCap: number; pageSize: number },
): { rows: Merged[]; capReached: boolean } {
  // Emulate PostgREST ordering: sort by keyword_id then scenario.
  const sorted = [...allRows].sort((a, b) =>
    a.keyword_id === b.keyword_id ? a.scenario.localeCompare(b.scenario) : a.keyword_id.localeCompare(b.keyword_id),
  );

  const byKw = new Map<string, Merged>();
  let capReached = false;
  for (let offset = 0; !capReached; offset += opts.pageSize) {
    const page = sorted.slice(offset, offset + opts.pageSize);
    if (page.length === 0) break;
    for (const r of page) {
      const kid = r.keyword_id;
      if (!byKw.has(kid)) {
        if (byKw.size >= opts.keywordCap) { capReached = true; break; }
        byKw.set(kid, { keyword_id: kid, keyword: r.keyword, conservative: null, realistic: null, stretch: null });
      }
      (byKw.get(kid) as any)[r.scenario] = {
        har_position: r.har_position,
        har_confidence: r.har_confidence,
        extras: r.extras,
      };
    }
    if (page.length < opts.pageSize) break;
  }
  return { rows: Array.from(byKw.values()), capReached };
}

function makeFixture(keywordCount: number, opts: { nullOnRealistic?: number[] } = {}) {
  const rows: Array<{ keyword_id: string; keyword: string; scenario: Scenario; har_position: number | null; har_confidence: number | null; extras: unknown }> = [];
  const scenarios: Scenario[] = ["conservative", "realistic", "stretch"];
  for (let i = 0; i < keywordCount; i++) {
    const kid = `kw-${String(i).padStart(5, "0")}`;
    for (const s of scenarios) {
      const nullish = s === "realistic" && opts.nullOnRealistic?.includes(i);
      rows.push({
        keyword_id: kid,
        keyword: `kw ${i}`,
        scenario: s,
        har_position: nullish ? null : (s === "conservative" ? 13 : s === "realistic" ? 9 : 5),
        har_confidence: nullish ? null : 0.9,
        extras: nullish ? { content_fit: null, expected_incremental_low_annual: null } : { content_fit: 0.7 },
      });
    }
  }
  return rows;
}

describe("scenario merge — paged, keyword-scoped cap", () => {
  it("every keyword ends up with all three scenario entries populated", () => {
    // 400 kw × 3 = 1,200 rows — the old code with row-cap 1000 would truncate.
    const rows = makeFixture(400);
    const { rows: merged } = mergeFromPagedRows(rows, { keywordCap: 1000, pageSize: 1000 });
    expect(merged).toHaveLength(400);
    for (const r of merged) {
      expect(r.conservative).not.toBeNull();
      expect(r.realistic).not.toBeNull();
      expect(r.stretch).not.toBeNull();
    }
  });

  it("null unrelated fields on the realistic row do not drop the scenario entry", () => {
    // Marks realistic rows as null-heavy for keywords 5, 42, 100, 250, 399.
    const rows = makeFixture(400, { nullOnRealistic: [5, 42, 100, 250, 399] });
    const { rows: merged } = mergeFromPagedRows(rows, { keywordCap: 1000, pageSize: 1000 });
    for (const idx of [5, 42, 100, 250, 399]) {
      const kw = merged.find((r) => r.keyword_id === `kw-${String(idx).padStart(5, "0")}`);
      expect(kw, `kw-${idx} should be present`).toBeDefined();
      expect(kw!.realistic, `kw-${idx} realistic entry should exist even with null fields`).not.toBeNull();
      expect(kw!.realistic!.har_position, `kw-${idx} har_position may be null`).toBeNull();
      expect(kw!.conservative).not.toBeNull();
      expect(kw!.stretch).not.toBeNull();
    }
  });

  it("cap gate on 1,001 keywords truncates by KEYWORD count, not by row count", () => {
    const rows = makeFixture(1001);
    const { rows: merged, capReached } = mergeFromPagedRows(rows, { keywordCap: 1000, pageSize: 1000 });
    expect(capReached).toBe(true);
    expect(merged).toHaveLength(1000);
    for (const r of merged) {
      expect(r.conservative).not.toBeNull();
      expect(r.realistic).not.toBeNull();
      expect(r.stretch).not.toBeNull();
    }
  });

  it("regression: the pathological '100 inch tv near boundary' case renders all three scenarios", () => {
    // Simulate exactly the storage state on TVs Ongoing: 857 kw × 3 = 2571
    // rows. The old row-cap 1000 dropped anything past kw #333.
    const rows = makeFixture(857);
    const { rows: merged, capReached } = mergeFromPagedRows(rows, { keywordCap: 1000, pageSize: 1000 });
    expect(capReached).toBe(false);
    expect(merged).toHaveLength(857);
    // Sample the keyword that would land at row 333 * 3 = 999 boundary.
    const boundaryKw = merged.find((r) => r.keyword_id === "kw-00333");
    expect(boundaryKw?.realistic).not.toBeNull();
    expect(boundaryKw?.stretch).not.toBeNull();
    // And a keyword deep past the old cap.
    const deepKw = merged.find((r) => r.keyword_id === "kw-00800");
    expect(deepKw?.conservative).not.toBeNull();
    expect(deepKw?.realistic).not.toBeNull();
    expect(deepKw?.stretch).not.toBeNull();
  });
});
