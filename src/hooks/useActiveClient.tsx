import { useMatch } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  getClient,
  getProjectSummary,
} from "@/integrations/gcp/tenancy";
import { useCanArchive } from "./useCanArchive";

export type ActiveClient = {
  id: string;
  company_name: string;
  logo_url: string | null;
  archived_at: string | null;
  isArchived: boolean;
} | null;

/**
 * Derives the active client from current client/project and legacy routes.
 * The API remains the authoritative access boundary.
 */
export function useActiveClient(): { client: ActiveClient; isLoading: boolean } {
  const legacyProjectMatch = useMatch("/navigator/:id");
  const clientScopeMatch = useMatch("/clients/:clientId/*");
  const archiveScopeMatch = useMatch("/archive/clients/:clientId/*");
  const { canArchive } = useCanArchive();

  const projectId =
    legacyProjectMatch?.params.id && legacyProjectMatch.params.id !== "new"
      ? legacyProjectMatch.params.id
      : null;
  const directClientId =
    clientScopeMatch?.params.clientId ??
    archiveScopeMatch?.params.clientId ??
    null;

  const { data: projectClientId } = useQuery({
    queryKey: ["active-project-client", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => (await getProjectSummary(projectId as string)).client_id,
    staleTime: 5 * 60 * 1000,
  });

  const clientId = directClientId ?? projectClientId ?? null;

  const { data: client, isLoading } = useQuery({
    queryKey: ["active-client", clientId],
    enabled: Boolean(clientId),
    queryFn: () => getClient(clientId as string),
    staleTime: 5 * 60 * 1000,
  });

  if (!client) return { client: null, isLoading };
  const isArchived = !!client.archived_at;
  if (isArchived && !canArchive) {
    // Non-admins must never see an archived active client.
    return { client: null, isLoading };
  }
  return {
    client: {
      id: client.id,
      company_name: client.company_name,
      logo_url: client.logo_url,
      archived_at: client.archived_at ?? null,
      isArchived,
    },
    isLoading,
  };
}
