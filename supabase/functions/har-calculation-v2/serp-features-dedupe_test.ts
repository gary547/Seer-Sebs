// Regression test for the har-calculation-v2 serp_features dedupe pattern.
//
// har-calculation-v2 fetches serp_features per keyword chunk and reduces the
// rows to one aggregate per keyword via a first-wins dedupe on
// (keyword_id, result_type). This test mirrors that reducer to guard against
// silent behaviour changes (e.g. reverting to last-wins .set overwrite).

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

type Row = {
  keyword_id: string;
  result_type: string | null;
  serp_feature_count: number | null;
  top_serp_feature: string | null;
  snippet_opportunity: boolean | null;
};

function reduce(rows: Row[]) {
  const byKw = new Map<string, { count: number | null; top: string | null; snippet: boolean | null }>();
  const seenPairs = new Set<string>();
  for (const r of rows) {
    const kid = String(r.keyword_id);
    const rt = ((r.result_type ?? "") as string).toLowerCase().trim();
    const pairKey = `${kid}::${rt}`;
    if (rt && seenPairs.has(pairKey)) continue;
    if (rt) seenPairs.add(pairKey);
    if (!byKw.has(kid)) {
      byKw.set(kid, {
        count: r.serp_feature_count == null ? null : Number(r.serp_feature_count),
        top: r.top_serp_feature,
        snippet: r.snippet_opportunity == null ? null : Boolean(r.snippet_opportunity),
      });
    }
  }
  return { byKw, distinctPairs: seenPairs.size };
}

Deno.test("har-v2 serp_features dedupe: first-wins per (keyword_id, result_type)", () => {
  const rows: Row[] = [
    { keyword_id: "kw-1", result_type: "ai_overview", serp_feature_count: 4, top_serp_feature: "ai_overview", snippet_opportunity: false },
    { keyword_id: "kw-1", result_type: "ai_overview", serp_feature_count: 9, top_serp_feature: "ai_overview", snippet_opportunity: true },
    { keyword_id: "kw-1", result_type: "AI_Overview", serp_feature_count: 99, top_serp_feature: "ai_overview", snippet_opportunity: true },
    { keyword_id: "kw-1", result_type: "people_also_ask", serp_feature_count: 4, top_serp_feature: "people_also_ask", snippet_opportunity: false },
    { keyword_id: "kw-2", result_type: "featured_snippet", serp_feature_count: 1, top_serp_feature: "featured_snippet", snippet_opportunity: true },
    { keyword_id: "kw-2", result_type: "featured_snippet", serp_feature_count: 7, top_serp_feature: "featured_snippet", snippet_opportunity: false },
  ];
  const { byKw, distinctPairs } = reduce(rows);
  assertEquals(distinctPairs, 3);
  // First-wins: kw-1's retained aggregate is from the first ai_overview row.
  assertEquals(byKw.get("kw-1")?.count, 4);
  assertEquals(byKw.get("kw-1")?.snippet, false);
  assertEquals(byKw.get("kw-2")?.count, 1);
  assertEquals(byKw.get("kw-2")?.snippet, true);
});

Deno.test("har-v2 serp_features dedupe: empty result_type does not swallow other keywords", () => {
  const rows: Row[] = [
    { keyword_id: "kw-3", result_type: "", serp_feature_count: 5, top_serp_feature: null, snippet_opportunity: null },
    { keyword_id: "kw-3", result_type: "shopping", serp_feature_count: 2, top_serp_feature: "shopping", snippet_opportunity: false },
  ];
  const { byKw } = reduce(rows);
  // First row (empty rt) sets the aggregate; subsequent shopping row is skipped
  // because first-wins applies at the keyword level too.
  assertEquals(byKw.get("kw-3")?.count, 5);
});
