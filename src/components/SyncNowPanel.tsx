import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle2, XCircle, Loader2, Clock, SkipForward, X, AlertCircle, Play, Coffee } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useProjectSyncState, isProjectDirty } from "@/hooks/useProjectSyncState";
import { useNavigatorSync, formatElapsed, type PhaseStatus, type Phase, type BlockedDetox } from "@/hooks/useNavigatorSync";
import SkipDetoxDialog from "@/components/SkipDetoxDialog";

interface Props {
  projectId: string;
  /** Days before SERP/TP data is considered stale and refetched */
  stalenessDays?: number;
  /**
   * Optional shared sync state. When the parent page also renders the
   * first-run BuildProgressPanel, both surfaces must observe the same run —
   * otherwise pressing Sync Now from the header would spawn a second
   * concurrent pipeline. The parent owns the hook and passes its handles
   * through here so we render and trigger the same run.
   */
  sharedSync?: {
    running: boolean;
    phases: Phase[];
    completedAt: Date | null;
    runStartedAt: number | null;
    activePhaseKey: string | null;
    activePhaseStartedAt: number | null;
    runSync: () => Promise<void> | void;
    blockedDetox?: BlockedDetox | null;
    skipDetox?: () => Promise<void> | void;
    dismissBlockedDetox?: () => void;
  };
}


export default function SyncNowPanel({ projectId, stalenessDays = 7, sharedSync }: Props) {
  const [open, setOpen] = useState(false);

  const { data: syncState } = useProjectSyncState(projectId);
  const dirty = isProjectDirty(syncState);
  const firstRun = !syncState?.last_synced_at;

  const localSync = useNavigatorSync({ projectId, stalenessDays });
  const merged = sharedSync ?? localSync;
  const {
    running,
    phases,
    completedAt,
    runStartedAt,
    activePhaseKey,
    activePhaseStartedAt,
    runSync,
  } = merged;
  // Blocked-detox handles live on the underlying hook in both paths.
  const blockedDetox = (merged as any).blockedDetox ?? localSync.blockedDetox ?? null;
  const skipDetox = (merged as any).skipDetox ?? localSync.skipDetox;
  const dismissBlockedDetox = (merged as any).dismissBlockedDetox ?? localSync.dismissBlockedDetox;


  const handleRun = () => {
    setOpen(true);
    runSync();
  };

  // Keyboard shortcut: ⌘/Ctrl + S triggers Sync Now from anywhere in the project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!running) handleRun();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, projectId]);

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

  const buttonLabel = running
    ? "Syncing…"
    : firstRun
      ? "Run Pipeline"
      : dirty
        ? "Sync Now · Changes pending"
        : "Sync Now";

  const ButtonIcon = running ? Loader2 : firstRun ? Play : dirty ? AlertCircle : RefreshCw;

  return (
    <div className="flex flex-col items-end gap-2">
      <SkipDetoxDialog
        blocked={blockedDetox}
        onConfirm={() => skipDetox?.()}
        onCancel={() => dismissBlockedDetox?.()}
      />

      <Button
        variant={firstRun ? "default" : "outline"}
        size="sm"
        onClick={handleRun}
        disabled={running}
        className={cn(
          "gap-1.5 transition-colors",
          dirty && !running && !firstRun &&
            "bg-warning/15 border-warning/40 text-warning hover:bg-warning/25 hover:text-warning"
        )}
        title={
          firstRun
            ? "Run the full pipeline for this project (⌘/Ctrl + S)"
            : dirty
              ? "Upstream data has changed — sync to update all tabs (⌘/Ctrl + S)"
              : syncState?.last_synced_at
                ? `Last synced ${formatDistanceToNow(new Date(syncState.last_synced_at), { addSuffix: true })} (⌘/Ctrl + S)`
                : "Run a sync to refresh all tabs (⌘/Ctrl + S)"
        }
      >
        <ButtonIcon className={cn("h-3.5 w-3.5", running && "animate-spin")} />
        {buttonLabel}
      </Button>

      {open && (
        <Card className="w-[460px] p-3 shadow-lg border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">Smart sync</span>
              {running && runStartedAt && (
                <Badge variant="secondary" className="text-[10px] h-4">
                  {formatElapsed(Date.now() - runStartedAt)} elapsed
                </Badge>
              )}
              {completedAt && (
                <Badge variant="secondary" className="text-[10px] h-4">
                  Done {formatDistanceToNow(completedAt, { addSuffix: true })}
                </Badge>
              )}
            </div>
            {!running && (
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close sync panel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {running && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] text-foreground">
              <Coffee className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
              <div className="leading-snug">
                <span className="font-semibold">This can take 5–10 minutes on large projects.</span>{" "}
                SERP, Ahrefs and forecast calls run in the background — feel free to grab a brew and come back.
                You can safely leave this page; progress will resume on the next visit.
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground mb-3">
            Runs the full pipeline in dependency order. Phases auto-skip when their inputs are already fresh.
          </p>
          <ul className="space-y-2">
            {phases.map((phase) => {
              const isActive =
                phase.status === "running" &&
                phase.key === activePhaseKey &&
                activePhaseStartedAt != null;
              const phaseElapsed = isActive ? formatElapsed(Date.now() - (activePhaseStartedAt ?? 0)) : null;
              return (
                <li key={phase.key} className="flex items-start gap-2 text-xs">
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
                    <div className="text-muted-foreground text-[11px] truncate">
                      {phase.detail || phase.description}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
