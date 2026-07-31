import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface ClientSummary {
  analytics_connected: boolean;
  archive_reason: string | null;
  archived_at: string | null;
  archived_by: string | null;
  brand_terms: string[];
  brand_type: string | null;
  campaign_type: string | null;
  company_name: string;
  created_at: string;
  domain: string;
  domain_normalized: string | null;
  gsc_connected: boolean;
  id: string;
  industry: string | null;
  logo_url: string | null;
  team_members: unknown;
  updated_at: string;
}

export interface ClientCompetitor {
  competitor_domain: string;
  competitor_name: string;
  id: string;
  verified: boolean;
}

export interface ClientKeywordRule {
  id: string;
  keyword_categorisation: string;
  rule_type: string;
}

export interface ClientDetail extends ClientSummary {
  competitors: ClientCompetitor[];
  keyword_rules: ClientKeywordRule[];
}

export interface ProjectSummary {
  aov: number | null;
  archive_reason: string | null;
  archived_at: string | null;
  archived_by: string | null;
  calculations_v2_compute_enabled: boolean;
  calculations_v2_visible_enabled: boolean;
  category_focus: string | null;
  client_archived_at: string | null;
  client_domain: string;
  client_id: string;
  client_logo_url: string | null;
  client_name: string | null;
  conversion_rate: number | null;
  created_at: string;
  ctr: number | null;
  duplicated_from: string | null;
  har_status: string;
  id: string;
  inputs_dirty: boolean;
  keywords_dirty: boolean;
  last_dirty_at: string | null;
  last_synced_at: string | null;
  project_name: string;
  ranking_lookup_status: string;
  seasonality_end: string | null;
  seasonality_start: string | null;
  serp_dirty: boolean;
  status: string;
  updated_at: string;
}

export interface ClientInput {
  analyticsConnected: boolean;
  campaignType: string | null;
  companyName: string;
  competitors: Array<{
    competitorDomain: string;
    competitorName: string;
    verified: boolean;
  }>;
  domain: string;
  gscConnected: boolean;
  industry: string | null;
  keywordRules: Array<{
    keywordCategorisation: string;
    ruleType: string;
  }>;
  teamMembers: Array<{ email: string; name: string }> | null;
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export async function listClients(
  includeArchived = false,
): Promise<ClientSummary[]> {
  const query = includeArchived ? "?includeArchived=true" : "";
  const result = await authenticatedRequest<{ clients: ClientSummary[] }>(
    `/v1/clients${query}`,
  );
  return result.clients;
}

export async function getClient(clientId: string): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>(`/v1/clients/${clientId}`);
}

export async function createClient(input: ClientInput): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>("/v1/clients", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function updateClient(
  clientId: string,
  input: ClientInput,
): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>(`/v1/clients/${clientId}`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export async function updateClientBrandTerms(
  clientId: string,
  brandTerms: string[],
): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>(
    `/v1/clients/${clientId}/brand-terms`,
    {
      body: JSON.stringify({ brandTerms }),
      method: "PATCH",
    },
  );
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Logo read failed."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const encoded = value.split(",", 2)[1];
      if (!encoded) reject(new Error("Logo encoding failed."));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadClientLogo(
  clientId: string,
  file: File,
): Promise<string> {
  const result = await authenticatedRequest<{ path: string }>(
    `/v1/clients/${clientId}/logo`,
    {
      body: JSON.stringify({
        contentBase64: await fileBase64(file),
        contentType: file.type || "image/png",
      }),
      method: "PUT",
    },
  );
  return result.path;
}

export async function getClientLogoDataUrl(clientId: string): Promise<string> {
  const result = await authenticatedRequest<{
    contentBase64: string;
    contentType: string;
  }>(`/v1/clients/${clientId}/logo`);
  return `data:${result.contentType};base64,${result.contentBase64}`;
}

export async function listProjects(
  clientId?: string,
  includeArchived = false,
): Promise<ProjectSummary[]> {
  const parameters = new URLSearchParams();
  if (clientId) parameters.set("clientId", clientId);
  if (includeArchived) parameters.set("includeArchived", "true");
  const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
  const result = await authenticatedRequest<{ projects: ProjectSummary[] }>(
    `/v1/projects${query}`,
  );
  return result.projects;
}

export async function getProjectSummary(
  projectId: string,
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(
    `/v1/projects/${projectId}/summary`,
  );
}

export interface ArchivedProjectDetail {
  project: ProjectSummary;
  kpis: {
    contentPlans: number;
    keywords: number;
    roadmaps: number;
  };
}

export async function getArchivedProjectDetail(
  projectId: string,
): Promise<ArchivedProjectDetail> {
  return authenticatedRequest<ArchivedProjectDetail>(
    `/v1/projects/${projectId}/archive-detail`,
  );
}

export async function createProject(
  clientId: string,
  input: ProjectInput,
): Promise<{ client_id: string; id: string; project_name: string }> {
  return authenticatedRequest(`/v1/clients/${clientId}/projects`, {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export interface ProjectInput {
  aov: number | null;
  categoryFocus: string | null;
  conversionRate: number | null;
  projectName: string;
  seasonalityEnd: string | null;
  seasonalityStart: string | null;
}

export async function updateProject(
  projectId: string,
  input: ProjectInput,
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(`/v1/projects/${projectId}`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export async function duplicateProject(
  projectId: string,
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(
    `/v1/projects/${projectId}/duplicate`,
    { method: "POST" },
  );
}

export async function archiveClient(
  clientId: string,
  reason: string | null = null,
): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>(`/v1/clients/${clientId}/archive`, {
    body: JSON.stringify({ reason }),
    method: "POST",
  });
}

export async function restoreClient(clientId: string): Promise<ClientDetail> {
  return authenticatedRequest<ClientDetail>(`/v1/clients/${clientId}/restore`, {
    method: "POST",
  });
}

export async function archiveProject(
  projectId: string,
  reason: string | null = null,
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(
    `/v1/projects/${projectId}/archive`,
    {
      body: JSON.stringify({ reason }),
      method: "POST",
    },
  );
}

export async function restoreProject(
  projectId: string,
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(
    `/v1/projects/${projectId}/restore`,
    { method: "POST" },
  );
}

export interface HardDeleteSummary {
  ok: true;
  entity_type: "client" | "project";
  entity_id: string;
  entity_name?: string;
  storage: {
    bytes_removed: number;
    objects_removed: number;
    buckets: string[];
    errors: string[];
  };
  counts: Record<string, number>;
}

export async function deleteClient(
  clientId: string,
): Promise<HardDeleteSummary> {
  return authenticatedRequest<HardDeleteSummary>(`/v1/clients/${clientId}`, {
    method: "DELETE",
  });
}

export async function deleteProject(
  projectId: string,
): Promise<HardDeleteSummary> {
  return authenticatedRequest<HardDeleteSummary>(`/v1/projects/${projectId}`, {
    method: "DELETE",
  });
}

export type DirtyDomain = "inputs" | "keywords" | "serp";

export async function markProjectDirty(
  projectId: string,
  domains: DirtyDomain[],
): Promise<ProjectSummary> {
  return authenticatedRequest<ProjectSummary>(
    `/v1/projects/${projectId}/dirty`,
    {
      body: JSON.stringify({ domains }),
      method: "PATCH",
    },
  );
}

export interface ClientAccessUser {
  email: string | null;
  full_name: string | null;
  role: string | null;
  user_id: string;
}

export interface EligibleClientOwner {
  email: string | null;
  full_name: string | null;
  id: string;
}

export async function listEligibleClientOwners(
  clientId: string,
): Promise<EligibleClientOwner[]> {
  const result = await authenticatedRequest<{ users: EligibleClientOwner[] }>(
    `/v1/clients/${clientId}/eligible-owners`,
  );
  return result.users;
}

export async function listClientUsers(
  clientId: string,
): Promise<ClientAccessUser[]> {
  const result = await authenticatedRequest<{ users: ClientAccessUser[] }>(
    `/v1/clients/${clientId}/users`,
  );
  return result.users;
}

export async function grantClientUser(
  clientId: string,
  userId: string,
): Promise<void> {
  await authenticatedRequest(`/v1/clients/${clientId}/users`, {
    body: JSON.stringify({ userId }),
    method: "POST",
  });
}

export async function revokeClientUser(
  clientId: string,
  userId: string,
): Promise<void> {
  await authenticatedRequest(`/v1/clients/${clientId}/users/${userId}`, {
    method: "DELETE",
  });
}
