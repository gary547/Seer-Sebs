import type { PipelineStageId } from "./definition.js";

const STAGE_FAILURE_MESSAGES: Partial<Record<PipelineStageId, string>> = {
  backlinks:
    "Ahrefs backlink metrics could not be retrieved after automatic retries. Saved progress is preserved; resume after checking Ahrefs API access and usage.",
  detox:
    "Keyword qualification did not finish after automatic retries. Project data was left unchanged; resume the pipeline to try again.",
  "site-architecture":
    "Claude content-fit scoring did not finish after 30 attempts. Saved project data was left unchanged; resume the pipeline to try again.",
};

const TECHNICAL_FAILURE_PATTERN =
  /HTTP server responded|internal_error|x-cloud-trace|traceparent|application\/json|\b5\d\d\b|\{\s*"(?:body|code|headers|message)"/i;

export function pipelineStageFailureMessage(stageId: PipelineStageId): string {
  return (
    STAGE_FAILURE_MESSAGES[stageId] ??
    "This calculation step did not finish after automatic retries. Saved progress is preserved; resume the pipeline to try again."
  );
}

export function userFacingPipelineFailureMessage(
  stageId: PipelineStageId,
  message: string | null,
): string {
  const trimmed = message?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed || TECHNICAL_FAILURE_PATTERN.test(trimmed)) {
    return pipelineStageFailureMessage(stageId);
  }
  return trimmed;
}
