import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  archiveClient,
  archiveProject,
  restoreClient,
  restoreProject,
} from "@/integrations/gcp/tenancy";
import { useCanArchive } from "./useCanArchive";
import { ArchiveAccessError } from "./useArchive";

interface ArchiveClientArgs {
  clientId: string;
  reason?: string | null;
  clientName?: string | null;
}

interface RestoreClientArgs {
  clientId: string;
  clientName?: string | null;
}

interface ArchiveProjectArgs {
  projectId: string;
  reason?: string | null;
  projectName?: string | null;
}

interface RestoreProjectArgs {
  projectId: string;
  projectName?: string | null;
}

function formatError(err: unknown, fallback: string): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "42501") return "You don't have permission to perform this action.";
  if (e?.code === "client_domain_conflict") {
    return "Cannot restore — this client's domain is already used by another live client. Archive or rename the other client first.";
  }
  return e?.message || `Archive action failed: ${fallback}`;
}

function useInvalidators() {
  const qc = useQueryClient();
  return (opts?: { clientId?: string; projectId?: string }) => {
    qc.invalidateQueries({ queryKey: ["clients"] });
    qc.invalidateQueries({ queryKey: ["navigator_projects"] });
    qc.invalidateQueries({ queryKey: ["archive", "clients"] });
    qc.invalidateQueries({ queryKey: ["archive", "projects"] });
    qc.invalidateQueries({ queryKey: ["dash-clients"] });
    qc.invalidateQueries({ queryKey: ["dash-projects"] });
    qc.invalidateQueries({ queryKey: ["dash-forecasts"] });
    qc.invalidateQueries({ queryKey: ["dash-roadmaps"] });
    qc.invalidateQueries({ queryKey: ["dash-capture-window"] });
    if (opts?.clientId) {
      qc.invalidateQueries({ queryKey: ["seer-route-client", opts.clientId] });
      qc.invalidateQueries({ queryKey: ["active-client", opts.clientId] });
    }
    if (opts?.projectId) {
      qc.invalidateQueries({ queryKey: ["seer-route-project", opts.projectId] });
      qc.invalidateQueries({ queryKey: ["project-readiness", opts.projectId] });
    }
  };
}

export function useArchiveClient() {
  const { canArchive } = useCanArchive();
  const invalidate = useInvalidators();
  return useMutation({
    mutationFn: async ({ clientId, reason }: ArchiveClientArgs) => {
      if (!canArchive) throw new ArchiveAccessError();
      await archiveClient(clientId, reason ?? null);
    },
    onSuccess: (_d, vars) => {
      toast.success(`Archived ${vars.clientName ?? "client"} — moved to /archive`);
      invalidate({ clientId: vars.clientId });
    },
    onError: (err) => toast.error(formatError(err, "could not archive client")),
  });
}

export function useRestoreClient() {
  const { canArchive } = useCanArchive();
  const invalidate = useInvalidators();
  return useMutation({
    mutationFn: async ({ clientId }: RestoreClientArgs) => {
      if (!canArchive) throw new ArchiveAccessError();
      await restoreClient(clientId);
    },
    onSuccess: (_d, vars) => {
      toast.success(`Restored ${vars.clientName ?? "client"} — now live again`);
      invalidate({ clientId: vars.clientId });
    },
    onError: (err) => toast.error(formatError(err, "could not restore client")),
  });
}

export function useArchiveProject() {
  const { canArchive } = useCanArchive();
  const invalidate = useInvalidators();
  return useMutation({
    mutationFn: async ({ projectId, reason }: ArchiveProjectArgs) => {
      if (!canArchive) throw new ArchiveAccessError();
      await archiveProject(projectId, reason ?? null);
    },
    onSuccess: (_d, vars) => {
      toast.success(`Archived ${vars.projectName ?? "project"} — moved to /archive`);
      invalidate({ projectId: vars.projectId });
    },
    onError: (err) => toast.error(formatError(err, "could not archive project")),
  });
}

export function useRestoreProject() {
  const { canArchive } = useCanArchive();
  const invalidate = useInvalidators();
  return useMutation({
    mutationFn: async ({ projectId }: RestoreProjectArgs) => {
      if (!canArchive) throw new ArchiveAccessError();
      await restoreProject(projectId);
    },
    onSuccess: (_d, vars) => {
      toast.success(`Restored ${vars.projectName ?? "project"} — now live again`);
      invalidate({ projectId: vars.projectId });
    },
    onError: (err) => toast.error(formatError(err, "could not restore project")),
  });
}
