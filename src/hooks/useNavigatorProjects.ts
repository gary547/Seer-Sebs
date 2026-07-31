import { useQuery } from "@tanstack/react-query";
import {
  listProjects,
  type ProjectSummary,
} from "@/integrations/gcp/tenancy";

// Shared shape used by project pickers, switchers, and the command palette.
// RLS already scopes rows to projects the current user can access.
export type NavigatorProjectSummary = ProjectSummary;

interface UseNavigatorProjectsOptions {
  clientId?: string;
  enabled?: boolean;
}

export function useNavigatorProjects(options: UseNavigatorProjectsOptions = {}) {
  const { clientId, enabled = true } = options;

  const query = useQuery({
    queryKey: ["navigator_projects", { clientId: clientId ?? "all" }],
    enabled,
    queryFn: () => listProjects(clientId),
  });

  return {
    projects: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
