import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import AutonomousPipelinePanel from "./AutonomousPipelinePanel";
import {
  PIPELINE_STAGE_IDS,
  type PipelineReadiness,
  type PipelineRun,
  type PipelineStage,
} from "@/integrations/gcp/pipeline";

const readiness: PipelineReadiness = {
  configuration: {
    brandTerms: ["Northstar", "Northstar Home"],
    brandTermsSource: "explicit",
    explicitBrandTerms: ["Northstar", "Northstar Home"],
  },
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

function pipelineRun(): PipelineRun {
  const stages: PipelineStage[] = PIPELINE_STAGE_IDS.map((id) => ({
    attempts: id === "site-architecture" ? 3 : 1,
    completedAt: id === "site-architecture" ? null : "2026-08-20T07:10:00.000Z",
    dependencies: [],
    execution: "tasks",
    id,
    progress: {
      done: id === "serp-collection" ? 8839 : 1,
      failed: 0,
      message:
        id === "site-architecture"
          ? "Scoring content-fit for ranking URLs · 62m elapsed · attempt 3"
          : id === "serp-collection"
            ? "Completed in 18m · 8,839 items"
            : "Completed in 6s",
      pending: 0,
      percent: id === "site-architecture" ? null : 100,
      submitted: 0,
      total: id === "serp-collection" ? 8839 : 1,
      unit: id === "serp-collection" ? "items" : null,
    },
    startedAt: "2026-08-20T06:45:00.000Z",
    state: id === "site-architecture" ? "running" : "succeeded",
  }));
  return {
    completedAt: null,
    createdAt: "2026-08-20T06:43:56.000Z",
    deliveredEventCount: 0,
    id: "36467606-c900-4048-a5c3-49a01bcad268",
    input: { mode: "full", projectId: "project-id" },
    stages,
    startedAt: "2026-08-20T06:43:59.000Z",
    status: "running",
  };
}

describe("AutonomousPipelinePanel", () => {
  it("shows readiness, four tracks, operator preview and deduplicated output", () => {
    render(
      <AutonomousPipelinePanel
        archived={false}
        onSaveBrandTerms={vi.fn()}
        onRun={vi.fn()}
        onSavePolicy={vi.fn()}
        onStampPrecurated={vi.fn()}
        readiness={readiness}
        run={null}
        running={false}
        savingBrandTerms={false}
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
    expect(screen.getByDisplayValue("Northstar, Northstar Home")).toBeInTheDocument();
    expect(screen.getByText("These terms are shared by every project for this client.")).toBeInTheDocument();
    expect(screen.getByText("Critical path")).toBeInTheDocument();
    expect(screen.getByText("Top clusters")).toBeInTheDocument();
    expect(screen.getByText("oled television")).toBeInTheDocument();
    expect(screen.getByText("Categories")).toBeInTheDocument();
    expect(screen.getByText("Quarter plan")).toBeInTheDocument();
    expect(screen.getByText("Demand trend")).toBeInTheDocument();
    expect(screen.getByText(/neutral with confidence penalty/)).toBeInTheDocument();
    expect(screen.getByText("Stage activity")).toBeInTheDocument();
    expect(screen.getAllByText("intake").length).toBeGreaterThan(0);
  });

  it("shows per-stage percent and live log lines for the running pipeline", () => {
    render(
      <AutonomousPipelinePanel
        archived={false}
        onSaveBrandTerms={vi.fn()}
        onRun={vi.fn()}
        onSavePolicy={vi.fn()}
        onStampPrecurated={vi.fn()}
        readiness={readiness}
        run={pipelineRun()}
        running={false}
        savingBrandTerms={false}
        savingPolicy={false}
        stampingPrecurated={false}
      />,
    );

    expect(screen.getByText("23/24 complete")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Scoring content-fit for ranking URLs · 62m elapsed · attempt 3",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Completed in 18m · 8,839 items").length,
    ).toBeGreaterThan(0);
  });

  it("opens a complete sanitized stage-by-stage activity log", () => {
    const run = pipelineRun();
    const failedStage = run.stages.find((stage) => stage.id === "site-architecture");
    if (!failedStage) throw new Error("Missing site architecture stage fixture.");
    failedStage.state = "failed";
    failedStage.progress = {
      ...failedStage.progress!,
      message: "500 Internal Server Error from Workflow execution x-cloud-trace secret",
    };
    run.stages[0].progress = {
      ...run.stages[0].progress!,
      message: "Processed 500 items",
    };
    run.status = "failed";

    render(
      <AutonomousPipelinePanel
        archived={false}
        onSaveBrandTerms={vi.fn()}
        onRun={vi.fn()}
        onSavePolicy={vi.fn()}
        onStampPrecurated={vi.fn()}
        readiness={readiness}
        run={run}
        running={false}
        savingBrandTerms={false}
        savingPolicy={false}
        stampingPrecurated={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View full activity" }));

    expect(screen.getByRole("dialog", { name: "Pipeline activity" })).toBeInTheDocument();
    expect(screen.getAllByTestId(/pipeline-activity-stage-/)).toHaveLength(24);
    expect(screen.getByText(`Run ${run.id} · sanitized operator activity`)).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "This stage did not finish. Saved progress is preserved and the run can be resumed safely.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Processed 500 items").length).toBeGreaterThan(0);
    expect(screen.queryByText(/500 Internal Server Error/)).not.toBeInTheDocument();
  });

  it("starts a full server-side run and saves operator-controlled thresholds", () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const onSaveBrandTerms = vi.fn().mockResolvedValue(undefined);
    const onSavePolicy = vi.fn().mockResolvedValue(undefined);
    const onStampPrecurated = vi.fn().mockResolvedValue(undefined);
    render(
      <AutonomousPipelinePanel
        archived={false}
        onSaveBrandTerms={onSaveBrandTerms}
        onRun={onRun}
        onSavePolicy={onSavePolicy}
        onStampPrecurated={onStampPrecurated}
        readiness={readiness}
        run={null}
        running={false}
        savingBrandTerms={false}
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

    fireEvent.change(screen.getByLabelText("Brand terms"), {
      target: { value: "Northstar, Northstar Home, N Star" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save terms" }));
    expect(onSaveBrandTerms).toHaveBeenCalledWith([
      "Northstar",
      "Northstar Home",
      "N Star",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Mark manual set as pre-curated" }),
    );
    expect(onStampPrecurated).toHaveBeenCalledOnce();
  });
});
