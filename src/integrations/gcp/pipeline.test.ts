import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
}));

import {
  PIPELINE_OUTPUT_BATCH_SIZE,
  PIPELINE_STAGE_IDS,
  chunkPipelineStageIds,
  getPipelineRunWithOutputs,
  mergePipelineRunOutputs,
  resolvePipelineFailure,
  type PipelineRun,
  type PipelineStage,
  type PipelineStageOutputPage,
} from "./pipeline";

function stage(id: PipelineStage["id"], output?: PipelineStage["output"]): PipelineStage {
  return {
    attempts: 1,
    completedAt: "2026-08-18T12:00:00.000Z",
    dependencies: [],
    execution: "job",
    id,
    ...(output === undefined ? {} : { output }),
    startedAt: "2026-08-18T11:00:00.000Z",
    state: "succeeded",
  };
}

function run(
  stages: PipelineStage[],
  status: PipelineRun["status"] = "succeeded",
): PipelineRun {
  return {
    completedAt: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T10:00:00.000Z",
    deliveredEventCount: 24,
    id: "run-1",
    input: { projectId: "project-1" },
    stages,
    startedAt: "2026-08-18T11:00:00.000Z",
    status,
  };
}

describe("pipeline output batching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("splits the 24-stage pipeline into frontend-sized batches", () => {
    const batches = chunkPipelineStageIds();
    expect(batches.flat()).toEqual([...PIPELINE_STAGE_IDS]);
    expect(batches.every((batch) => batch.length <= PIPELINE_OUTPUT_BATCH_SIZE)).toBe(
      true,
    );
    expect(batches).toHaveLength(
      Math.ceil(PIPELINE_STAGE_IDS.length / PIPELINE_OUTPUT_BATCH_SIZE),
    );
  });

  it("merges batched stage payloads onto the lightweight run", () => {
    const assembled = mergePipelineRunOutputs(
      run([stage("intake"), stage("detox")]),
      [
        {
          runId: "run-1",
          stages: [{ ...stage("intake"), output: { accepted: 12 } }],
        },
        {
          runId: "run-1",
          stages: [{ ...stage("detox"), output: { removed: 3 } }],
        },
      ],
    );

    expect(assembled.stages[0]?.output).toEqual({ accepted: 12 });
    expect(assembled.stages[1]?.output).toEqual({ removed: 3 });
  });

  it("loads a full run by requesting stage outputs in batches", async () => {
    const lightweight = run(PIPELINE_STAGE_IDS.map((id) => stage(id)));
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("includeOutput=false")) {
          return new Response(JSON.stringify(lightweight), { status: 200 });
        }
        const ids = new URL(url, "https://seer.local").searchParams.get("ids") ?? "";
        const page: PipelineStageOutputPage = {
          runId: "run-1",
          stages: ids.split(",").map((id) =>
            stage(id as PipelineStage["id"], { id }),
          ),
        };
        return new Response(JSON.stringify(page), { status: 200 });
      }),
    );

    const assembled = await getPipelineRunWithOutputs("run-1");

    expect(requests[0]).toContain("/v1/pipeline-runs/run-1?includeOutput=false");
    expect(requests.slice(1)).toHaveLength(
      Math.ceil(PIPELINE_STAGE_IDS.length / PIPELINE_OUTPUT_BATCH_SIZE),
    );
    expect(requests[1]).toContain("/v1/pipeline-runs/run-1/stages?ids=");
    expect(assembled.stages).toHaveLength(24);
    expect(assembled.stages[0]?.output).toEqual({ id: "intake" });
    expect(assembled.stages.at(-1)?.output).toEqual({ id: "rollup-output" });
  });
});

describe("pipeline failure attribution", () => {
  it("uses the recorded failed stage instead of the first cascaded failure", () => {
    const failed = run(
      [
        { ...stage("categorisation"), attempts: 0, state: "failed", output: {
          failedStage: "keyword-enrichment",
          reason: "pipeline_failed",
        } },
        { ...stage("keyword-enrichment"), attempts: 3, state: "failed", output: {
          failedStage: "keyword-enrichment",
          message: "Keyword enrichment paused after persisting progress. 18000 keywords remaining.",
          reason: "pipeline_failed",
        } },
      ],
      "failed",
    );

    expect(resolvePipelineFailure(failed)).toEqual({
      attempts: 3,
      message:
        "Keyword enrichment paused after persisting progress. 18000 keywords remaining.",
      stageId: "keyword-enrichment",
    });
  });
});
