import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface ContentPlanListItem {
  client_id: string;
  client_name: string;
  created_at: string;
  format_mix: Record<string, number>;
  id: string;
  item_count: number;
  name: string;
  next_deadline: string | null;
  project_id: string;
  project_name: string;
  status: string;
  total_revenue_gain: number | null;
}

export interface ContentPlan {
  client_id: string;
  clients: {
    company_name: string;
    id: string;
  };
  created_at: string;
  default_lead_weeks: number;
  hero_lead_weeks: number;
  id: string;
  mix: Record<string, number>;
  name: string;
  navigator_projects: {
    id: string;
    project_name: string;
  };
  project_id: string;
  status: string;
  total_revenue_gain: number | null;
}

export interface ContentPlanItem {
  audience: string | null;
  business_area: string | null;
  campaign_tie_in: string | null;
  cluster_score: number | null;
  content_action: string | null;
  content_format: string;
  first_draft_deadline: string | null;
  hero_promoted: boolean;
  id: string;
  internal_links: unknown[];
  journey_stage: string | null;
  meta_description: string | null;
  meta_title: string | null;
  notes: string | null;
  page_title_h1: string | null;
  plan_id: string;
  position: number;
  potential_revenue_gain: number | null;
  primary_keyword_id: string | null;
  primary_keyword_text: string | null;
  publish_month: string | null;
  recommended_url: string | null;
  responsibility: string | null;
  secondary_keyword_ids: string[];
  secondary_keyword_text: string[];
  serp_top3: Array<{
    domain?: string;
    rank?: number;
    title?: string;
    url?: string;
  }>;
  status: string;
  synopsis: string | null;
}

export interface GenerateContentPlanInput {
  clientId: string;
  defaultLeadWeeks: number;
  heroLeadWeeks: number;
  keywordIds: string[];
  mix: {
    blog: number;
    category: number;
    hero: number;
    page: number;
    product: number;
  };
  name: string;
  projectId: string;
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return seerApiRequest<T>(path, options, await getAccessToken());
}

export async function listContentPlans(
  projectId?: string,
): Promise<ContentPlanListItem[]> {
  const query = projectId
    ? `?projectId=${encodeURIComponent(projectId)}`
    : "";
  const result = await authenticatedRequest<{ plans: ContentPlanListItem[] }>(
    `/v1/content-plans${query}`,
  );
  return result.plans;
}

export async function getContentPlan(
  planId: string,
): Promise<{ items: ContentPlanItem[]; plan: ContentPlan }> {
  return authenticatedRequest(`/v1/content-plans/${planId}`);
}

export async function generateContentPlan(
  input: GenerateContentPlanInput,
): Promise<{ aiEnriched: boolean; items: number; planId: string }> {
  return authenticatedRequest("/v1/content-plans/generate", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export async function updateContentPlanItem(
  itemId: string,
  patch: Partial<ContentPlanItem>,
): Promise<ContentPlanItem> {
  return authenticatedRequest(`/v1/content-plan-items/${itemId}`, {
    body: JSON.stringify(patch),
    method: "PATCH",
  });
}

export async function promoteContentPlanItemToHero(
  itemId: string,
): Promise<{ id: string; swappedItemId: string | null }> {
  return authenticatedRequest(`/v1/content-plan-items/${itemId}/promote-hero`, {
    method: "POST",
  });
}
