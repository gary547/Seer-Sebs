import { AlertCircle } from "lucide-react";
import { useProjectSyncState, isProjectDirty } from "@/hooks/useProjectSyncState";

interface Props {
  projectId: string;
  /** Override the default copy — useful for output tabs that want a specific hint. */
  message?: string;
}

/**
 * Thin amber banner shown above read-only output views (Performance Output,
 * SERP Reports, Dashboard) whenever the project is in a dirty state. Reminds
 * the user that they're looking at last-sync data and should press Sync Now.
 *
 * Renders nothing when the project is clean — zero visual noise on happy path.
 */
export default function SyncStaleBanner({ projectId, message }: Props) {
  const { data: syncState } = useProjectSyncState(projectId);
  if (!isProjectDirty(syncState)) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
      <span>
        {message ??
          "Showing data from the last sync. Press Sync Now in the header to refresh with the latest inputs."}
      </span>
    </div>
  );
}
