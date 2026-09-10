import type { PipelineStageId } from "./definition.js";

const STAGE_FAILURE_MESSAGES: Partial<Record<PipelineStageId, string>> = {
  "har-readiness":
    "Forecast inputs are incomplete for retained keywords. Check SERP coverage, volume eligibility, authority and content-fit diagnostics before resuming.",
  "revenue-readiness":
    "Revenue inputs are incomplete. Check search volume, HAR outcomes and conversion assumptions for every retained keyword before resuming.",
  "rollup-output":
    "Final results are incomplete: every retained keyword needs a valid forecast in all three scenarios. Review HAR and Revenue diagnostics before resuming; partial results are not finalised.",
  backlinks:
    "DataForSEO backlink metrics could not be retrieved. Saved progress is preserved; check Backlinks API access and usage before resuming.",
  detox:
    "Keyword qualification did not finish after automatic retries. Project data was left unchanged; resume the pipeline to try again.",
  "site-architecture":
    "OpenRouter content-fit scoring did not finish after automatic retries. Saved progress is preserved; check OpenRouter access before resuming.",
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
