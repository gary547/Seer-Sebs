const PIPELINE_OUTPUT_BATCH_SIZE = 4;

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

  return {
    ...run,
    stages: (run.stages ?? []).map((stage) => ({
      ...stage,
      output: outputs.has(stage.id) ? outputs.get(stage.id) : stage.output,
    })),
  };
}
