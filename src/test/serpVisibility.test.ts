import { describe, it, expect } from "vitest";
import {
  normaliseDevice,
  normaliseIntent,
  resolveSerpVisibilityV2,
  type SerpAdjustmentRow,
  type SerpFeatureRow,
} from "@/lib/serpVisibility";

const KW = "kw-1";
const PROJ = "proj-1";

const feat = (o: Partial<SerpFeatureRow> & { result_type: string }): SerpFeatureRow => ({
  keyword_id: KW,
  serp_feature_count: 1,
  serp_feature_owned: false,
  snippet_opportunity: false,
  ...o,
});

const adj = (
  o: Partial<SerpAdjustmentRow> & { feature_type: string; multiplier: number },
): SerpAdjustmentRow => ({
  device: "all",
  intent: "generic",
  confidence: "high",
  is_active: true,
  ...o,
});

describe("resolveSerpVisibilityV2", () => {
  it("tier 1 exact device+intent", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "transactional",
      features: [feat({ result_type: "shopping" })],
      adjustments: [
        adj({ feature_type: "shopping", device: "desktop", intent: "transactional", multiplier: 0.6 }),
      ],
    });
    expect(out.matched[0].tier).toBe("device_intent");
    expect(out.multiplier).toBeCloseTo(0.6);
    expect(out.confidence).toBe("high");
  });

  it("falls back to all device", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "transactional",
      features: [feat({ result_type: "shopping" })],
      adjustments: [adj({ feature_type: "shopping", device: "all", intent: "transactional", multiplier: 0.7 })],
    });
    expect(out.matched[0].tier).toBe("all_intent");
  });

  it("clamps combined multiplier to [0.1, 1.5]", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "generic",
      features: [feat({ result_type: "a" }), feat({ result_type: "b" }), feat({ result_type: "c" })],
      adjustments: [
        adj({ feature_type: "a", multiplier: 0.05 }),
        adj({ feature_type: "b", multiplier: 0.05 }),
        adj({ feature_type: "c", multiplier: 0.05 }),
      ],
    });
    expect(out.multiplier).toBe(0.1);
  });

  it("owned feature never deflates", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "generic",
      features: [feat({ result_type: "featured_snippet", serp_feature_owned: true })],
      adjustments: [adj({ feature_type: "featured_snippet", multiplier: 0.5 })],
    });
    expect(out.multiplier).toBe(1);
  });

  it("empty features → confidence unknown, multiplier 1", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "transactional",
      features: [],
      adjustments: [adj({ feature_type: "shopping", multiplier: 0.6 })],
    });
    expect(out.multiplier).toBe(1);
    expect(out.confidence).toBe("unknown");
    expect(out.dataQualityWarning).toMatch(/No SERP features/);
  });

  it("unknown feature → warning + confidence low", () => {
    const out = resolveSerpVisibilityV2({
      projectId: PROJ,
      keywordId: KW,
      device: "desktop",
      intent: "generic",
      features: [feat({ result_type: "brand_new_feature" })],
      adjustments: [adj({ feature_type: "featured_snippet", multiplier: 0.7 })],
    });
    expect(out.multiplier).toBe(1);
    expect(out.confidence).toBe("low");
    expect(out.unmatchedFeatureTypes).toEqual(["brand_new_feature"]);
  });

  it("device/intent normalisation", () => {
    expect(normaliseDevice("Desktop ")).toBe("desktop");
    expect(normaliseDevice("weird")).toBe("all");
    expect(normaliseIntent("Transactional")).toBe("transactional");
    expect(normaliseIntent("weird")).toBe("generic");
  });
});
