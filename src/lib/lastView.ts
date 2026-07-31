import { PROJECT_VIEW_KEYS, type ProjectViewKey } from "@/lib/routes";

const PREFIX = "seer-last-view:";

function key(projectId: string) {
  return `${PREFIX}${projectId}`;
}

export function rememberLastView(projectId: string, view: ProjectViewKey): void {
  if (!projectId || view === "overview") return;
  try {
    window.localStorage.setItem(key(projectId), view);
  } catch {
    // Storage unavailable (private mode / quota) — silently ignore.
  }
}

export function readLastView(projectId: string): ProjectViewKey | null {
  if (!projectId) return null;
  try {
    const raw = window.localStorage.getItem(key(projectId));
    if (!raw) return null;
    return (PROJECT_VIEW_KEYS as readonly string[]).includes(raw)
      ? (raw as ProjectViewKey)
      : null;
  } catch {
    return null;
  }
}

export function clearLastView(projectId: string): void {
  try {
    window.localStorage.removeItem(key(projectId));
  } catch {
    // ignore
  }
}
