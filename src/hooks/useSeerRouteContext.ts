import { useMemo } from "react";
import { useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  getClient,
  getProjectSummary,
} from "@/integrations/gcp/tenancy";
import { SeerApiError } from "@/integrations/gcp/api";
import {
  archivePath,
  archiveClient as archiveClientPath,
  archiveClientProject as archiveClientProjectPath,
  dashboardPath,
  clientsPath,
  clientHome,
  clientEdit,
  clientProjects,
  projectHome,
  projectView,
  type ProjectViewKey,
} from "@/lib/routes";

// Lightweight shapes — full data still flows through the existing feature hooks.
export interface ActiveClient {
  id: string;
  company_name: string;
  domain: string | null;
  logo_url: string | null;
}

export interface ActiveProject {
  id: string;
  project_name: string;
  client_id: string;
  status: string;
  category_focus: string | null;
}

export interface SeerRouteUrls {
  dashboard: string;
  clients: string;
  clientHome?: string;
  clientEdit?: string;
  clientProjects?: string;
  projectHome?: string;
  projectView?: (view: ProjectViewKey) => string;
  archive: string;
  archiveClient?: string;
  archiveClientProject?: string;
}

export interface SeerRouteContext {
  clientId: string | null;
  projectId: string | null;
  activeClient: ActiveClient | null;
  activeProject: ActiveProject | null;
  isLoading: boolean;
  error: Error | null;
  accessDenied: boolean;
  notFound: boolean;
  /** True when the current pathname is under `/archive/...`. */
  isArchiveScope: boolean;
  urls: SeerRouteUrls;
}

/**
 * Resolves the active client/project from URL params and exposes route helpers.
 *
 * Client and project visibility is enforced by the authenticated API. The API
 * intentionally returns the same not-found response for inaccessible records.
 */
export function useSeerRouteContext(): SeerRouteContext {
  const params = useParams<{ clientId?: string; projectId?: string; id?: string }>();
  const clientId = params.clientId ?? null;
  // Support legacy `:id` param on project routes during the transition.
  const projectId = params.projectId ?? params.id ?? null;

  const location = useLocation();
  const isArchiveScope = location.pathname === "/archive" || location.pathname.startsWith("/archive/");

  const { isApproved, loading: authLoading } = useAuth();

  const clientQuery = useQuery({
    queryKey: ["seer-route-client", clientId],
    enabled: !!clientId && isApproved,
    queryFn: async (): Promise<ActiveClient> => {
      const client = await getClient(clientId as string);
      return {
        company_name: client.company_name,
        domain: client.domain,
        id: client.id,
        logo_url: client.logo_url,
      };
    },
  });

  const projectQuery = useQuery({
    queryKey: ["seer-route-project", projectId],
    enabled: !!projectId && isApproved,
    queryFn: async (): Promise<ActiveProject> => {
      const project = await getProjectSummary(projectId as string);
      return {
        category_focus: project.category_focus,
        client_id: project.client_id,
        id: project.id,
        project_name: project.project_name,
        status: project.status,
      };
    },
  });

  const isLoading =
    authLoading ||
    (!!clientId && clientQuery.isLoading) ||
    (!!projectId && projectQuery.isLoading);

  const error = (clientQuery.error ?? projectQuery.error) as Error | null;

  const activeClient = clientQuery.data ?? null;
  const activeProject = projectQuery.data ?? null;

  const clientNotFound =
    clientQuery.error instanceof SeerApiError &&
    clientQuery.error.status === 404;
  const projectNotFound =
    projectQuery.error instanceof SeerApiError &&
    projectQuery.error.status === 404;
  const notFound =
    !isLoading &&
    (
      (!!clientId && clientNotFound) ||
      (!!projectId && projectNotFound)
    );

  // accessDenied: a project was loaded but its client_id does not match the
  // URL's clientId. This is a hard mismatch that should never be reachable
  // through normal navigation. Admins still see the same denial — the URL
  // is malformed.
  const projectMismatch =
    !!clientId && !!activeProject && activeProject.client_id !== clientId;

  // Approved=false is gated upstream by ProtectedRoute; included defensively.
  const accessDenied = projectMismatch || (!authLoading && !isApproved);

  const urls = useMemo<SeerRouteUrls>(() => {
    const out: SeerRouteUrls = {
      dashboard: dashboardPath(),
      clients: clientsPath(),
      archive: archivePath(),
    };
    if (clientId) {
      out.clientHome = clientHome(clientId);
      out.clientEdit = clientEdit(clientId);
      out.clientProjects = clientProjects(clientId);
      out.archiveClient = archiveClientPath(clientId);
      if (projectId) {
        out.projectHome = projectHome(clientId, projectId);
        out.projectView = (view: ProjectViewKey) => projectView(clientId, projectId, view);
        out.archiveClientProject = archiveClientProjectPath(clientId, projectId);
      }
    }
    return out;
  }, [clientId, projectId]);

  return {
    clientId,
    projectId,
    activeClient,
    activeProject,
    isLoading,
    error,
    accessDenied,
    notFound,
    isArchiveScope,
    urls,
  };
}
