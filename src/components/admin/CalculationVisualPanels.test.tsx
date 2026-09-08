import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DemandVisualPanel } from "./CalculationVisualPanels";
import type { CalculationControl } from "@/integrations/gcp/calculation-control";

describe("Demand inspector percentages", () => {
  it("renders already-percent trends once while preserving ratio-based warning percentages", () => {
    const data: CalculationControl["demand"] = {
      averageCoverageMonths: 24, categories: [], confidenceDistribution: {},
      signals: 4, trendDirections: {}, warnings: 1, warningReasons: {},
      samples: [206.03, -51.63, 0, null].map((trendPct, index) => ({
        category: "Test", coverageMonths: 24, demandWarning: false,
        demandWarningReason: null, keyword: `query ${index}`, keywordId: String(index),
        monthlyVolume: 100, peakMonths: [], seasonalityStrength: null,
        trendConfidence: "high", trendDirection: "stable", trendPct, volatilityScore: 0,
      })),
    };
    render(<DemandVisualPanel data={data} />);
    for (const [index, expected] of ["+206.0%", "-51.6%", "0.0%", "—"].entries()) {
      const row = screen.getByText(`query ${index}`).closest("tr")!;
      expect(within(row).getAllByRole("cell")[3]).toHaveTextContent(expected);
    }
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("+20603.0%")).not.toBeInTheDocument();
  });
});
