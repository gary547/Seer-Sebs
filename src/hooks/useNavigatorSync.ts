import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  getPipelineRun,
  PIPELINE_STAGE_IDS,
  resolvePipelineFailure,
  startProjectPipeline,
  type PipelineRun,
  type PipelineStageId,
} from "@/integrations/gcp/pipeline";

export type PhaseStatus = "pending" | "running" | "skipped" | "done" | "error";

export interface Phase {
  key: PipelineStageId;
  label: string;
  description: string;
  status: PhaseStatus;
  detail?: string;
}

const phaseDefinitions: ReadonlyArray<
  Omit<Phase, "status">
> = [
  { key: "intake", label: "Intake", description: "Load and reconcile project inputs" },
  { key: "gsc-promotion", label: "GSC promotion", description: "Promote eligible Search Console queries" },
  { key: "detox", label: "Keyword detox", description: "Apply qualification and exclusion rules" },
  { key: "categorisation", label: "Categorisation", description: "Assign taxonomy, tier and intent" },
  { key: "brand-classification", label: "Brand classification", description: "Classify branded and non-branded demand" },
  { key: "keyword-enrichment", label: "Keyword enrichment", description: "Resolve volume, difficulty and intent" },
  { key: "ranking-url", label: "Ranking URLs", description: "Resolve the current client ranking URL" },
  { key: "gsc-intent", label: "GSC intent", description: "Enrich Search Console query intent" },
  { key: "serp-collection", label: "SERP collection", description: "Collect current search-result evidence" },
  { key: "authority", label: "Authority", description: "Resolve domain and URL authority" },
  { key: "backlinks", label: "Backlinks", description: "Collect backlink evidence" },
  { key: "site-architecture", label: "Site architecture", description: "Score keyword-to-page fit" },
  { key: "link-power-score", label: "Link power", description: "Calculate comparable link power" },
  { key: "demand-signals", label: "Demand signals", description: "Build seasonality and demand history" },
  { key: "ctr-curves", label: "CTR curves", description: "Resolve project CTR curves" },
  { key: "clustering", label: "Clustering", description: "Build canonical keyword clusters" },
  { key: "har-v2", label: "HAR forecast", description: "Calculate attainable ranking scenarios" },
  { key: "revenue-v2", label: "Revenue forecast", description: "Calculate monthly revenue scenarios" },
  { key: "calibration", label: "Calibration", description: "Run the final promotion gate" },
];

export const initialPhases: Phase[] = phaseDefinitions.map((phase) => ({
  ...phase,
  status: "pending",
}));

export const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
};

interface Options {
  projectId: string;
  stalenessDays?: number;
}

export interface BlockedDetox {
  projectId: string;
  jobId: string;
  message: string;
  reason: string;
}

function phasesFromRun(run: PipelineRun): Phase[] {
  const byId = new Map(run.stages.map((stage) => [stage.id, stage]));
  return phaseDefinitions.map((definition) => {
    const stage = byId.get(definition.key);
    if (!stage) return { ...definition, status: "pending" };
    const status: PhaseStatus =
      stage.state === "succeeded"
        ? "done"
        : stage.state === "failed"
          ? "error"
          : stage.state === "running" || stage.state === "queued"
            ? "running"
            : "pending";
    const detail =
      status === "done"
        ? `Completed${stage.attempts > 1 ? ` after ${stage.attempts} attempts` : ""}`
        : status === "error"
          ? `Failed after ${stage.attempts} attempts`
          : status === "running"
            ? `Running${stage.attempts > 0 ? ` · attempt ${stage.attempts}` : ""}`
            : undefined;
    return { ...definition, detail, status };
  });
}

function currentPhase(run: PipelineRun): PipelineStageId | null {
  const active = run.stages.find(
    (stage) => stage.state === "running" || stage.state === "queued",
  );
  if (active) return active.id;
  const failed = run.stages.find((stage) => stage.state === "failed");
  if (failed) return failed.id;
  return (
    PIPELINE_STAGE_IDS.find(
      (stageId) =>
        run.stages.find((stage) => stage.id === stageId)?.state !== "succeeded",
    ) ?? null
  );
}

export function useNavigatorSync({ projectId }: Options) {
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const activePhaseRef = useRef<PipelineStageId | null>(null);
  const [running, setRunning] = useState(false);
  const [phases, setPhases] = useState<Phase[]>(initialPhases);
  const [completedAt, setCompletedAt] = useState<Date | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [activePhaseStartedAt, setActivePhaseStartedAt] = useState<number | null>(null);
  const [activePhaseKey, setActivePhaseKey] = useState<PipelineStageId | null>(null);
  const [, setNowTick] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNowTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const runSync = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setCompletedAt(null);
    setRunStartedAt(Date.now());
    setActivePhaseKey("intake");
    activePhaseRef.current = "intake";
    setActivePhaseStartedAt(Date.now());
    setPhases(initialPhases.map((phase) => ({ ...phase })));

    try {
      const created = await startProjectPipeline(projectId);
      let previousActive: PipelineStageId | null = "intake";

      while (true) {
        const run = await getPipelineRun(created.id);
        if (!mounted.current) return;
        const active = currentPhase(run);
        setPhases(phasesFromRun(run));
        setActivePhaseKey(active);
        activePhaseRef.current = active;
        if (active !== previousActive) {
          setActivePhaseStartedAt(active ? Date.now() : null);
          previousActive = active;
        }

        if (run.status === "succeeded") {
          const finishedAt = run.completedAt ? new Date(run.completedAt) : new Date();
          setCompletedAt(finishedAt);
          setRunning(false);
          setActivePhaseKey(null);
          activePhaseRef.current = null;
          setActivePhaseStartedAt(null);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["project_sync_state", projectId] }),
            queryClient.invalidateQueries({ queryKey: ["project-data", projectId] }),
            queryClient.invalidateQueries({ queryKey: ["keywords", projectId] }),
            queryClient.invalidateQueries({ queryKey: ["keywords_kept_count", projectId] }),
            queryClient.invalidateQueries({ queryKey: ["has_forecasts", projectId] }),
          ]);
          toast.success("Pipeline complete", {
            description: "All 24 stages completed successfully.",
          });
          return;
        }

        if (run.status === "failed") {
          const failedStage = resolvePipelineFailure(run);
          throw new Error(
            failedStage
              ? failedStage.message ??
                  `${failedStage.stageId} failed after ${failedStage.attempts} attempts`
              : "The pipeline failed.",
          );
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : "The pipeline failed.";
      setRunning(false);
      setCompletedAt(null);
      setActivePhaseStartedAt(null);
      const failedPhase = activePhaseRef.current;
      activePhaseRef.current = null;
      setPhases((current) =>
        current.map((phase) =>
          phase.key === failedPhase
            ? { ...phase, detail: message, status: "error" }
            : phase,
        ),
      );
      toast.error("Pipeline failed", { description: message });
    }
  }, [projectId, queryClient, running]);

  const skipDetox = useCallback(async () => undefined, []);
  const dismissBlockedDetox = useCallback(() => undefined, []);

  return {
    running,
    phases,
    completedAt,
    runStartedAt,
    activePhaseKey,
    activePhaseStartedAt,
    runSync,
    blockedDetox: null as BlockedDetox | null,
    skipDetox,
    dismissBlockedDetox,
  };
}
