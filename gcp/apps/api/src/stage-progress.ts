import type { PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import { userFacingPipelineFailureMessage } from "../../../packages/pipeline/src/failure-messages.js";

export interface StageWorkCounts {
  failed: number;
  lastError: string | null;
  pending: number;
  submitted: number;
  succeeded: number;
  total: number;
}

export interface StageProgress {
  done: number | null;
  failed: number;
  message: string;
  pending: number;
  percent: number | null;
  submitted: number;
  total: number | null;
  unit: "items" | null;
}

const RUNNING_HINT: Record<PipelineStageId, string> = {
  intake: "Loading project inputs",
  "gsc-promotion": "Promoting GSC queries into keywords",
  detox: "Applying qualification rules and saving keyword decisions in batches",
  preflight: "Checking authority and provider readiness",
  categorisation: "Assigning keyword categories",
  "brand-classification": "Detecting brand terms",
  "keyword-enrichment": "Fetching search volumes",
  clustering: "Grouping related keywords",
  "historical-volume": "Loading monthly volume history",
  "ranking-url": "Resolving ranking URLs",
  "gsc-intent": "Classifying search intent",
  "serp-collection": "Collecting Google SERP results",
  authority: "Refreshing client domain authority",
  backlinks: "Fetching URL ratings and backlinks",
  "site-architecture":
    "Scoring ranking-page content fit with Claude; transient failures retry every 2s",
  "link-power-score": "Computing link-power scores",
  "demand-signals": "Measuring demand trend and seasonality",
  "ctr-curves": "Building CTR curves",
  "har-readiness": "Checking HAR inputs",
  "har-v2": "Forecasting attainable rank",
  "revenue-readiness": "Checking revenue inputs",
  "revenue-v2": "Forecasting incremental revenue",
  calibration: "Calibrating model vs GSC",
  "rollup-output": "Writing cluster and category rollups",
};

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

export function formatElapsed(startedAt: Date, endedAt: Date): string {
  const seconds = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = seconds / 60;
    return `${minutes < 10 ? minutes.toFixed(1) : minutes.toFixed(0)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

function compactError(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

export function buildStageProgress(input: {
  attempts: number;
  completedAt: Date | null;
  id: PipelineStageId;
  now: Date;
  outputMessage: string | null;
  startedAt: Date | null;
  state: string;
  waitingOn: readonly string[];
  work: StageWorkCounts | null;
}): StageProgress {
  const work = input.work && input.work.total > 0 ? input.work : null;
  const percent =
    input.state === "succeeded"
      ? 100
      : input.state === "pending" || input.state === "queued"
        ? 0
        : work
          ? Math.min(100, Math.round((work.succeeded / work.total) * 100))
          : null;
  const parts: string[] = [];

  if (input.state === "pending" || input.state === "queued") {
    parts.push(
      input.waitingOn.length > 0
        ? `Waiting on ${input.waitingOn.join(", ")}`
        : "Queued",
    );
  } else if (input.state === "succeeded") {
    if (input.startedAt && input.completedAt) {
      parts.push(`Completed in ${formatElapsed(input.startedAt, input.completedAt)}`);
    } else {
      parts.push("Completed");
    }
    if (work) parts.push(`${formatCount(work.succeeded)} items`);
  } else if (input.state === "failed") {
    parts.push(
      compactError(
        userFacingPipelineFailureMessage(input.id, input.outputMessage),
      ) ??
        compactError(work?.lastError ?? null) ??
        `Failed after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"}`,
    );
    if (work) {
      parts.push(
        `${formatCount(work.succeeded)} of ${formatCount(work.total)} items`,
      );
    }
  } else {
    if (work) {
      parts.push(
        `${formatCount(work.succeeded)} of ${formatCount(work.total)} items done`,
      );
      if (work.submitted > 0) {
        parts.push(`${formatCount(work.submitted)} in flight`);
      }
      if (work.failed > 0) {
        parts.push(`${formatCount(work.failed)} failed`);
      }
    } else {
      parts.push(
        compactError(input.outputMessage) ??
          RUNNING_HINT[input.id] ??
          "In progress",
      );
    }
    if (input.startedAt) {
      parts.push(`${formatElapsed(input.startedAt, input.now)} elapsed`);
    }
    if (input.attempts > 1) parts.push(`attempt ${input.attempts}`);
    const liveError = compactError(work?.lastError ?? null);
    if (liveError && work) parts.push(liveError);
  }

  return {
    done: work ? work.succeeded : input.state === "succeeded" ? 1 : null,
    failed: work?.failed ?? 0,
    message: parts.join(" · "),
    pending: work?.pending ?? 0,
    percent,
    submitted: work?.submitted ?? 0,
    total: work ? work.total : input.state === "succeeded" ? 1 : null,
    unit: work ? "items" : null,
  };
}
