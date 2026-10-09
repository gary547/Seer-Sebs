import { setImmediate } from "node:timers/promises";

import type { ProjectPipelineSource } from "../../../packages/fixtures/src/representative-project.js";
import type { PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import { executeDataDrivenStageChunks } from "../../../packages/pipeline/src/stage-handlers.js";

export async function executeCooperativeStage(
  stageId: PipelineStageId,
  source: ProjectPipelineSource,
  outputs: Parameters<typeof executeDataDrivenStageChunks>[2],
) {
  const chunks = executeDataDrivenStageChunks(stageId, source, outputs);
  let result = chunks.next();
  while (!result.done) {
    await setImmediate();
    result = chunks.next();
  }
  return result.value;
}
