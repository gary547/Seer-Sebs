import type { PipelineStage } from "@/integrations/gcp/pipeline";

const TECHNICAL_ERROR_PATTERN =
  /(?:internal server error|workflow execution|traceback|x-cloud-trace|http[^a-z]*(?:500|error)|status(?: code)?[^0-9]*500|500.{0,32}(?:error|failed|exception))/i;

export function pipelineActivityMessage(stage: PipelineStage | undefined): string {
  const message = stage?.progress?.message?.trim();
  if (message && !TECHNICAL_ERROR_PATTERN.test(message)) return message;
  if (message) {
    return stage?.state === "failed"
      ? "This stage did not finish. Saved progress is preserved and the run can be resumed safely."
      : "The stage is retrying safely. Saved progress is preserved.";
  }
  if (!stage || stage.state === "pending" || stage.state === "queued") {
    return "Waiting for dependencies";
  }
  if (stage.state === "running") return "In progress";
  if (stage.state === "succeeded") return "Completed";
  return "This stage did not finish. Saved progress is preserved.";
}
