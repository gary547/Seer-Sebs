import { describe, expect, it } from "vitest";

import {
  calculationFlags,
  ctrChartRows,
  humanise,
  volumeCoverageBuckets,
} from "@/components/admin/calculationDiagnostics";
import type {
  CalculationInspectorRow,
  CtrCurve,
} from "@/integrations/gcp/calculations";

describe("calculation diagnostics", () => {
  it("derives actionable flags from the realistic scenario", () => {
    const row = {
      harIsManualV1: true,
      harV1: 11,
      scenarios: {
        realistic: {
          averageOrderValueOverrideId: null,
          contentFitScore: null,
          conversionRateOverrideId: null,
          explanation: {
            clamps: { clamped_har_position: 8 },
            inputs: { client_lps_basis: "synthetic" },
          },
          harPosition: 8,
          linkPowerScore: null,
        },
      },
    } as unknown as CalculationInspectorRow;

    expect(calculationFlags(row)).toEqual([
      "delta",
      "override",
      "missing_lps",
      "synthetic_lps",
      "clamped",
      "missing_content_fit",
    ]);
  });

  it("creates mutually exclusive volume coverage buckets", () => {
    expect(
      volumeCoverageBuckets({
        keptKeywords: 100,
        with12Months: 70,
        with24Months: 50,
        withHistory: 90,
      }),
    ).toEqual([
      { count: 50, key: "ready", label: "24+ months" },
      { count: 20, key: "partial", label: "12–23 months" },
      { count: 20, key: "limited", label: "1–11 months" },
      { count: 10, key: "missing", label: "No history" },
    ]);
  });

  it("aligns CTR series by rank", () => {
    const curves = [
      {
        device: "mobile",
        isBranded: false,
        points: [
          { confidence: "high", ctr: 0.25, impressions: 100, rank: 1, source: "gsc" },
          { confidence: "medium", ctr: 0.1, impressions: 50, rank: 2, source: "fallback" },
        ],
        searchIntent: "commercial",
      },
    ] satisfies CtrCurve[];

    expect(ctrChartRows(curves)).toEqual([
      { rank: 1, "mobile:nonbrand": 25 },
      { rank: 2, "mobile:nonbrand": 10 },
    ]);
    expect(humanise("people_also_ask")).toBe("People Also Ask");
  });
});
