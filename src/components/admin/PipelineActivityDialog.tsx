import {
  Activity,
  Check,
  CircleDashed,
  Clock3,
  ListTree,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  PIPELINE_STAGE_IDS,
  type PipelineRun,
  type PipelineStage,
  type PipelineStageId,
  type PipelineStageState,
} from "@/integrations/gcp/pipeline";
import { cn } from "@/lib/utils";
import { pipelineActivityMessage } from "./pipelineActivity";

function stageLabel(id: PipelineStageId): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function dateTime(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
  }).format(new Date(value));
}

function StateIcon({ state }: { state: PipelineStageState | "idle" }) {
  if (state === "succeeded") return <Check className="h-3.5 w-3.5" />;
  if (state === "failed") return <TriangleAlert className="h-3.5 w-3.5" />;
  if (state === "running") return <Activity className="h-3.5 w-3.5 animate-pulse" />;
  if (state === "queued") return <Clock3 className="h-3.5 w-3.5" />;
  return <CircleDashed className="h-3.5 w-3.5" />;
}

function stateClasses(state: PipelineStageState | "idle"): string {
  if (state === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (state === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (state === "running") return "border-signal/40 bg-signal/10 text-signal";
  return "border-hairline bg-canvas text-ink-muted";
}

function stageProgress(stage: PipelineStage | undefined): number {
  if (stage?.progress?.percent != null) return stage.progress.percent;
  return stage?.state === "succeeded" ? 100 : 0;
}

function ActivityStage({
  id,
  index,
  stage,
}: {
  id: PipelineStageId;
  index: number;
  stage: PipelineStage | undefined;
}) {
  const state = stage?.state ?? "idle";
  const startedAt = dateTime(stage?.startedAt ?? null);
  const completedAt = dateTime(stage?.completedAt ?? null);
  const percent = stageProgress(stage);
  const indeterminate = state === "running" && stage?.progress?.percent == null;

  return (
    <li
      className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3"
      data-testid={`pipeline-activity-stage-${id}`}
    >
      {index < PIPELINE_STAGE_IDS.length - 1 ? (
        <span className="absolute bottom-[-1rem] left-[0.9375rem] top-8 w-px bg-hairline" />
      ) : null}
      <div
        className={cn(
          "relative z-10 mt-3 flex h-8 w-8 items-center justify-center rounded-full border",
          stateClasses(state),
        )}
      >
        <StateIcon state={state} />
      </div>

      <article
        className={cn(
          "rounded-lg border px-4 py-3.5 transition-colors",
          state === "running"
            ? "border-signal/30 bg-signal/[0.035] shadow-sm"
            : state === "failed"
              ? "border-destructive/25 bg-destructive/[0.025]"
              : "border-hairline bg-canvas/45",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-sm font-semibold text-ink">{stageLabel(id)}</h3>
              {state === "running" ? (
                <Badge className="border-signal/30 bg-signal/10 text-[10px] text-signal" variant="outline">
                  Live
                </Badge>
              ) : null}
            </div>
            <p
              aria-live={state === "running" ? "polite" : undefined}
              className="mt-1.5 text-xs leading-5 text-ink-muted"
            >
              {pipelineActivityMessage(stage)}
            </p>
          </div>
          <Badge className={cn("shrink-0 capitalize", stateClasses(state))} variant="outline">
            {state}
          </Badge>
        </div>

        <Progress
          aria-label={`${stageLabel(id)} activity progress`}
          className={cn("mt-3 h-1.5 bg-surface", indeterminate && "animate-pulse")}
          value={indeterminate ? 35 : percent}
        />

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-2.5 font-mono text-[10px] text-ink-muted">
          <span>{stage?.execution ?? "job"}</span>
          <span>{stage?.attempts ?? 0} attempt{stage?.attempts === 1 ? "" : "s"}</span>
          {startedAt ? <span>Started {startedAt}</span> : null}
          {completedAt ? <span>Finished {completedAt}</span> : null}
          {stage?.progress?.total != null ? (
            <span>
              {stage.progress.done ?? 0}/{stage.progress.total} {stage.progress.unit ?? "steps"}
            </span>
          ) : null}
        </div>
      </article>
    </li>
  );
}

export default function PipelineActivityDialog({ run }: { run: PipelineRun | null }) {
  const succeeded = run?.stages.filter((stage) => stage.state === "succeeded").length ?? 0;
  const active = run?.stages.filter(
    (stage) => stage.state === "running" || stage.state === "queued",
  ).length ?? 0;
  const failed = run?.stages.filter((stage) => stage.state === "failed").length ?? 0;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button data-testid="open-pipeline-activity" disabled={!run} size="sm" variant="outline">
          <ListTree className="h-3.5 w-3.5" />
          View full activity
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-5xl gap-0 overflow-hidden border-hairline bg-surface p-0 shadow-2xl"
        data-testid="pipeline-activity-dialog"
      >
        <DialogHeader className="border-b border-hairline bg-canvas/65 px-6 py-5 pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-xl text-ink">Pipeline activity</DialogTitle>
            {run?.status === "running" ? (
              <Badge className="border-signal/30 bg-signal/10 text-signal" variant="outline">
                <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
                Live
              </Badge>
            ) : (
              <Badge className="capitalize" variant="outline">{run?.status ?? "idle"}</Badge>
            )}
          </div>
          <DialogDescription className="font-mono text-xs text-ink-muted">
            {run
              ? `Run ${run.id} · sanitized operator activity`
              : "No pipeline run is available."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 border-b border-hairline bg-surface sm:grid-cols-6">
          {[
            ["Complete", succeeded],
            ["Active", active],
            ["Issues", failed],
            ["Stages", run?.stages.length ?? PIPELINE_STAGE_IDS.length],
            ["Events", run?.deliveredEventCount ?? 0],
            ["Started", dateTime(run?.startedAt ?? null) ?? "—"],
          ].map(([label, value]) => (
            <div className="border-r border-hairline px-3 py-3 last:border-r-0" key={String(label)}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                {label}
              </p>
              <p className="mt-1 truncate font-mono text-xs font-semibold text-ink">{value}</p>
            </div>
          ))}
        </div>

        <div className="max-h-[66vh] overflow-y-auto px-5 py-5 sm:px-6">
          <ol className="space-y-4">
            {PIPELINE_STAGE_IDS.map((id, index) => (
              <ActivityStage
                id={id}
                index={index}
                key={id}
                stage={run?.stages.find((stage) => stage.id === id)}
              />
            ))}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  );
}
