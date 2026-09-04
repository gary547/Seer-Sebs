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

export interface CalculationInspectorScenario {
  annualVolume: number | null;
  averageOrderValueOverrideId: string | null;
  contentFitScore: number | null;
  conversionRateOverrideId: string | null;
  ctrNow: number | null;
  ctrTarget: number | null;
  currentRevenueAnnual: number | null;
  expectedIncrementalAnnual: number | null;
  expectedIncrementalHighAnnual: number | null;
  expectedIncrementalLowAnnual: number | null;
  explanation: Record<string, unknown>;
  factorApplied: number | null;
  harConfidence: number;
  harPosition: number | null;
  linkPowerScore: number | null;
  harModelVersion: string;
  rankAttainmentProbability: number | null;
  revenueModelVersion: string | null;
  serpVisibilityMultiplier: number | null;
  targetAbsoluteRevenueAnnual: number | null;
  targetIncrementalRevenueAnnual: number | null;
  volumeForward: number | null;
  warnings: string[];
}

export interface CalculationInspectorRow {
  baseRank: number | null;
  category: string | null;
  device: string;
  currentRevenueV1: number | null;
  harIsManualV1: boolean;
  harSourceV1: string | null;
  harV1: number | null;
  keyword: string;
  keywordId: string;
  searchIntent: string | null;
  scenarios: Partial<
    Record<ForecastScenario, CalculationInspectorScenario>
  >;
  targetIncrementalRevenueV1: number | null;
}

export type CalculationInspectorFilter =
  | "clamped"
  | "delta"
  | "missing_lps"
  | "overrides"
  | "synthetic_lps";

export interface CalculationInspectorPage {
  completedAt: string | null;
  items: CalculationInspectorRow[];
  limit: number;
  offset: number;
  projectId: string;
  runId: string | null;
  search: string;
  total: number;
}

export interface LinkPowerInspectorPage {
  clientAuthority: {
    ahrefsRank: number | null;
    backlinks: number | null;
    domain: string;
    domainRating: number | null;
    fetchedAt: string;
    metricSource: string;
    referringDomains: number | null;
    urlRating: number | null;
  } | null;
  completedAt: string | null;
  domains: Array<{
    appearances: number;
    bestRank: number;
    domain: string;
    isClientDomain: boolean;
    meanScore: number;
  }>;
  items: Array<{
    backlinks: number | null;
    confidence: string;
    domain: string;
    domainRating: number | null;
    isClientDomain: boolean;
    keyword: string;
    keywordId: string;
    rank: number;
    referringDomains: number | null;
    score: number;
    url: string;
    urlRating: number | null;
  }>;
  limit: number;
  offset: number;
  projectId: string;
  runId: string | null;
  search: string;
  summary: {
    averageScore: number | null;
    confidence: { high: number; low: number; medium: number };
    keywordCount: number;
    missingComponents: {
      backlinks: number;
      domainRating: number;
      referringDomains: number;
      urlRating: number;
    };
    p10: number | null;
    p50: number | null;
    p90: number | null;
    scoredCount: number;
  } | null;
  total: number;
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

export function getProjectCalculationInspector(
  projectId: string,
  input: {
    filters?: CalculationInspectorFilter[];
    limit?: number;
    offset?: number;
    search?: string;
  } = {},
): Promise<CalculationInspectorPage> {
  const query = new URLSearchParams({
    filters: (input.filters ?? []).join(","),
    limit: String(input.limit ?? 50),
    offset: String(input.offset ?? 0),
    search: input.search ?? "",
  });
  return request(
    `/v1/projects/${projectId}/calculation-inspector?${query.toString()}`,
  );
}

export function getProjectLinkPowerInspector(
  projectId: string,
  input: { limit?: number; offset?: number; search?: string } = {},
): Promise<LinkPowerInspectorPage> {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 50),
    offset: String(input.offset ?? 0),
    search: input.search ?? "",
  });
  return request(
    `/v1/projects/${projectId}/link-power-inspector?${query.toString()}`,
  );
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
