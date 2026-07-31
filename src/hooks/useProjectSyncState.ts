import { useQuery } from "@tanstack/react-query";
import { getProjectSummary } from "@/integrations/gcp/tenancy";

export interface ProjectSyncState {
  last_synced_at: string | null;
  last_dirty_at: string | null;
  keywords_dirty: boolean;
  serp_dirty: boolean;
  inputs_dirty: boolean;
}

/**
 * Reads the sync-state columns on a project. Cached + auto-refetched so any
 * component (Sync button, stepper dots, dirty banners) stays in sync without
 * each one doing its own query.
 */
export function useProjectSyncState(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project_sync_state", projectId],
    queryFn: async (): Promise<ProjectSyncState> => {
      const project = await getProjectSummary(projectId as string);
      return {
        inputs_dirty: project.inputs_dirty,
        keywords_dirty: project.keywords_dirty,
        last_dirty_at: project.last_dirty_at,
        last_synced_at: project.last_synced_at,
        serp_dirty: project.serp_dirty,
      };
    },
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

/** True when *anything* has changed since the last successful sync. */
export function isProjectDirty(state: ProjectSyncState | undefined): boolean {
  if (!state) return false;
  if (state.keywords_dirty || state.serp_dirty || state.inputs_dirty) return true;
  if (!state.last_dirty_at) return false;
  if (!state.last_synced_at) return true;
  return new Date(state.last_dirty_at) > new Date(state.last_synced_at);
}
