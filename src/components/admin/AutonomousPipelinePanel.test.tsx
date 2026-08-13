import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import AutonomousPipelinePanel from "./AutonomousPipelinePanel";
import type { PipelineReadiness } from "@/integrations/gcp/pipeline";

const readiness: PipelineReadiness = {
  configuration: { brandTerms: ["Northstar", "Northstar Home"] },
  dirty: { inputs: false, keywords: false, serp: false },
  gates: [
    { id: "client_domain", label: "Client domain", ready: true },
    { id: "explicit_brand_terms", label: "Explicit brand terms", ready: true },
  ],
  missing: [],
  policy: {
    competitiveEnrichmentVolumeFloor: 200,
    gscPromotionImpressionsFloor: 10,
  },
  providerSummary: {
    cacheEntriesAvailable: 48,
    failed: 0,
    maxAttempts: 1,
    pending: 0,
    submitted: 0,
    succeeded: 240,
  },
  preview: {
    duplicateGscQueryCount: 1400,
    keptKeywordCount: 1200,
    latestGscQueryCount: 25000,
    manualKeywordCount: 1200,
    paidEligibleKeywordCount: 900,
    promotableGscQueryCount: 8400,
  },
  projectId: "project-id",
  ready: true,
  rollups: [
    {
      categoryRollup: [
        { category: "Televisions", expectedIncrementalAnnual: 70000, keywordCount: 4 },
      ],
      clusterDedupedExpectedIncrementalAnnual: 120000,
      clusterRollup: [
        { canonicalKeywordId: "keyword-1", clusterKey: "oled television", expectedIncrementalAnnual: 60000, memberCount: 3 },
      ],
      doubleCountAnnual: 30000,
      naiveExpectedIncrementalAnnual: 150000,
      quarterRollup: [
        { expectedIncrementalAnnual: 80000, keywordCount: 5, quarter: "Q4" },
      ],
      scenario: "realistic",
      trendRollup: [
        { expectedIncrementalAnnual: 90000, keywordCount: 6, trend: "growing" },
      ],
    },
  ],
  substitutions: [
    {
      count: 12,
      input: "content_fit",
      stageId: "har-readiness",
      substitute: "neutral_with_confidence_penalty",
    },
  ],
};

describe("AutonomousPipelinePanel", () => {
  it("shows readiness, four tracks, operator preview and deduplicated output", () => {
    render(
      <AutonomousPipelinePanel
        archived={false}
        onRun={vi.fn()}
        onSavePolicy={vi.fn()}
        onStampPrecurated={vi.fn()}
        readiness={readiness}
        run={null}
        running={false}
        savingPolicy={false}
        stampingPrecurated={false}
      />,
    );

    expect(screen.getByText("All configuration gates passed")).toBeInTheDocument();
    expect(screen.getByText("8400 of 25000 GSC queries qualify")).toBeInTheDocument();
    expect(screen.getAllByText(/TRACK [A-D]/)).toHaveLength(4);
    expect(screen.getByText("£120,000")).toBeInTheDocument();
    expect(screen.getByText("£30,000 removed")).toBeInTheDocument();
    expect(screen.getByText("1400 existing duplicates")).toBeInTheDocument();
    expect(screen.getByText("900 paid-enrichment eligible")).toBeInTheDocument();
    expect(screen.getByText("Provider complete")).toBeInTheDocument();
    expect(screen.getByText("Fresh cache")).toBeInTheDocument();
    expect(screen.getByText("Reviewed brand terms: Northstar, Northstar Home")).toBeInTheDocument();
    expect(screen.getByText("Critical path")).toBeInTheDocument();
    expect(screen.getByText("Top clusters")).toBeInTheDocument();
    expect(screen.getByText("oled television")).toBeInTheDocument();
    expect(screen.getByText("Categories")).toBeInTheDocument();
    expect(screen.getByText("Quarter plan")).toBeInTheDocument();
    expect(screen.getByText("Demand trend")).toBeInTheDocument();
    expect(screen.getByText(/neutral with confidence penalty/)).toBeInTheDocument();
  });

  it("starts a full server-side run and saves operator-controlled thresholds", () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const onSavePolicy = vi.fn().mockResolvedValue(undefined);
    const onStampPrecurated = vi.fn().mockResolvedValue(undefined);
    render(
      <AutonomousPipelinePanel
        archived={false}
        onRun={onRun}
        onSavePolicy={onSavePolicy}
        onStampPrecurated={onStampPrecurated}
        readiness={readiness}
        run={null}
        running={false}
        savingPolicy={false}
        stampingPrecurated={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full pipeline" }));
    expect(onRun).toHaveBeenCalledWith("full");

    fireEvent.change(screen.getByLabelText("Minimum GSC impressions"), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText("Paid enrichment volume floor"), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(onSavePolicy).toHaveBeenCalledWith({
      competitiveEnrichmentVolumeFloor: 500,
      gscPromotionImpressionsFloor: 25,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Mark manual set as pre-curated" }),
    );
    expect(onStampPrecurated).toHaveBeenCalledOnce();
  });
});
