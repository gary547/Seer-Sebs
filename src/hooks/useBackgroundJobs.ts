import { useQuery } from "@tanstack/react-query";

import {
  getLatestProjectPipelineRun,
  type PipelineRun,
  type PipelineStage,
  type PipelineStageId,
} from "@/integrations/gcp/pipeline";

export type JobKind = "detox" | "categorisation" | "har" | "url_monitor";
export type JobState =
  | "running"
  | "queued"
  | "done"
  | "error"
  | "idle"
  | "scheduled";

export interface BackgroundJob {
  kind: JobKind;
  label: string;
  state: JobState;
  detail: string;
  progress: number | null;
  updatedAt: string | null;
  jobId?: string | null;
  lastError?: string | null;
  staleSeconds?: number | null;
}

function stageState(run: PipelineRun, stage: PipelineStage): JobState {
  if (stage.state === "succeeded") return "done";
  if (stage.state === "failed") return "error";
  if (stage.state === "running") return "running";
  if (stage.state === "queued") return "queued";
  return run.status === "running" || run.status === "pending"
    ? "queued"
    : "idle";
}

function stageJob(
  run: PipelineRun,
  stageId: PipelineStageId,
  kind: JobKind,
  label: string,
): BackgroundJob {
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    return {
      detail: "Not run yet",
      kind,
      label,
      progress: null,
      state: "idle",
      updatedAt: null,
    };
  }
  const state = stageState(run, stage);
  return {
    detail:
      state === "done"
        ? `Completed${stage.attempts > 1 ? ` after ${stage.attempts} attempts` : ""}`
        : state === "error"
          ? `Failed after ${stage.attempts} attempts`
          : state === "running"
            ? `Running · attempt ${Math.max(1, stage.attempts)}`
            : state === "queued"
              ? "Waiting in the project pipeline"
              : "Not run yet",
    jobId: run.id,
    kind,
    label,
    lastError:
      state === "error"
        ? `${label} failed in pipeline ${run.id}.`
        : null,
    progress: state === "done" ? 1 : state === "running" ? 0.5 : 0,
    state,
    updatedAt:
      stage.completedAt ??
      stage.startedAt ??
      run.startedAt ??
      run.createdAt,
  };
}

function groupedJob(
  run: PipelineRun,
  stageIds: PipelineStageId[],
  kind: JobKind,
  label: string,
): BackgroundJob {
  const stages = stageIds
    .map((stageId) =>
      run.stages.find((candidate) => candidate.id === stageId),
    )
    .filter((stage): stage is PipelineStage => Boolean(stage));
  const completed = stages.filter(
    (stage) => stage.state === "succeeded",
  ).length;
  const failed = stages.find((stage) => stage.state === "failed");
  const running = stages.find((stage) => stage.state === "running");
  const queued = stages.find((stage) => stage.state === "queued");
  const state: JobState = failed
    ? "error"
    : completed === stages.length && stages.length > 0
      ? "done"
      : running
        ? "running"
        : queued || run.status === "running" || run.status === "pending"
          ? "queued"
          : "idle";
  const latestTimestamp = stages
    .flatMap((stage) => [stage.completedAt, stage.startedAt])
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    detail:
      state === "error"
        ? `${failed?.id ?? label} failed after ${failed?.attempts ?? 0} attempts`
        : state === "done"
          ? `${completed}/${stages.length} stages completed`
          : `${completed}/${stages.length} stages completed`,
    jobId: run.id,
    kind,
    label,
    lastError: failed
      ? `${failed.id} failed in pipeline ${run.id}.`
      : null,
    progress: stages.length > 0 ? completed / stages.length : null,
    state,
    updatedAt:
      latestTimestamp ?? run.startedAt ?? run.createdAt,
  };
}

function jobsFromRun(run: PipelineRun | null): BackgroundJob[] {
  if (!run) {
    return [
      {
        detail: "Not run yet",
        kind: "detox",
        label: "Detox",
        progress: null,
        state: "idle",
        updatedAt: null,
      },
      {
        detail: "Not run yet",
        kind: "categorisation",
        label: "Categorisation",
        progress: null,
        state: "idle",
        updatedAt: null,
      },
      {
        detail: "Not run yet",
        kind: "har",
        label: "HAR / SERP",
        progress: null,
        state: "idle",
        updatedAt: null,
      },
    ];
  }
  return [
    stageJob(run, "detox", "detox", "Detox"),
    stageJob(run, "categorisation", "categorisation", "Categorisation"),
    groupedJob(
      run,
      [
        "serp-collection",
        "authority",
        "backlinks",
        "site-architecture",
        "link-power-score",
        "har-v2",
      ],
      "har",
      "HAR / SERP",
    ),
  ];
}

export function useBackgroundJobs(projectId: string | undefined) {
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: async (): Promise<BackgroundJob[]> => {
      if (!projectId) return [];
      const latest = await getLatestProjectPipelineRun(projectId);
      return jobsFromRun(latest.run);
    },
    queryKey: ["background_jobs", projectId],
    refetchInterval: (query) => {
      const jobs = query.state.data as BackgroundJob[] | undefined;
      return jobs?.some(
        (job) => job.state === "running" || job.state === "queued",
      )
        ? 2_000
        : 30_000;
    },
  });
}
