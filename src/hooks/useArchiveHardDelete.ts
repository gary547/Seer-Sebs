import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteClient,
  deleteProject,
  type HardDeleteSummary,
} from "@/integrations/gcp/tenancy";
import { useCanArchive } from "./useCanArchive";

class HardDeleteAccessError extends Error {
  constructor() {
    super("Permanent delete requires admin or super_admin");
    this.name = "HardDeleteAccessError";
  }
}

function formatError(err: unknown, fallback: string): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "42501") return "You don't have permission to perform this action.";
  return e?.message || fallback;
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function summaryToast(scope: "client" | "project", s: HardDeleteSummary, name?: string) {
  const rows = Object.values(s.counts).reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (rows) parts.push(`${rows.toLocaleString()} rows`);
  if (s.storage.objects_removed) {
    parts.push(`${s.storage.objects_removed} files (${formatBytes(s.storage.bytes_removed)})`);
  }
  const detail = parts.length ? ` · ${parts.join(" · ")} freed` : "";
  const target = name ?? s.entity_name ?? scope;
  toast.success(`Permanently deleted ${target}${detail}`);
  if (s.storage.errors.length) {
    toast.warning(`Storage cleanup had ${s.storage.errors.length} warning(s)`);
  }
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["clients"] });
    qc.invalidateQueries({ queryKey: ["navigator_projects"] });
    qc.invalidateQueries({ queryKey: ["archive", "clients"] });
    qc.invalidateQueries({ queryKey: ["archive", "projects"] });
    qc.invalidateQueries({ queryKey: ["dash-clients"] });
    qc.invalidateQueries({ queryKey: ["dash-projects"] });
  };
}

export function useHardDeleteClient() {
  const { canHardDelete } = useCanArchive();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ clientId }: { clientId: string; clientName?: string | null }) => {
      if (!canHardDelete) throw new HardDeleteAccessError();
      return deleteClient(clientId);
    },
    onSuccess: (summary, vars) => {
      summaryToast("client", summary, vars.clientName ?? undefined);
      invalidate();
    },
    onError: (err) => toast.error(formatError(err, "Failed to delete client")),
  });
}

export function useHardDeleteProject() {
  const { canHardDelete } = useCanArchive();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ projectId }: { projectId: string; projectName?: string | null }) => {
      if (!canHardDelete) throw new HardDeleteAccessError();
      return deleteProject(projectId);
    },
    onSuccess: (summary, vars) => {
      summaryToast("project", summary, vars.projectName ?? undefined);
      invalidate();
    },
    onError: (err) => toast.error(formatError(err, "Failed to delete project")),
  });
}
