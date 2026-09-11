import assert from "node:assert/strict";
import { createDatabasePool } from "../../dist/gcp/packages/runtime/src/database.js";
import { loadStageOutput } from "../../dist/gcp/packages/runtime/src/stage-output.js";

const PIPELINE_OUTPUT_BATCH_SIZE = 1;

export async function attachPipelineRunOutputs({
  apiBaseUrl,
  jsonRequest,
  requestInit,
  run,
}) {
  const ids = (run.stages ?? []).map((stage) => stage.id);
  const outputs = new Map();

  for (let index = 0; index < ids.length; index += PIPELINE_OUTPUT_BATCH_SIZE) {
    const batch = ids.slice(index, index + PIPELINE_OUTPUT_BATCH_SIZE);
    if (batch.length === 0) continue;
    const query = new URLSearchParams({ ids: batch.join(",") });
    const page = await jsonRequest(
      `${apiBaseUrl}/v1/pipeline-runs/${run.id}/stages?${query.toString()}`,
      requestInit,
    );
    for (const stage of page.stages ?? []) {
      outputs.set(stage.id, stage.output);
    }
  }

  const stages = (run.stages ?? []).map((stage) => ({
    ...stage,
    output: outputs.has(stage.id) ? outputs.get(stage.id) : stage.output,
  }));
  if (stages.some(stage => stage.output?.stageOutputStorage)) {
    assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(apiBaseUrl).hostname),
      "Private stage-output reconstruction is restricted to local integration tests.");
    const pool = createDatabasePool("postgresql://seer_worker_local:local-worker-only@127.0.0.1:25432/seer");
    try {
      for (const stage of stages) stage.output = await loadStageOutput(pool, run.id, stage.id, stage.output);
    } finally { await pool.end(); }
  }
  return { ...run, stages };
}
