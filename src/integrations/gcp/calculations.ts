import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export type ForecastScenario = "conservative" | "realistic" | "stretch";

export interface ForecastRow {
  annualVolume: number | null;
  averageMonthlyVolume: number | null;
  baseRank: number | null;
  clientUrlRating: number | null;
  competitorUrl: string | null;
  competitorUrlRating: number | null;
  contentFitScore: number | null;
  contentStatus: string | null;
  ctrNow: number | null;
  ctrTarget: number | null;
  currentRevenueAnnual: number | null;
  device: string;
  expectedIncrementalAnnual: number | null;
  expectedIncrementalHighAnnual: number | null;
  expectedIncrementalLowAnnual: number | null;
  explanation: Record<string, unknown>;
  harConfidence: number;
  harPosition: number | null;
  keyword: string;
  keywordId: string;
  keywordPriority: number | null;
  linkPowerScore: number | null;
  monthlyRevenue: Record<string, unknown>;
  opportunity: string;
  rankAttainmentProbability: number | null;
  rankingUrl: string | null;
  relevancyScore: number | null;
  scenario: ForecastScenario;
  searchIntent: string | null;
  tacticalStatus: string | null;
  targetAbsoluteRevenueAnnual: number | null;
  targetIncrementalRevenueAnnual: number | null;
  trafficGainAnnual: number | null;
  volumeForward: number | null;
}

export interface ForecastPage {
  completedAt: string | null;
  items: ForecastRow[];
  limit: number;
  offset: number;
  projectId: string;
  runId: string | null;
  scenario: ForecastScenario;
  total: number;
}

export interface SiteArchitectureRow {
  averageMonthlyVolume: number | null;
  baseRank: number | null;
  category: string | null;
  contentStatus: string | null;
  isUnscored: boolean;
  keyword: string;
  keywordId: string;
  matchedUrl: string | null;
  providerStatus: string | null;
  rankingUrl: string | null;
  relevancyScore: number | null;
  searchIntent: string | null;
  tacticalStatus: string | null;
}

export interface SiteArchitecturePage {
  completedAt: string | null;
  items: SiteArchitectureRow[];
  limit: number;
  offset: number;
  projectId: string;
  runId: string | null;
  total: number;
}

export interface CtrCurve {
  device: string;
  isBranded: boolean;
  points: Array<{
    confidence: string;
    ctr: number;
    impressions: number;
    rank: number;
    source: string;
  }>;
  searchIntent: string;
}

export interface ProjectCtrCurves {
  completedAt: string | null;
  curves: CtrCurve[];
  projectId: string;
  runId: string | null;
}

export interface ProjectCalculationSummary {
  calibration: {
    matched: number;
    modelVersion: string;
    promotionEligible: boolean;
    status: string;
    [key: string]: unknown;
  } | null;
  completedAt: string | null;
  har: Array<{
    averageConfidence: number | null;
    averageHarPosition: number | null;
    forecastCount: number;
    modelVersion: string;
    scenario: ForecastScenario;
  }>;
  opportunities: Array<{
    baseRank: number | null;
    expectedIncremental: number | null;
    harPosition: number | null;
    keyword: string;
    keywordId: string;
    rankAttainmentProbability: number | null;
  }>;
  projectId: string;
  revenue: Array<{
    expectedIncremental: number | null;
    forecastCount: number;
    scenario: ForecastScenario;
    targetIncremental: number | null;
    [key: string]: unknown;
  }>;
  runId: string | null;
  siteActions: Array<{ count: number; tacticalStatus: string | null }>;
}

async function request<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, {}, token);
}

async function mutation<T>(
  path: string,
  options: RequestInit,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export function getProjectCalculationSummary(
  projectId: string,
): Promise<ProjectCalculationSummary> {
  return request(`/v1/projects/${projectId}/calculations`);
}

export function listProjectForecastRows(
  projectId: string,
  input: {
    limit?: number;
    offset?: number;
    scenario?: ForecastScenario;
  } = {},
): Promise<ForecastPage> {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 200),
    offset: String(input.offset ?? 0),
    scenario: input.scenario ?? "realistic",
  });
  return request(`/v1/projects/${projectId}/forecast-rows?${query.toString()}`);
}

export async function listAllProjectForecastRows(
  projectId: string,
  scenario: ForecastScenario = "realistic",
): Promise<ForecastRow[]> {
  const items: ForecastRow[] = [];
  while (true) {
    const page = await listProjectForecastRows(projectId, {
      limit: 1_000,
      offset: items.length,
      scenario,
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

export function listProjectSiteArchitecture(
  projectId: string,
  input: { limit?: number; offset?: number } = {},
): Promise<SiteArchitecturePage> {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 200),
    offset: String(input.offset ?? 0),
  });
  return request(
    `/v1/projects/${projectId}/site-architecture?${query.toString()}`,
  );
}

export async function listAllProjectSiteArchitecture(
  projectId: string,
): Promise<SiteArchitectureRow[]> {
  const items: SiteArchitectureRow[] = [];
  while (true) {
    const page = await listProjectSiteArchitecture(projectId, {
      limit: 1_000,
      offset: items.length,
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

export function getProjectCtrCurves(
  projectId: string,
): Promise<ProjectCtrCurves> {
  return request(`/v1/projects/${projectId}/ctr-curves`);
}

export interface ProjectRoadmap {
  generatedAt: string;
  generationSource: "anthropic" | "deterministic" | "vertex";
  id: string;
  modelVersion: string;
  pipelineRunId: string | null;
  roadmapMarkdown: string;
  syncedAt: string | null;
}

export async function listProjectRoadmaps(
  projectId: string,
): Promise<ProjectRoadmap[]> {
  const result = await request<{
    projectId: string;
    roadmaps: ProjectRoadmap[];
  }>(`/v1/projects/${projectId}/roadmaps`);
  return result.roadmaps;
}

export async function generateProjectRoadmap(
  projectId: string,
): Promise<ProjectRoadmap> {
  const result = await mutation<{
    projectId: string;
    roadmap: ProjectRoadmap;
  }>(`/v1/projects/${projectId}/roadmaps`, { method: "POST" });
  return result.roadmap;
}
