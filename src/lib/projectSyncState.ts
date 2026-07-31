import {
  markProjectDirty as markTargetProjectDirty,
  type DirtyDomain,
} from "@/integrations/gcp/tenancy";

/**
 * Domain of the change. The Sync orchestrator uses these to:
 *  1. Decide what to recompute
 *  2. Show targeted "stale" dots on the workflow stepper tabs
 */
export type { DirtyDomain };

/**
 * Marks a Navigator project as "dirty" (upstream data changed since last sync).
 * The Sync Now button turns amber until the user runs a sync.
 *
 * Pass one or more `domains` so we can show per-tab stale dots.
 * Always also bumps `last_dirty_at` so the global Sync button flips amber.
 */
export async function markProjectDirty(
  projectId: string | undefined | null,
  domains: DirtyDomain[] = []
) {
  if (!projectId) return;
  try {
    await markTargetProjectDirty(projectId, domains);
  } catch (err) {
    // Non-blocking — dirty flag is a UX hint, not a correctness requirement.
    console.warn("markProjectDirty failed", err);
  }
}
