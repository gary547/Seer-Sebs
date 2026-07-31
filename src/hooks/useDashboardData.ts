import { useQuery } from "@tanstack/react-query";
import { getPortfolioDashboard } from "@/integrations/gcp/portfolio";
import { listClients, listProjects } from "@/integrations/gcp/tenancy";
import { useMemo } from "react";

/**
 * Dashboard data — RLS-scoped portfolio aggregates.
 *
 * Strategy: pull the lean shape we need (no joins beyond what's required) and
 * reduce client-side. Keeps the network surface small and makes empty states
 * trivial to detect. If aggregate weight grows, we lift to an edge function.
 */

export interface ClientRevenue {
  clientId: string;
  clientName: string;
  domain: string | null;
  logoUrl: string | null;
  projectCount: number;
  /** TP Revenue Uplift — sum of `har_revenue_gain_annual`. Matches project's Performance Dashboard headline. */
  tpRevenueUplift: number;
  /** Revenue Uplift if every keyword reached rank 1 — sum of `yearly_revenue_gain_rank1`. */
  revenueUpliftRank1: number;
  /** @deprecated use `tpRevenueUplift`. Kept for back-compat with existing consumers. */
  forecastRevenue: number;
  forecastClicks: number;
  lastSyncedAt: string | null;
}

export interface RoadmapEntry {
  id: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  generatedAt: string;
  excerpt: string;
}

export interface LatestProject {
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
  /** TP Revenue Uplift — sum of `har_revenue_gain_annual`. */
  tpRevenueUplift: number;
  /** Sum of `yearly_revenue_gain_rank1`. */
  revenueUpliftRank1: number;
  /** @deprecated use `tpRevenueUplift`. */
  forecastRevenue: number;
  forecastClicks: number;
  keywordCount: number;
  /** 12-bucket monthly seasonality (Jan→Dec) summed from `keywords.peak_month` weighted by `avg_monthly_volume`. */
  seasonalityMonthly: number[];
}

export interface UrlMonitorStats {
  total: number;
  critical: number;
  warning: number;
  good: number;
}

export interface CaptureWindowKeyword {
  keywordId: string;
  keyword: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  monthsToPeak: number;
  weeksToPeak: number;
  peakMonth: string | null;
  revenueAtRank1: number;
  isInCaptureWindow: boolean;
}

export interface CaptureWindowSummary {
  totalKeywords: number;
  totalRevenue: number;
  projectIds: Set<string>;
  clientIds: Set<string>;
  topMovers: CaptureWindowKeyword[];
}

export interface DashboardSummary {
  clientCount: number;
  projectCount: number;
  activeProjectCount: number;
  totalForecastRevenue: number;
  totalForecastClicks: number;
  totalRoadmaps: number;
  lastSyncedAt: string | null;
  byClient: ClientRevenue[];
  recentRoadmaps: RoadmapEntry[];
  /** Distribution of project status — for the portfolio table & hero strip. */
  statusDistribution: Record<string, number>;
  latestProject: LatestProject | null;
  urlMonitor: UrlMonitorStats;
  captureWindow: CaptureWindowSummary;
  /** Roadmaps generated per week, last 12 weeks (oldest → newest). */
  roadmapCadenceWeekly: number[];
}

const ACTIVE_STATUSES = new Set(["active", "forecast", "review", "data collection", "complete"]);

function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function useDashboardData() {
  const clientsQ = useQuery({
    queryKey: ["dash-clients"],
    queryFn: () => listClients(false),
  });

  const projectsQ = useQuery({
    queryKey: ["dash-projects"],
    queryFn: () => listProjects(),
  });

  const portfolioQ = useQuery({
    queryKey: ["dash-portfolio"],
    queryFn: getPortfolioDashboard,
  });

  const summary: DashboardSummary | null = useMemo(() => {
    const clients = clientsQ.data;
    const projects = projectsQ.data;
    const portfolio = portfolioQ.data;

    if (!clients || !projects || !portfolio) return null;

    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const clientsById = new Map(clients.map((c) => [c.id, c]));

    const revByProject = new Map<string, { tp: number; rank1: number; clicks: number; kw: number }>();
    for (const forecast of portfolio.projectForecasts) {
      revByProject.set(forecast.projectId, {
        clicks: forecast.forecastClicks,
        kw: forecast.keywordCount,
        rank1: forecast.revenueUpliftRank1,
        tp: forecast.tpRevenueUplift,
      });
    }

    const byClientMap = new Map<string, ClientRevenue>();
    for (const c of clients) {
      byClientMap.set(c.id, {
        clientId: c.id,
        clientName: c.company_name,
        domain: c.domain ?? null,
        logoUrl: c.logo_url ?? null,
        projectCount: 0,
        tpRevenueUplift: 0,
        revenueUpliftRank1: 0,
        forecastRevenue: 0,
        forecastClicks: 0,
        lastSyncedAt: null,
      });
    }

    let totalTp = 0;
    let totalClk = 0;
    let activeCount = 0;
    let lastSyncOverall: string | null = null;
    const statusDistribution: Record<string, number> = {};

    for (const p of projects) {
      const bucket = byClientMap.get(p.client_id);
      if (!bucket) continue;
      bucket.projectCount += 1;
      const f = revByProject.get(p.id);
      if (f) {
        bucket.tpRevenueUplift += f.tp;
        bucket.revenueUpliftRank1 += f.rank1;
        bucket.forecastRevenue += f.tp; // back-compat alias = TP Revenue Uplift
        bucket.forecastClicks += f.clicks;
        totalTp += f.tp;
        totalClk += f.clicks;
      }
      if (p.last_synced_at) {
        if (!bucket.lastSyncedAt || p.last_synced_at > bucket.lastSyncedAt) bucket.lastSyncedAt = p.last_synced_at;
        if (!lastSyncOverall || p.last_synced_at > lastSyncOverall) lastSyncOverall = p.last_synced_at;
      }
      const status = (p.status ?? "draft").toLowerCase();
      statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
      if (ACTIVE_STATUSES.has(status)) activeCount += 1;
    }

    const byClient = [...byClientMap.values()]
      .filter((c) => c.projectCount > 0)
      .sort((a, b) => b.tpRevenueUplift - a.tpRevenueUplift);

    // Filter roadmaps to projects that are still visible (not archived / parent not archived).
    const visibleRoadmaps = portfolio.roadmaps.filter((roadmap) =>
      projectsById.has(roadmap.projectId),
    );

    const recentRoadmaps: RoadmapEntry[] = visibleRoadmaps.slice(0, 6).map((roadmap) => {
      const project = projectsById.get(roadmap.projectId);
      const client = project ? clientsById.get(project.client_id) : null;
      const text = plainText(roadmap.roadmapMarkdown);
      return {
        id: roadmap.id,
        projectId: roadmap.projectId,
        projectName: project?.project_name ?? "Untitled project",
        clientId: client?.id ?? null,
        clientName: client?.company_name ?? null,
        generatedAt: roadmap.generatedAt,
        excerpt: text.slice(0, 220),
      };
    });

    // Weekly roadmap cadence — last 12 weeks, oldest → newest. Real signal from project_roadmaps.generated_at.
    const cadenceWeekly: number[] = Array(12).fill(0);
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    for (const roadmap of visibleRoadmaps) {
      const ts = new Date(roadmap.generatedAt).getTime();
      const weeksAgo = Math.floor((now - ts) / WEEK_MS);
      if (weeksAgo >= 0 && weeksAgo < 12) {
        // index 0 = 11 weeks ago, index 11 = current week
        cadenceWeekly[11 - weeksAgo] += 1;
      }
    }

    // Latest project added to Seer
    const sortedProjects = [...projects].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    const newest = sortedProjects[0] ?? null;

    // Build 12-bucket monthly seasonality for the latest project (Jan..Dec).
    const seasonalityMonthly: number[] = Array(12).fill(0);
    for (const row of portfolio.seasonality) {
      if (row.projectId !== newest?.id || row.month < 1 || row.month > 12) continue;
      seasonalityMonthly[row.month - 1] += row.volume;
    }

    const latestProject: LatestProject | null = newest
      ? (() => {
          const f = revByProject.get(newest.id);
          const client = clientsById.get(newest.client_id);
          return {
            projectId: newest.id,
            projectName: newest.project_name,
            clientId: client?.id ?? null,
            clientName: client?.company_name ?? null,
            createdAt: newest.created_at,
            tpRevenueUplift: f?.tp ?? 0,
            revenueUpliftRank1: f?.rank1 ?? 0,
            forecastRevenue: f?.tp ?? 0, // back-compat alias = TP Revenue Uplift
            forecastClicks: f?.clicks ?? 0,
            keywordCount: f?.kw ?? 0,
            seasonalityMonthly,
          };
        })()
      : null;

    // URL Monitor stats
    const urlMonitor: UrlMonitorStats = portfolio.urlMonitor;

    const captureRows: CaptureWindowKeyword[] =
      portfolio.captureWindow.items.map((row) => ({
        clientId: row.clientId,
        clientName: row.clientName,
        isInCaptureWindow: row.isInCaptureWindow,
        keyword: row.keyword,
        keywordId: row.keywordId,
        monthsToPeak: row.monthsToPeak,
        peakMonth: row.peakMonth,
        projectId: row.projectId,
        projectName: row.projectName,
        revenueAtRank1: row.revenueAtRank1,
        weeksToPeak: row.weeksToPeak,
      }));
    const captureProjectIds = new Set<string>();
    const captureClientIds = new Set<string>();
    let captureRev = 0;
    for (const r of captureRows) {
      if (r.projectId) captureProjectIds.add(r.projectId);
      if (r.clientId) captureClientIds.add(r.clientId);
      captureRev += r.revenueAtRank1;
    }
    const captureWindow: CaptureWindowSummary = {
      totalKeywords: captureRows.length,
      totalRevenue: captureRev,
      projectIds: captureProjectIds,
      clientIds: captureClientIds,
      topMovers: captureRows.slice(0, 3),
    };

    return {
      clientCount: clients.length,
      projectCount: projects.length,
      activeProjectCount: activeCount,
      totalForecastRevenue: totalTp,
      totalForecastClicks: totalClk,
      totalRoadmaps: visibleRoadmaps.length,
      lastSyncedAt: lastSyncOverall,
      byClient,
      recentRoadmaps,
      statusDistribution,
      latestProject,
      urlMonitor,
      captureWindow,
      roadmapCadenceWeekly: cadenceWeekly,
    };
  }, [clientsQ.data, projectsQ.data, portfolioQ.data]);

  const isLoading =
    clientsQ.isLoading || projectsQ.isLoading || portfolioQ.isLoading;
  const error = clientsQ.error || projectsQ.error || portfolioQ.error;

  return { summary, isLoading, error };
}
