import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface SerpFeatureReference {
  id: string;
  result_type: string;
  serp_feature_raw: string;
  serp_intent: string;
}

export interface HarScoringReference {
  id: string;
  notes: string | null;
  thresholds_json: Record<string, unknown>;
  updated_at: string;
  version: string;
  weights_json: Record<string, unknown>;
}

export interface ConversionOverrideRecord {
  average_order_value: number | null;
  confidence: string;
  conversion_rate: number | null;
  created_at: string;
  created_by: string | null;
  created_by_email?: string | null;
  id: string;
  note: string | null;
  project_id: string;
  scope_type: "category" | "intent" | "project" | "url";
  scope_value: string | null;
  source: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_email?: string | null;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export function getReferenceData(): Promise<{
  harScoringConfig: HarScoringReference | null;
  serpFeatures: SerpFeatureReference[];
}> {
  return request("/v1/reference-data");
}

export function createSerpFeatures(
  records: Array<{
    result_type: string;
    serp_feature_raw: string;
    serp_intent: string;
  }>,
): Promise<{ affected: number }> {
  return request("/v1/reference-data/serp-features", {
    body: JSON.stringify({ records }),
    method: "POST",
  });
}

export function updateSerpFeature(
  id: string,
  input: {
    result_type: string;
    serp_feature_raw: string;
    serp_intent: string;
  },
): Promise<SerpFeatureReference> {
  return request(`/v1/reference-data/serp-features/${id}`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export function listConversionOverrides(
  projectId: string,
): Promise<ConversionOverrideRecord[]> {
  return request<{ overrides: ConversionOverrideRecord[] }>(
    `/v1/projects/${projectId}/conversion-overrides`,
  ).then((result) => result.overrides);
}

export function upsertConversionOverride(input: {
  average_order_value: number | null;
  confidence: "high" | "low" | "medium";
  conversion_rate: number | null;
  id?: string;
  note: string | null;
  project_id: string;
  scope_type: "category" | "intent" | "project" | "url";
  scope_value: string | null;
}): Promise<ConversionOverrideRecord> {
  return request("/v1/conversion-overrides", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function deleteConversionOverride(id: string): Promise<void> {
  return request(`/v1/conversion-overrides/${id}`, { method: "DELETE" });
}

export interface CategoryConsolidationPreview {
  aiRenames: number;
  distinctTags: Array<{ count: number; tag: string }>;
  intentMerges: number;
  mapping: Record<string, string | null>;
  message?: string;
  normalizedRenames: number;
  nullCount: number;
  totalAffected: number;
}

export function getLastCategoryBatch(clientId: string): Promise<{
  batch: { batch_id: string; changed_at: string } | null;
}> {
  return request(
    `/v1/clients/${clientId}/category-consolidation/latest`,
  );
}

export function previewCategoryConsolidation(
  clientId: string,
): Promise<CategoryConsolidationPreview> {
  return request(`/v1/clients/${clientId}/category-consolidation`, {
    body: JSON.stringify({ mode: "preview" }),
    method: "POST",
  });
}

export function applyCategoryConsolidation(
  clientId: string,
  mapping: Record<string, string | null>,
): Promise<{ applied: number; batch_id: string }> {
  return request(`/v1/clients/${clientId}/category-consolidation`, {
    body: JSON.stringify({ mapping, mode: "apply" }),
    method: "POST",
  });
}

export function undoCategoryConsolidation(
  clientId: string,
): Promise<{ restored: number }> {
  return request(`/v1/clients/${clientId}/category-consolidation`, {
    body: JSON.stringify({ mode: "undo" }),
    method: "POST",
  });
}
