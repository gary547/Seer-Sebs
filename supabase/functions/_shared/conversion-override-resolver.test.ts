import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  indexOverrides,
  resolveConversionOverride,
  type OverrideRow,
} from "./conversion-override-resolver.ts";

const rows: OverrideRow[] = [
  {
    id: "p",
    scope_type: "project",
    scope_value: null,
    conversion_rate: 0.02,
    average_order_value: 100,
    confidence: "medium",
  },
  {
    id: "i-trans",
    scope_type: "intent",
    scope_value: "transactional",
    conversion_rate: 0.04,
    average_order_value: null,
    confidence: "high",
  },
  {
    id: "c-laptops",
    scope_type: "category",
    scope_value: "laptops",
    conversion_rate: 0.06,
    average_order_value: 250,
    confidence: "high",
  },
  {
    id: "u-page",
    scope_type: "url",
    scope_value: "https://example.com/deals",
    conversion_rate: 0.08,
    average_order_value: 400,
    confidence: "high",
  },
];

Deno.test("override: url wins over category/intent/project", () => {
  const idx = indexOverrides(rows);
  const r = resolveConversionOverride(
    {
      keyword_id: "k1",
      ranking_url: "https://example.com/deals",
      search_intent: "transactional",
      tags: ["laptops"],
    },
    idx,
    { cvr: 0.01, aov: 50 },
  );
  assertEquals(r.cvr.value, 0.08);
  assertEquals(r.cvr.source, "override_url");
  assertEquals(r.aov.value, 400);
});

Deno.test("override: category chosen when no url match, tag_1 deepest-first", () => {
  const idx = indexOverrides(rows);
  const r = resolveConversionOverride(
    {
      keyword_id: "k2",
      ranking_url: null,
      search_intent: "transactional",
      tags: ["electronics", "laptops"], // deepest = laptops
    },
    idx,
    { cvr: 0.01, aov: 50 },
  );
  assertEquals(r.cvr.value, 0.06);
  assertEquals(r.cvr.source, "override_category");
  assertEquals(r.aov.value, 250);
});

Deno.test("override: intent-only override; AOV falls through to project", () => {
  const idx = indexOverrides(rows);
  const r = resolveConversionOverride(
    {
      keyword_id: "k3",
      ranking_url: null,
      search_intent: "transactional",
      tags: [],
    },
    idx,
    { cvr: 0.01, aov: 50 },
  );
  assertEquals(r.cvr.value, 0.04);
  assertEquals(r.cvr.source, "override_intent");
  assertEquals(r.aov.value, 100); // from project scope override row
  assertEquals(r.aov.source, "override_project");
});

Deno.test("override: no matches → project defaults", () => {
  const idx = indexOverrides([]);
  const r = resolveConversionOverride(
    { keyword_id: "k4", ranking_url: null, search_intent: null, tags: [] },
    idx,
    { cvr: 0.015, aov: 75 },
  );
  assertEquals(r.cvr.value, 0.015);
  assertEquals(r.cvr.source, "project_default");
  assertEquals(r.aov.value, 75);
});

Deno.test("override: missing defaults yield 'missing'", () => {
  const idx = indexOverrides([]);
  const r = resolveConversionOverride(
    { keyword_id: "k5", ranking_url: null, search_intent: null, tags: [] },
    idx,
    { cvr: null, aov: null },
  );
  assertEquals(r.cvr.value, null);
  assertEquals(r.cvr.source, "missing");
  assertEquals(r.aov.value, null);
  assert(true);
});
