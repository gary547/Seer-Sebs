import { describe, it, expect } from "vitest";
import {
  humaniseResultType,
  formatTopFeature,
  hostOf,
  isGoogleOwnedHost,
} from "@/lib/serpFeatureLabels";

describe("humaniseResultType", () => {
  it("maps known result types", () => {
    expect(humaniseResultType("knowledge_graph")).toBe("Knowledge graph");
    expect(humaniseResultType("people_also_ask")).toBe("People also ask");
    expect(humaniseResultType("ai_overview")).toBe("AI overview");
  });

  it("prettifies unknown snake_case types", () => {
    expect(humaniseResultType("some_new_widget")).toBe("Some New Widget");
  });

  it("returns Unknown for null/empty", () => {
    expect(humaniseResultType(null)).toBe("Unknown feature");
    expect(humaniseResultType("")).toBe("Unknown feature");
  });
});

describe("formatTopFeature", () => {
  it("returns dash for null row", () => {
    const f = formatTopFeature(null);
    expect(f.primary).toBe("—");
    expect(f.secondary).toBeNull();
  });

  it("shows entity title as 'via ...' when distinct", () => {
    const f = formatTopFeature({
      result_type: "knowledge_graph",
      top_serp_feature: "APIVoid",
      top_serp_feature_url: "https://www.apivoid.com/tools/website-trust-score/?domain=x.com",
    });
    expect(f.primary).toBe("Knowledge graph");
    expect(f.secondary).toBe("via APIVoid");
    expect(f.entityHost).toBe("apivoid.com");
  });

  it("suppresses secondary when entity equals label", () => {
    const f = formatTopFeature({
      result_type: "video",
      top_serp_feature: "Video",
    });
    expect(f.primary).toBe("Video");
    expect(f.secondary).toBeNull();
  });

  it("includes optional metadata in tooltip", () => {
    const f = formatTopFeature(
      { result_type: "featured_snippet", top_serp_feature: "Definition" },
      { featureCount: 4, owned: true, snippetOpportunity: true },
    );
    expect(f.tooltip).toContain("Feature count: 4");
    expect(f.tooltip).toContain("Owned by client");
    expect(f.tooltip).toContain("Snippet opportunity");
  });
});

describe("hostOf / isGoogleOwnedHost", () => {
  it("extracts and normalises host", () => {
    expect(hostOf("https://www.Example.com/a?b=1")).toBe("example.com");
    expect(hostOf(null)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });

  it("detects google-owned surfaces", () => {
    expect(isGoogleOwnedHost("google.com")).toBe(true);
    expect(isGoogleOwnedHost("m.youtube.com")).toBe(true);
    expect(isGoogleOwnedHost("apivoid.com")).toBe(false);
    expect(isGoogleOwnedHost(null)).toBe(false);
  });
});
