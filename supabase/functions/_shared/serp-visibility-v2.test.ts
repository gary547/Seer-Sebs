// Deno tests for the v2 SERP visibility deflator helper.

import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  normaliseDevice,
  normaliseIntent,
  resolveSerpVisibilityV2,
  type SerpAdjustmentRow,
  type SerpFeatureRow,
} from "./serp-visibility-v2.ts";

const KW = "kw-1";
const PROJ = "proj-1";

function feat(overrides: Partial<SerpFeatureRow> & { result_type: string }): SerpFeatureRow {
  return {
    keyword_id: KW,
    serp_feature_count: 1,
    serp_feature_owned: false,
    snippet_opportunity: false,
    ...overrides,
  };
}

function adj(overrides: Partial<SerpAdjustmentRow> & { feature_type: string; multiplier: number }): SerpAdjustmentRow {
  return {
    device: "all",
    intent: "generic",
    confidence: "high",
    is_active: true,
    ...overrides,
  };
}

Deno.test("tier 1: device+intent exact match", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "transactional",
    features: [feat({ result_type: "shopping" })],
    adjustments: [
      adj({ feature_type: "shopping", device: "desktop", intent: "transactional", multiplier: 0.6, confidence: "high" }),
    ],
  });
  assertEquals(out.matched[0].tier, "device_intent");
  assertAlmostEquals(out.multiplier, 0.6);
  assertEquals(out.confidence, "high");
  assertEquals(out.dataQualityWarning, null);
});

Deno.test("tier 2: fallback to all device", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "transactional",
    features: [feat({ result_type: "shopping" })],
    adjustments: [adj({ feature_type: "shopping", device: "all", intent: "transactional", multiplier: 0.7 })],
  });
  assertEquals(out.matched[0].tier, "all_intent");
  assertAlmostEquals(out.multiplier, 0.7);
});

Deno.test("tier 3: fallback to generic intent", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "transactional",
    features: [feat({ result_type: "featured_snippet" })],
    adjustments: [adj({ feature_type: "featured_snippet", device: "desktop", intent: "generic", multiplier: 0.72 })],
  });
  assertEquals(out.matched[0].tier, "device_generic");
  assertAlmostEquals(out.multiplier, 0.72);
});

Deno.test("multiple features multiply and clamp within [0.1, 1.5]", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [
      feat({ result_type: "a" }),
      feat({ result_type: "b" }),
      feat({ result_type: "c" }),
    ],
    adjustments: [
      adj({ feature_type: "a", multiplier: 0.05 }),
      adj({ feature_type: "b", multiplier: 0.05 }),
      adj({ feature_type: "c", multiplier: 0.05 }),
    ],
  });
  // 0.05^3 = 0.000125, clamped to 0.1
  assertEquals(out.multiplier, 0.1);
});

Deno.test("owned feature never deflates CTR", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [feat({ result_type: "featured_snippet", serp_feature_owned: true })],
    adjustments: [adj({ feature_type: "featured_snippet", multiplier: 0.5 })],
  });
  assertEquals(out.matched[0].multiplier, 1);
  assertEquals(out.matched[0].rawMultiplier, 0.5);
  assertEquals(out.multiplier, 1);
});

Deno.test("unknown feature type → warning + confidence low", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [feat({ result_type: "brand_new_feature" })],
    adjustments: [adj({ feature_type: "featured_snippet", multiplier: 0.7 })],
  });
  assertEquals(out.multiplier, 1);
  assertEquals(out.matched[0].tier, "none");
  assertEquals(out.confidence, "low");
  assertEquals(out.unmatchedFeatureTypes, ["brand_new_feature"]);
  assert(out.dataQualityWarning?.includes("brand_new_feature"));
});

Deno.test("empty features → multiplier 1, confidence unknown, warning present", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "transactional",
    features: [],
    adjustments: [adj({ feature_type: "shopping", multiplier: 0.6 })],
  });
  assertEquals(out.multiplier, 1);
  assertEquals(out.confidence, "unknown");
  assertEquals(out.featureCount, 0);
  assert(out.dataQualityWarning?.startsWith("No SERP features"));
});

Deno.test("inactive adjustment rows are ignored", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [feat({ result_type: "shopping" })],
    adjustments: [adj({ feature_type: "shopping", multiplier: 0.5, is_active: false })],
  });
  assertEquals(out.matched[0].tier, "none");
  assertEquals(out.multiplier, 1);
  assertEquals(out.unmatchedFeatureTypes, ["shopping"]);
});

Deno.test("device/intent normalisation", () => {
  assertEquals(normaliseDevice("Desktop "), "desktop");
  assertEquals(normaliseDevice("weird"), "all");
  assertEquals(normaliseDevice(null), "all");
  assertEquals(normaliseIntent("Transactional"), "transactional");
  assertEquals(normaliseIntent("weird"), "generic");
  assertEquals(normaliseIntent(null), "generic");
});

Deno.test("confidence rollup: medium wins when mixed high+medium", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [feat({ result_type: "a" }), feat({ result_type: "b" })],
    adjustments: [
      adj({ feature_type: "a", multiplier: 0.9, confidence: "high" }),
      adj({ feature_type: "b", multiplier: 0.9, confidence: "medium" }),
    ],
  });
  assertEquals(out.confidence, "medium");
});

Deno.test("dedupes duplicate result_type rows", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [
      feat({ result_type: "shopping" }),
      feat({ result_type: "shopping" }),
    ],
    adjustments: [adj({ feature_type: "shopping", multiplier: 0.5 })],
  });
  assertEquals(out.featureCount, 1);
  assertAlmostEquals(out.multiplier, 0.5);
});

Deno.test("warningCodes: zero features → ['missing_svm']", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "transactional",
    features: [],
    adjustments: [adj({ feature_type: "shopping", multiplier: 0.6 })],
  });
  assertEquals(out.warningCodes, ["missing_svm"]);
});

Deno.test("warningCodes: unmatched features → 'svm_unmatched_features' + names in unmatchedFeatureTypes", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [
      feat({ result_type: "shopping" }),
      feat({ result_type: "brand_new_feature" }),
    ],
    adjustments: [adj({ feature_type: "shopping", multiplier: 0.6 })],
  });
  assert(out.warningCodes.includes("svm_unmatched_features"));
  assertEquals(out.unmatchedFeatureTypes, ["brand_new_feature"]);
});

Deno.test("bumpOnce dedupe: same (scenario, code) counted once across index.ts + computeRevenueV2 fan-out", () => {
  // Mirror the dedupe helper from compute-forecasts-v2/index.ts inline to
  // keep the test hermetic (no edge-runtime bootstrap required).
  type Bag = Map<string, { count: number; samples: string[] }>;
  const bag: Bag = new Map();
  const bumpLocal = (code: string, sample?: string) => {
    const cur = bag.get(code) ?? { count: 0, samples: [] };
    cur.count += 1;
    if (sample && cur.samples.length < 10) cur.samples.push(sample);
    bag.set(code, cur);
  };
  const bumpOnceLocal = (seen: Set<string>, code: string, sample?: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    bumpLocal(code, sample);
  };

  // One scenario row that would trigger the codes both at the call site AND
  // via the computeRevenueV2 fan-out.
  const seen = new Set<string>();
  bumpOnceLocal(seen, "missing_ctr_tp", "kw-1"); // call site
  bumpOnceLocal(seen, "missing_har_confidence", "kw-1"); // call site
  // Fan-out from computeRevenueV2.warnings — same scenario.
  for (const w of ["missing_ctr_tp", "missing_har_confidence", "missing_volume"]) {
    bumpOnceLocal(seen, w, "kw-1");
  }

  assertEquals(bag.get("missing_ctr_tp")?.count, 1);
  assertEquals(bag.get("missing_har_confidence")?.count, 1);
  assertEquals(bag.get("missing_volume")?.count, 1);
});

// --- Dedupe behaviour (Part B, serp_features truncation follow-up) ---

Deno.test("dedupe: duplicate result_type rows collapse to a single matched entry", () => {
  const singleAdj = [
    adj({ feature_type: "ai_overview", device: "all", intent: "generic", multiplier: 0.55 }),
  ];
  const single = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [feat({ result_type: "ai_overview" })],
    adjustments: singleAdj,
  });
  const duped = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [
      feat({ result_type: "ai_overview" }),
      feat({ result_type: "ai_overview" }),
      feat({ result_type: "AI_Overview" }),
    ],
    adjustments: singleAdj,
  });
  assertEquals(duped.featureCount, 1);
  assertEquals(duped.matched.length, 1);
  assertAlmostEquals(duped.multiplier, single.multiplier);
  assertEquals(duped.warningCodes.includes("missing_svm"), false);
});

Deno.test("dedupe: mixed-case result_type normalises together", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [
      feat({ result_type: "People_Also_Ask" }),
      feat({ result_type: "people_also_ask" }),
      feat({ result_type: "PEOPLE_ALSO_ASK" }),
    ],
    adjustments: [adj({ feature_type: "people_also_ask", device: "all", intent: "generic", multiplier: 0.9 })],
  });
  assertEquals(out.featureCount, 1);
  assertEquals(out.matched[0].featureType, "people_also_ask");
});

Deno.test("dedupe: empty features still surfaces missing_svm warning", () => {
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features: [],
    adjustments: [adj({ feature_type: "ai_overview", multiplier: 0.5 })],
  });
  assertEquals(out.featureCount, 0);
  assertEquals(out.multiplier, 1);
  assertEquals(out.warningCodes.includes("missing_svm"), true);
});

Deno.test("dedupe: many duplicate rows do not inflate the product multiplier", () => {
  const adjustments = [
    adj({ feature_type: "ai_overview", device: "all", intent: "generic", multiplier: 0.5 }),
  ];
  const features: SerpFeatureRow[] = Array.from({ length: 42 }, () => feat({ result_type: "ai_overview" }));
  const out = resolveSerpVisibilityV2({
    projectId: PROJ,
    keywordId: KW,
    device: "desktop",
    intent: "generic",
    features,
    adjustments,
  });
  assertEquals(out.featureCount, 1);
  // 0.5 once, not 0.5^42 (~2e-13, which would clamp to MIN_MULTIPLIER 0.1).
  assertAlmostEquals(out.multiplier, 0.5);
});

