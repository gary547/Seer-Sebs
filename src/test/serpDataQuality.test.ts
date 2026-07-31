import { describe, it, expect } from "vitest";
import {
  computeSerpDataQualitySignals,
  type ComputeSignalsInput,
  type SampledKeyword,
  type SerpFeatureRowWithUrl,
  type KeywordVisibilityResult,
} from "@/lib/serpDataQuality";
import type { SerpAdjustmentRow } from "@/lib/serpVisibility";

function mkKw(id: string, keyword: string, intent: string | null = "commercial"): SampledKeyword {
  return { id, keyword, search_intent: intent };
}

function mkFeat(
  keyword_id: string,
  result_type: string,
  extras: Partial<SerpFeatureRowWithUrl> = {},
): SerpFeatureRowWithUrl {
  return {
    keyword_id,
    result_type,
    serp_feature_count: 1,
    serp_feature_owned: null,
    snippet_opportunity: null,
    top_serp_feature: null,
    top_serp_feature_url: null,
    ...extras,
  };
}

const activeAdj: SerpAdjustmentRow[] = [
  { feature_type: "knowledge_graph", device: "all", intent: "generic", multiplier: 0.8, confidence: "medium", is_active: true },
];

function base(overrides: Partial<ComputeSignalsInput> = {}): ComputeSignalsInput {
  return {
    device: "all",
    clientDomain: "client.com",
    keywords: [],
    featuresByKeyword: new Map(),
    adjustments: activeAdj,
    results: [],
    ...overrides,
  };
}

describe("computeSerpDataQualitySignals", () => {
  it("flags empty adjustment table as critical", () => {
    const s = computeSerpDataQualitySignals(base({ adjustments: [], keywords: [mkKw("a", "x")] }));
    expect(s.some((x) => x.code === "ADJUSTMENT_TABLE_EMPTY" && x.severity === "critical")).toBe(true);
  });

  it("flags no kept keywords and short-circuits keyword-scope signals", () => {
    const s = computeSerpDataQualitySignals(base({ keywords: [] }));
    expect(s.some((x) => x.code === "NO_KEPT_KEYWORDS")).toBe(true);
    expect(s.some((x) => x.scope === "keyword")).toBe(false);
  });

  it("flags sparse coverage above 25%", () => {
    const kws = Array.from({ length: 10 }, (_, i) => mkKw(`k${i}`, `kw ${i}`));
    const features = new Map<string, SerpFeatureRowWithUrl[]>();
    // Only 2 keywords have features → 8/10 empty → 80% sparse
    features.set("k0", [mkFeat("k0", "knowledge_graph")]);
    features.set("k1", [mkFeat("k1", "knowledge_graph")]);
    const s = computeSerpDataQualitySignals(base({ keywords: kws, featuresByKeyword: features }));
    expect(s.some((x) => x.code === "SPARSE_COVERAGE")).toBe(true);
  });

  it("flags unknown result types when results carry unmatched types", () => {
    const kws = [mkKw("a", "alpha")];
    const results: KeywordVisibilityResult[] = [
      { keywordId: "a", multiplier: 1, featureCount: 1, unmatchedFeatureTypes: ["mystery_widget"] },
    ];
    const s = computeSerpDataQualitySignals(base({ keywords: kws, results }));
    const sig = s.find((x) => x.code === "UNKNOWN_RESULT_TYPES");
    expect(sig).toBeTruthy();
    expect(sig?.affectedKeywordIds).toContain("a");
  });

  it("flags missing intent tier as info", () => {
    const kws = [mkKw("a", "alpha", null), mkKw("b", "beta", "commercial")];
    const s = computeSerpDataQualitySignals(base({ keywords: kws }));
    const sig = s.find((x) => x.code === "MISSING_INTENT_TIER");
    expect(sig?.severity).toBe("info");
    expect(sig?.affectedKeywordIds).toEqual(["a"]);
  });

  it("flags high heavy deflation share", () => {
    const kws = Array.from({ length: 4 }, (_, i) => mkKw(`k${i}`, `kw ${i}`));
    const results: KeywordVisibilityResult[] = kws.map((k) => ({
      keywordId: k.id,
      multiplier: 0.2,
      featureCount: 3,
      unmatchedFeatureTypes: [],
    }));
    const s = computeSerpDataQualitySignals(base({ keywords: kws, results }));
    expect(s.some((x) => x.code === "HIGH_HEAVY_DEFLATION")).toBe(true);
  });

  it("detects competitor knowledge panel excluding client + google hosts", () => {
    const kws = [mkKw("a", "brand query"), mkKw("b", "brand review")];
    const features = new Map<string, SerpFeatureRowWithUrl[]>();
    features.set("a", [
      mkFeat("a", "knowledge_graph", {
        top_serp_feature: "APIVoid",
        top_serp_feature_url: "https://www.apivoid.com/tools/website-trust-score/?domain=client.com",
      }),
    ]);
    features.set("b", [
      mkFeat("b", "knowledge_graph", {
        top_serp_feature: "Client",
        top_serp_feature_url: "https://client.com/about",
      }),
    ]);
    const s = computeSerpDataQualitySignals(base({ keywords: kws, featuresByKeyword: features }));
    const sig = s.find((x) => x.code === "COMPETITOR_KNOWLEDGE_PANEL");
    expect(sig).toBeTruthy();
    expect(sig?.affectedKeywordIds).toEqual(["a"]);
    const ents = (sig?.evidence?.entities as Array<{ entity: string }>) ?? [];
    expect(ents[0].entity).toBe("APIVoid");
  });

  it("emits positive owned + snippet signals", () => {
    const kws = [mkKw("a", "alpha")];
    const features = new Map<string, SerpFeatureRowWithUrl[]>();
    features.set("a", [
      mkFeat("a", "featured_snippet", { serp_feature_owned: true, snippet_opportunity: true }),
    ]);
    const s = computeSerpDataQualitySignals(base({ keywords: kws, featuresByKeyword: features }));
    expect(s.some((x) => x.code === "OWNED_FEATURE_PRESENT" && x.severity === "info")).toBe(true);
    expect(s.some((x) => x.code === "SNIPPET_OPPORTUNITY" && x.severity === "info")).toBe(true);
  });

  it("orders signals critical → warn → info", () => {
    const kws = [mkKw("a", "alpha", null)];
    const s = computeSerpDataQualitySignals(base({ adjustments: [], keywords: kws }));
    const sev = s.map((x) => x.severity);
    // critical must precede any info
    const firstInfo = sev.indexOf("info");
    const lastCritical = sev.lastIndexOf("critical");
    if (firstInfo !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstInfo);
    }
  });
});
