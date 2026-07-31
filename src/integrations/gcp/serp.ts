import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface ProjectSerpResult {
  ahrefsRank: number | null;
  backlinks: number | null;
  domain: string;
  domainRating: number | null;
  fetchedAt: string;
  isClientDomain: boolean;
  keyword: string;
  keywordId: string;
  metricSource: string | null;
  metricsFetchedAt: string | null;
  rankAbsolute: number;
  referringDomains: number | null;
  url: string;
  urlRating: number | null;
}

export interface ProjectSerpResultPage {
  items: ProjectSerpResult[];
  limit: number;
  offset: number;
  projectId: string;
  total: number;
}

export type ProjectSerpImportKind = "backlinks" | "features" | "rankings";

export interface ProjectSerpImportResult {
  importKind: ProjectSerpImportKind;
  importedRowCount: number;
  projectId: string;
  sourceRowCount: number;
  unmatchedRowCount: number;
}

export interface ProjectSerpFeature {
  averageMonthlyVolume: number | null;
  baseRank: number | null;
  capturedAt: string;
  device: "desktop" | "mobile" | "tablet";
  featureRaw: string;
  featureUrl: string | null;
  id: string;
  keyword: string;
  keywordId: string;
  owned: boolean;
  resultType: string;
  searchIntent: string | null;
  source: string;
}

export interface ProjectSerpFeaturePage {
  items: ProjectSerpFeature[];
  limit: number;
  offset: number;
  projectId: string;
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

export function listProjectSerpResults(
  projectId: string,
  input: {
    keywordId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ProjectSerpResultPage> {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 200),
    offset: String(input.offset ?? 0),
  });
  if (input.keywordId) query.set("keywordId", input.keywordId);
  return request(
    `/v1/projects/${projectId}/serp-results?${query.toString()}`,
  );
}

export async function listAllProjectSerpResults(
  projectId: string,
  keywordId?: string,
): Promise<ProjectSerpResult[]> {
  const items: ProjectSerpResult[] = [];
  while (true) {
    const page = await listProjectSerpResults(projectId, {
      keywordId,
      limit: 1_000,
      offset: items.length,
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

export function importProjectSerpCsv(
  projectId: string,
  kind: ProjectSerpImportKind,
  csvText: string,
): Promise<ProjectSerpImportResult> {
  return mutation(`/v1/projects/${projectId}/serp-import`, {
    body: JSON.stringify({ csvText, kind }),
    method: "POST",
  });
}

export function listProjectSerpFeatures(
  projectId: string,
  input: { limit?: number; offset?: number } = {},
): Promise<ProjectSerpFeaturePage> {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 200),
    offset: String(input.offset ?? 0),
  });
  return request(
    `/v1/projects/${projectId}/serp-features?${query.toString()}`,
  );
}

export async function listAllProjectSerpFeatures(
  projectId: string,
): Promise<ProjectSerpFeature[]> {
  const items: ProjectSerpFeature[] = [];
  while (true) {
    const page = await listProjectSerpFeatures(projectId, {
      limit: 1_000,
      offset: items.length,
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}
