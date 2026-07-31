import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface ProjectKeywordInput {
  avgMonthlyVolume?: number | null;
  keywordDifficulty?: number | null;
  priority?: 1 | 2 | 3 | null;
  rankingUrl?: string | null;
  seedTags?: string[];
  text: string;
}

export interface ProjectKeywordImportResult {
  acceptedKeywordCount: number;
  insertedKeywordCount: number;
  projectId: string;
  skippedDuplicateCount: number;
}

export interface GscWorkbookImportInput {
  csvText?: string;
  dateRangeEnd?: string;
  dateRangeStart?: string;
  device?: string;
  fileBase64?: string;
  filename: string;
  format: "csv_text" | "xlsx_base64";
}

export interface GscWorkbookImportResult {
  date_range_end: string;
  date_range_start: string;
  pages_inserted: number;
  row_count: number;
  sheets_seen: string[];
  source: string;
  upload_device: string;
  upload_id: string;
  warnings: string[];
}

export interface ProjectDataKeyword {
  avgMonthlyVolume: number | null;
  categorisation: {
    category: string;
    intent: string | null;
    source: string | null;
    tags: string[];
    tier: string | null;
  } | null;
  detox: {
    reason: string | null;
    rule: string | null;
    status: "keep" | "pending" | "remove" | "review";
  };
  id: string;
  keywordDifficulty: number | null;
  rankingUrl: string | null;
  text: string;
}

export interface ProjectData {
  authorityMetrics: {
    ahrefsRank: number | null;
    backlinks: number | null;
    domain: string;
    domainRating: number | null;
    fetchedAt: string;
    referringDomains: number | null;
    source: string;
    urlRating: number | null;
  } | null;
  calculationCounts: {
    calibrationSnapshots: number;
    clusters: number;
    ctrCurves: number;
    demandSignals: number;
    harForecasts: number;
    linkPowerScores: number;
    revenueForecasts: number;
    siteArchitecture: number;
  };
  gscRowCount: number;
  id: string;
  keywordCount: number;
  keywordStatusCounts: {
    categorised: number;
    keep: number;
    pending: number;
    rankingUrls: number;
    remove: number;
    review: number;
  };
  keywords: ProjectDataKeyword[];
  rules: {
    blacklist: string[];
    competitorBrands: string[];
    ownBrands: string[];
    relevantTerms: string[];
    whitelist: string[];
  };
  serpResultCount: number;
}

export type ProjectKeywordDetoxStatus =
  | "keep"
  | "pending"
  | "remove"
  | "review";

export interface ManagedProjectKeyword {
  avgMonthlyVolume: number | null;
  baseRank: number | null;
  categorisationSource: string | null;
  categorisationStatus: "done" | "error" | "pending" | "processing" | "skipped";
  categorisationTier: string | null;
  category: string | null;
  competition: string | null;
  detoxReason: string | null;
  detoxRule: string | null;
  detoxStatus: ProjectKeywordDetoxStatus;
  device: "desktop" | "mobile" | "tablet";
  humanReviewed: boolean;
  id: string;
  intentConfidence: string | null;
  intentSource: string | null;
  keywordDifficulty: number | null;
  keywordPriority: 1 | 2 | 3 | null;
  monthlyVolumes: Array<{ month: string; volume: number }>;
  rankingUrl: string | null;
  searchIntent: string | null;
  tags: string[];
  text: string;
}

export interface ProjectKeywordListInput {
  categorisedOnly?: boolean;
  detoxStatus?: ProjectKeywordDetoxStatus | "all" | "removed";
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
  rankingUrlOnly?: boolean;
  search?: string;
  sort?: "baseRank" | "keyword" | "rankingUrl" | "volume";
}

export interface ProjectKeywordList {
  filterCounts: Record<string, number>;
  items: ManagedProjectKeyword[];
  limit: number;
  offset: number;
  projectId: string;
  summary: {
    categorised: number;
    rankingUrls: number;
  };
  total: number;
}

export interface ProjectKeywordMutationTarget {
  ids?: string[];
  predicate?: {
    detoxStatus?: ProjectKeywordDetoxStatus | "all" | "removed";
    search?: string;
  };
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export async function addProjectKeywords(
  projectId: string,
  keywords: ProjectKeywordInput[],
): Promise<ProjectKeywordImportResult> {
  return authenticatedRequest<ProjectKeywordImportResult>(
    `/v1/projects/${projectId}/keywords`,
    {
      body: JSON.stringify({ keywords }),
      method: "POST",
    },
  );
}

export async function getProjectData(projectId: string): Promise<ProjectData> {
  return authenticatedRequest<ProjectData>(`/v1/projects/${projectId}`);
}

export async function listProjectKeywords(
  projectId: string,
  input: ProjectKeywordListInput = {},
): Promise<ProjectKeywordList> {
  const query = new URLSearchParams();
  if (input.categorisedOnly) query.set("categorisedOnly", "true");
  if (input.detoxStatus) query.set("detoxStatus", input.detoxStatus);
  if (input.direction) query.set("direction", input.direction);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.offset !== undefined) query.set("offset", String(input.offset));
  if (input.rankingUrlOnly) query.set("rankingUrlOnly", "true");
  if (input.search) query.set("search", input.search);
  if (input.sort) query.set("sort", input.sort);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return authenticatedRequest<ProjectKeywordList>(
    `/v1/projects/${projectId}/keywords${suffix}`,
  );
}

export async function listAllProjectKeywords(
  projectId: string,
  input: Omit<ProjectKeywordListInput, "limit" | "offset"> = {},
): Promise<ManagedProjectKeyword[]> {
  const items: ManagedProjectKeyword[] = [];
  while (true) {
    const page = await listProjectKeywords(projectId, {
      ...input,
      limit: 1_000,
      offset: items.length,
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

export async function deleteProjectKeywords(
  projectId: string,
  target: ProjectKeywordMutationTarget,
): Promise<{ affectedKeywordCount: number }> {
  return authenticatedRequest(`/v1/projects/${projectId}/keywords`, {
    body: JSON.stringify({ action: "delete", ...target }),
    method: "PATCH",
  });
}

export async function updateProjectKeywordDetoxStatus(
  projectId: string,
  detoxStatus: ProjectKeywordDetoxStatus,
  target: ProjectKeywordMutationTarget,
): Promise<{ affectedKeywordCount: number }> {
  return authenticatedRequest(`/v1/projects/${projectId}/keywords`, {
    body: JSON.stringify({
      action: "updateDetox",
      detoxStatus,
      ...target,
    }),
    method: "PATCH",
  });
}

export async function updateProjectKeywordPriority(
  projectId: string,
  priority: 1 | 2 | 3 | null,
  keywordIds: string[],
): Promise<{ affectedKeywordCount: number }> {
  return authenticatedRequest(`/v1/projects/${projectId}/keywords`, {
    body: JSON.stringify({
      action: "updatePriority",
      ids: keywordIds,
      priority,
    }),
    method: "PATCH",
  });
}

export async function importGscWorkbook(
  projectId: string,
  input: GscWorkbookImportInput,
): Promise<GscWorkbookImportResult> {
  return authenticatedRequest<GscWorkbookImportResult>(
    `/v1/projects/${projectId}/gsc-workbook`,
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

export async function replaceProjectRules(
  projectId: string,
  rules: ProjectData["rules"],
): Promise<{ projectId: string; ruleCount: number }> {
  return authenticatedRequest(`/v1/projects/${projectId}/rules`, {
    body: JSON.stringify(rules),
    method: "PUT",
  });
}
