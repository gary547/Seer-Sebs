import { useQuery } from "@tanstack/react-query";
import { projectView } from "@/lib/routes";
import { useProjectSyncState, isProjectDirty } from "@/hooks/useProjectSyncState";
import { getProjectData } from "@/integrations/gcp/project-data";
import { getLatestProjectPipelineRun } from "@/integrations/gcp/pipeline";

export type ProjectNextActionState =
  | "needs-sync"
  | "blocked"
  | "needs-forecast"
  | "ready";

export interface ProjectNextAction {
  state: ProjectNextActionState;
  label: string;
  to: string;
  tone: "default" | "warn";
  reason: string;
  /** True when the primary action should call `sharedSync.runSync()` instead of navigating. */
  triggersSync: boolean;
}

/**
 * Single source of truth for "what's the next thing this project needs".
 * Used by both the workspace header CTA and the ProjectOverviewPage so the
 * label + target never drift.
 */
export function useProjectNextAction(
  clientId: string | undefined,
  projectId: string | undefined,
): ProjectNextAction | null {
  const { data: syncState } = useProjectSyncState(projectId);

  const { data: latestPipeline } = useQuery({
    queryKey: ["project_latest_pipeline", projectId],
    enabled: !!projectId,
    refetchInterval: 30000,
    queryFn: () => getLatestProjectPipelineRun(projectId!),
  });

  const { data: hasForecasts } = useQuery({
    queryKey: ["project_has_forecasts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const project = await getProjectData(projectId!);
      return (
        project.calculationCounts.harForecasts > 0 ||
        project.calculationCounts.revenueForecasts > 0
      );
    },
  });

  if (!clientId || !projectId) return null;

  if (latestPipeline?.run?.status === "failed") {
    return {
      state: "blocked",
      label: "Review failed sync",
      to: projectView(clientId, projectId, "setup"),
      tone: "warn",
      reason:
        "The latest pipeline ended in a terminal failure. Open Setup to review the failed stage and rerun it.",
      triggersSync: false,
    };
  }

  const needsSync = !syncState?.last_synced_at || isProjectDirty(syncState);
  if (needsSync) {
    return {
      state: "needs-sync",
      label: !syncState?.last_synced_at ? "Run first sync" : "Run sync now",
      to: projectView(clientId, projectId, "setup"),
      tone: "default",
      reason: !syncState?.last_synced_at
        ? "This project hasn't synced yet. Run sync to generate SERPs, intent, and forecasts."
        : "Inputs have changed since the last sync. Run sync to refresh forecasts.",
      triggersSync: true,
    };
  }

  if (hasForecasts === false) {
    return {
      state: "needs-forecast",
      label: "Open Forecast",
      to: projectView(clientId, projectId, "forecast"),
      tone: "warn",
      reason: "Forecast data is empty. Open Forecast to recompute TP Revenue.",
      triggersSync: false,
    };
  }

  return {
    state: "ready",
    label: "Open Roadmap to Success",
    to: projectView(clientId, projectId, "roadmap"),
    tone: "default",
    reason: "Forecasts look healthy. Turn opportunity into a prioritised action plan.",
    triggersSync: false,
  };
}
