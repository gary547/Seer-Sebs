import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export const PIPELINE_STAGE_IDS = [
  "intake",
  "gsc-promotion",
  "detox",
  "preflight",
  "categorisation",
  "brand-classification",
  "keyword-enrichment",
  "clustering",
  "historical-volume",
  "ranking-url",
  "gsc-intent",
  "serp-collection",
  "authority",
  "backlinks",
  "site-architecture",
  "link-power-score",
  "demand-signals",
  "ctr-curves",
  "har-readiness",
  "har-v2",
  "revenue-readiness",
  "revenue-v2",
  "calibration",
  "rollup-output",
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
  output?: Record<string, unknown> | null;
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

export interface PipelineReadiness {
  configuration: {
    brandTerms: string[];
    brandTermsSource: "domain_fallback" | "explicit" | "missing";
    explicitBrandTerms: string[];
  };
  dirty: { inputs: boolean; keywords: boolean; serp: boolean };
  gates: Array<{ id: string; label: string; ready: boolean }>;
  missing: string[];
  policy: {
    competitiveEnrichmentVolumeFloor: number;
    gscPromotionImpressionsFloor: number;
  };
  preview: {
    duplicateGscQueryCount: number;
    keptKeywordCount: number;
    latestGscQueryCount: number;
    manualKeywordCount: number;
    paidEligibleKeywordCount: number;
    promotableGscQueryCount: number;
  };
  projectId: string;
  ready: boolean;
  rollups: Array<{
    categoryRollup: Array<{
      category: string;
      expectedIncrementalAnnual: number;
      keywordCount: number;
    }>;
    clusterDedupedExpectedIncrementalAnnual: number;
    clusterRollup: Array<{
      canonicalKeywordId: string;
      clusterKey: string;
      expectedIncrementalAnnual: number;
      memberCount: number;
    }>;
    doubleCountAnnual: number;
    naiveExpectedIncrementalAnnual: number;
    quarterRollup: Array<{
      expectedIncrementalAnnual: number;
      keywordCount: number;
      quarter: "Q1" | "Q2" | "Q3" | "Q4" | "Unscheduled";
    }>;
    scenario: string;
    trendRollup: Array<{
      expectedIncrementalAnnual: number;
      keywordCount: number;
      trend: "declining" | "growing" | "insufficient_data" | "stable";
    }>;
  }>;
  substitutions: Array<{
    count: number;
    input: string;
    stageId: string;
    substitute: string;
  }>;
  providerSummary: {
    cacheEntriesAvailable: number;
    failed: number;
    maxAttempts: number;
    pending: number;
    submitted: number;
    succeeded: number;
  };
}

export async function markProjectKeywordsPrecurated(
  projectId: string,
): Promise<{ projectId: string; stampedKeywordCount: number }> {
  return authenticatedRequest(`/v1/projects/${projectId}/pipeline-precurated`, {
    method: "POST",
  });
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
  mode: "full" | "recalculate" | "resume" = "full",
): Promise<{ id: string; stageCount: number; status: string }> {
  return authenticatedRequest(`/v1/projects/${projectId}/pipeline-runs`, {
    body: JSON.stringify({ mode }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

export const PIPELINE_OUTPUT_BATCH_SIZE = 1;

export interface PipelineStageOutput {
  attempts: number;
  completedAt: string | null;
  id: PipelineStageId;
  output?: Record<string, unknown> | null;
  startedAt: string | null;
  state: PipelineStageState;
}

export interface PipelineStageOutputPage {
  runId: string;
  stages: PipelineStageOutput[];
}

export function chunkPipelineStageIds(
  stageIds: readonly PipelineStageId[] = PIPELINE_STAGE_IDS,
  batchSize = PIPELINE_OUTPUT_BATCH_SIZE,
): PipelineStageId[][] {
  const size = Math.max(1, batchSize);
  const batches: PipelineStageId[][] = [];
  for (let index = 0; index < stageIds.length; index += size) {
    batches.push(stageIds.slice(index, index + size));
  }
  return batches;
}

export function mergePipelineRunOutputs(
  run: PipelineRun,
  pages: readonly PipelineStageOutputPage[],
): PipelineRun {
  const outputs = new Map<PipelineStageId, Record<string, unknown> | null | undefined>();
  for (const page of pages) {
    for (const stage of page.stages) {
      outputs.set(stage.id, stage.output);
    }
  }
  return {
    ...run,
    stages: run.stages.map((stage) =>
      outputs.has(stage.id)
        ? { ...stage, output: outputs.get(stage.id) }
        : stage,
    ),
  };
}

export async function getPipelineRun(runId: string): Promise<PipelineRun> {
  return authenticatedRequest<PipelineRun>(
    `/v1/pipeline-runs/${runId}?includeOutput=false`,
  );
}

export async function getPipelineRunStageOutputs(
  runId: string,
  stageIds: readonly PipelineStageId[],
): Promise<PipelineStageOutputPage> {
  const query = new URLSearchParams({ ids: stageIds.join(",") });
  return authenticatedRequest<PipelineStageOutputPage>(
    `/v1/pipeline-runs/${runId}/stages?${query.toString()}`,
  );
}

export async function getPipelineRunWithOutputs(
  runId: string,
): Promise<PipelineRun> {
  const run = await getPipelineRun(runId);
  const pages: PipelineStageOutputPage[] = [];
  for (const batch of chunkPipelineStageIds(run.stages.map((stage) => stage.id))) {
    pages.push(await getPipelineRunStageOutputs(runId, batch));
  }
  return mergePipelineRunOutputs(run, pages);
}

export async function getLatestProjectPipelineRun(
  projectId: string,
): Promise<{ projectId: string; run: PipelineRun | null }> {
  return authenticatedRequest(
    `/v1/projects/${projectId}/pipeline-runs?includeOutput=false`,
  );
}

export async function getProjectPipelineReadiness(
  projectId: string,
): Promise<PipelineReadiness> {
  return authenticatedRequest(`/v1/projects/${projectId}/pipeline-readiness`);
}

export async function updateProjectPipelinePolicy(
  projectId: string,
  policy: PipelineReadiness["policy"],
): Promise<PipelineReadiness> {
  return authenticatedRequest(`/v1/projects/${projectId}/pipeline-readiness`, {
    body: JSON.stringify(policy),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}
