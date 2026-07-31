import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NavigatorProjectSummary } from "@/hooks/useNavigatorProjects";
import { getProjectData } from "@/integrations/gcp/project-data";

export interface ProjectReadiness {
  hasKeywords: boolean;
  hasForecasts: boolean;
  status: string | null;
  loading: boolean;
}

interface ReadinessRow {
  hasKeywords: boolean;
  hasForecasts: boolean;
}

/**
 * Shared probe used by ClientProjectSwitcher to decide whether the active
 * sub-view (e.g. /forecast) can be preserved when the user switches projects.
 * Lightweight HEAD count queries — RLS scoped. Cached for 30s.
 *
 * Status is read opportunistically from any cached `navigator_projects`
 * summary so we never refetch the full row.
 */
export function projectReadinessQueryKey(projectId: string) {
  return ["project_readiness", projectId] as const;
}

async function fetchReadiness(projectId: string): Promise<ReadinessRow> {
  const project = await getProjectData(projectId);
  return {
    hasKeywords: project.keywordCount > 0,
    hasForecasts:
      project.calculationCounts.harForecasts > 0 ||
      project.calculationCounts.revenueForecasts > 0,
  };
}

function readCachedStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): string | null {
  const caches = queryClient.getQueriesData<NavigatorProjectSummary[]>({
    queryKey: ["navigator_projects"],
  });
  for (const [, data] of caches) {
    const match = data?.find((p) => p.id === projectId);
    if (match) return match.status ?? null;
  }
  return null;
}

export function useProjectReadiness(projectId?: string): ProjectReadiness {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: projectReadinessQueryKey(projectId ?? ""),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: () => fetchReadiness(projectId as string),
  });

  return {
    hasKeywords: query.data?.hasKeywords ?? false,
    hasForecasts: query.data?.hasForecasts ?? false,
    status: projectId ? readCachedStatus(queryClient, projectId) : null,
    loading: query.isLoading,
  };
}

/**
 * Imperative variant for event handlers (e.g. switcher onChange) — uses the
 * same cache as the hook so a subsequent component render is instant.
 */
export async function ensureProjectReadiness(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): Promise<ReadinessRow> {
  return queryClient.fetchQuery({
    queryKey: projectReadinessQueryKey(projectId),
    staleTime: 30_000,
    queryFn: () => fetchReadiness(projectId),
  });
}
