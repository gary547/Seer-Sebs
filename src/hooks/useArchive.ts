import { useQuery } from "@tanstack/react-query";
import { listClients, listProjects } from "@/integrations/gcp/tenancy";
import { useCanArchive } from "./useCanArchive";

/**
 * Admin-only count of archived clients. Returns 0 for non-admins (no request).
 */
export function useArchivedClientsCount() {
  const { canArchive } = useCanArchive();
  const query = useQuery({
    queryKey: ["archive", "clients", "count"],
    enabled: canArchive,
    queryFn: async (): Promise<number> => {
      return (await listClients(true)).filter((client) => client.archived_at).length;
    },
  });
  return { count: query.data ?? 0, isLoading: query.isLoading };
}

export class ArchiveAccessError extends Error {
  constructor(message = "Archive access requires admin or super_admin") {
    super(message);
    this.name = "ArchiveAccessError";
  }
}

export interface ArchivedClientSummary {
  id: string;
  company_name: string;
  domain: string | null;
  industry: string | null;
  campaign_type: string | null;
  logo_url: string | null;
  created_at: string;
  archived_at: string;
  archived_by: string | null;
  archive_reason: string | null;
}

export interface ArchivedProjectSummary {
  id: string;
  project_name: string;
  category_focus: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  client_id: string;
  client_name: string | null;
  client_logo_url: string | null;
  client_archived_at: string | null;
  archived_at: string;
  archived_by: string | null;
  archive_reason: string | null;
}

export function useArchivedClients() {
  const { canArchive } = useCanArchive();

  const query = useQuery({
    queryKey: ["archive", "clients"],
    enabled: canArchive,
    queryFn: async (): Promise<ArchivedClientSummary[]> => {
      if (!canArchive) throw new ArchiveAccessError();
      return (await listClients(true))
        .filter((client) => client.archived_at)
        .map((client) => ({
          id: client.id,
          company_name: client.company_name,
          domain: client.domain,
          industry: client.industry,
          campaign_type: client.campaign_type,
          logo_url: client.logo_url,
          created_at: client.created_at,
          archived_at: client.archived_at as string,
          archived_by: client.archived_by,
          archive_reason: client.archive_reason,
        }))
        .sort((left, right) => right.archived_at.localeCompare(left.archived_at));
    },
  });

  return {
    clients: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

export function useArchivedProjects() {
  const { canArchive } = useCanArchive();

  const query = useQuery({
    queryKey: ["archive", "projects"],
    enabled: canArchive,
    queryFn: async (): Promise<ArchivedProjectSummary[]> => {
      if (!canArchive) throw new ArchiveAccessError();
      return (await listProjects(undefined, true))
        .filter((project) => project.archived_at)
        .map((project) => ({
          id: project.id,
          project_name: project.project_name,
          category_focus: project.category_focus,
          status: project.status,
          created_at: project.created_at,
          updated_at: project.updated_at,
          client_id: project.client_id,
          client_name: project.client_name,
          client_logo_url: project.client_logo_url,
          client_archived_at: project.client_archived_at,
          archived_at: project.archived_at as string,
          archived_by: project.archived_by,
          archive_reason: project.archive_reason,
        }))
        .sort((left, right) => right.archived_at.localeCompare(left.archived_at));
    },
  });

  return {
    projects: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
