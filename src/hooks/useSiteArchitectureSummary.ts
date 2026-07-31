import { useQuery } from "@tanstack/react-query";
import { listClients, listProjects } from "@/integrations/gcp/tenancy";
import { listAllProjectSiteArchitecture } from "@/integrations/gcp/calculations";

/**
 * Portfolio-wide Site Architecture action queue.
 *
 * Mirrors the same definitions used in `SiteArchitectureSection`:
 * - Content Gaps   = content_status = 'red'
 * - To Optimise    = tactical_rag_status = 'optimise_content'
 * - To Create      = tactical_rag_status IN ('create_content', 'new_content')
 * - Watch          = tactical_rag_status = 'watch'
 *
 * Counted only for kept keywords (`detox_status = 'keep'`). Chunked .in() to
 * avoid silent URL-length truncation, same pattern as the project page.
 */

export interface SiteArchClientRow {
  clientId: string;
  clientName: string;
  latestProjectId: string;
  total: number;
  sharePct: number; // 0..1 relative to top row
}

export interface SiteArchSummary {
  totals: {
    gaps: number;
    optimise: number;
    create: number;
    watch: number;
    openActions: number;
    clientCount: number;
  };
  topClients: SiteArchClientRow[]; // length ≤ 3
  lastSyncedAt: string | null;
}

export function useSiteArchitectureSummary() {
  return useQuery<SiteArchSummary>({
    queryKey: ["site-arch-summary"],
    queryFn: async () => {
      const [projects, clients] = await Promise.all([
        listProjects(),
        listClients(false),
      ]);
      const clientName = new Map(
        clients.map((client) => [client.id, client.company_name]),
      );

      // Latest project per client (by created_at desc).
      const latestProjectByClient = new Map<string, string>();
      const projectToClient = new Map<string, string>();
      const sortedProjects = [...projects].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      for (const p of sortedProjects) {
        projectToClient.set(p.id, p.client_id);
        if (!latestProjectByClient.has(p.client_id)) latestProjectByClient.set(p.client_id, p.id);
      }

      const architectureByProject = new Map<
        string,
        Awaited<ReturnType<typeof listAllProjectSiteArchitecture>>
      >();
      for (let index = 0; index < projects.length; index += 4) {
        const batch = projects.slice(index, index + 4);
        const results = await Promise.all(
          batch.map(async (project) => ({
            projectId: project.id,
            rows: await listAllProjectSiteArchitecture(project.id),
          })),
        );
        for (const result of results) {
          architectureByProject.set(result.projectId, result.rows);
        }
      }

      const totals = { gaps: 0, optimise: 0, create: 0, watch: 0 };
      const perClient = new Map<string, number>();

      for (const [projectId, rows] of architectureByProject) {
        const cid = projectToClient.get(projectId);
        for (const row of rows) {
          if (row.isUnscored) continue;

          let counted = false;
          if (row.contentStatus === "red") {
            totals.gaps += 1;
            counted = true;
          }
          if (row.tacticalStatus === "optimise_content") {
            totals.optimise += 1;
            counted = true;
          } else if (
            row.tacticalStatus === "create_content" ||
            row.tacticalStatus === "new_content"
          ) {
            totals.create += 1;
            counted = true;
          } else if (row.tacticalStatus === "watch") {
            totals.watch += 1;
            counted = true;
          }

          if (counted && cid) {
            perClient.set(cid, (perClient.get(cid) ?? 0) + 1);
          }
        }
      }

      const openActions = totals.gaps + totals.optimise + totals.create + totals.watch;

      const ranked = [...perClient.entries()]
        .map(([cid, total]) => ({ cid, total }))
        .sort((a, b) => b.total - a.total);
      const topRaw = ranked.slice(0, 3);
      const topMax = topRaw[0]?.total ?? 1;
      const topClients: SiteArchClientRow[] = topRaw
        .map((r) => {
          const lpid = latestProjectByClient.get(r.cid);
          if (!lpid) return null;
          return {
            clientId: r.cid,
            clientName: clientName.get(r.cid) ?? "Unknown client",
            latestProjectId: lpid,
            total: r.total,
            sharePct: r.total / topMax,
          } satisfies SiteArchClientRow;
        })
        .filter((x): x is SiteArchClientRow => x !== null);

      // Latest sync across portfolio drives confidence.
      let lastSyncedAt: string | null = null;
      for (const p of projects) {
        if (p.last_synced_at && (!lastSyncedAt || p.last_synced_at > lastSyncedAt)) {
          lastSyncedAt = p.last_synced_at;
        }
      }

      return {
        totals: { ...totals, openActions, clientCount: perClient.size },
        topClients,
        lastSyncedAt,
      };
    },
  });
}
