import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export const PIPELINE_STAGE_IDS = [
  "intake",
  "gsc-promotion",
  "detox",
  "categorisation",
  "brand-classification",
  "keyword-enrichment",
  "ranking-url",
  "gsc-intent",
  "serp-collection",
  "authority",
  "backlinks",
  "site-architecture",
  "link-power-score",
  "demand-signals",
  "ctr-curves",
  "clustering",
  "har-v2",
  "revenue-v2",
  "calibration",
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];
export type PipelineStageState =
  | "failed"
  | "pending"
  | "queued"
  | "running"
  | "succeeded";

export interface PipelineStage {
  attempts: number;
  completedAt: string | null;
  dependencies: PipelineStageId[];
  execution: "api" | "job" | "tasks";
  id: PipelineStageId;
  startedAt: string | null;
  state: PipelineStageState;
}

export interface PipelineRun {
  completedAt: string | null;
  createdAt: string;
  deliveredEventCount: number;
  id: string;
  input: unknown;
  stages: PipelineStage[];
  startedAt: string | null;
  status: "failed" | "pending" | "running" | "succeeded";
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export async function startProjectPipeline(
  projectId: string,
): Promise<{ id: string; stageCount: number; status: string }> {
  return authenticatedRequest(`/v1/projects/${projectId}/pipeline-runs`, {
    method: "POST",
  });
}

export async function getPipelineRun(runId: string): Promise<PipelineRun> {
  return authenticatedRequest<PipelineRun>(
    `/v1/pipeline-runs/${runId}?includeOutput=false`,
  );
}

export async function getLatestProjectPipelineRun(
  projectId: string,
): Promise<{ projectId: string; run: PipelineRun | null }> {
  return authenticatedRequest(
    `/v1/projects/${projectId}/pipeline-runs?includeOutput=false`,
  );
}
