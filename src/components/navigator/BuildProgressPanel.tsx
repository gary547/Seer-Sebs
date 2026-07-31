import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Clock, SkipForward, Coffee, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { formatElapsed, type Phase, type PhaseStatus } from "@/hooks/useNavigatorSync";

interface Props {
  phases: Phase[];
  running: boolean;
  completedAt: Date | null;
  runStartedAt: number | null;
  activePhaseKey: string | null;
  activePhaseStartedAt: number | null;
  onViewForecast: () => void;
}

const StatusIcon = ({ status }: { status: PhaseStatus }) => {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-accent" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    case "error":
      return <XCircle className="h-4 w-4 text-destructive" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground/50" />;
  }
};

/**
 * Inline build-progress card shown on the Keywords tab of brand-new projects
 * (gated upstream on `last_synced_at IS NULL`). Mirrors the SyncNowPanel
 * phase list but in a larger, friendlier first-run layout. Phase data comes
 * straight from the shared `useNavigatorSync` hook so the pipeline is
 * byte-identical to the header Sync Now button.
 */
export default function BuildProgressPanel({
  phases,
  running,
  completedAt,
  runStartedAt,
  activePhaseKey,
  activePhaseStartedAt,
  onViewForecast,
}: Props) {
  const hasError = phases.some((p) => p.status === "error");
  const allTerminal = !running && phases.every((p) => p.status !== "pending" && p.status !== "running");
  const buildSucceeded = !!completedAt && !hasError;

  return (
    <Card className="p-5 border-primary/20 bg-gradient-to-br from-background to-primary/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            {running && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {buildSucceeded ? "Forecast ready" : running ? "Building your forecast" : "Build paused"}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {buildSucceeded
              ? `Completed ${formatDistanceToNow(completedAt!, { addSuffix: true })}.`
              : running
                ? "You can safely leave this page — progress resumes on your next visit."
                : "Resolve the error below or press Run Pipeline to retry."}
          </p>
        </div>
        {running && runStartedAt && (
          <Badge variant="secondary" className="text-[10px] h-5">
            {formatElapsed(Date.now() - runStartedAt)} elapsed
          </Badge>
        )}
      </div>

      {running && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-[11px] text-foreground">
          <Coffee className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          <div className="leading-snug">
            <span className="font-semibold">First builds typically take 5–10 minutes.</span>{" "}
            We're calling DataForSEO, Ahrefs and Claude in the background — feel free to grab a brew.
          </div>
        </div>
      )}

      <ul className="space-y-2.5">
        {phases.map((phase) => {
          const isActive =
            phase.status === "running" &&
            phase.key === activePhaseKey &&
            activePhaseStartedAt != null;
          const phaseElapsed = isActive ? formatElapsed(Date.now() - (activePhaseStartedAt ?? 0)) : null;
          return (
            <li key={phase.key} className="flex items-start gap-2.5 text-xs">
              <div className="mt-0.5">
                <StatusIcon status={phase.status} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{phase.label}</span>
                  {phaseElapsed && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {phaseElapsed}
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground text-[11px]">
                  {phase.detail || phase.description}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {buildSucceeded && (
        <div className="mt-4 pt-4 border-t border-border flex justify-end">
          <Button onClick={onViewForecast} size="sm" className="gap-1.5">
            View forecast
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}
