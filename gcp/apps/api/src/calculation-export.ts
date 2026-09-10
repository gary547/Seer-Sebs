import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertProjectAccessByRole } from "./authorization.js";

const TEXT_FIELDS = [
  "keyword_id", "keyword", "scenario", "category", "search_intent", "categorisation_source", "intent_source",
  "cluster_key", "canonical_keyword", "is_branded", "brand_source", "device", "ranking_url",
  "detox_status", "detox_reason", "detox_rule", "authority_source", "content_fit_source", "content_fit_scope",
  "content_status", "tactical_status", "trend_direction", "trend_confidence", "demand_warning_reason",
  "har_model_version", "revenue_model_version", "har_outcome", "har_no_beat_reason", "warnings", "har_explanation",
] as const;
const NUMBER_FIELDS = [
  "avg_monthly_volume", "keyword_difficulty", "gsc_clicks", "gsc_impressions", "gsc_position",
  "domain_authority", "referring_domains", "backlinks", "coverage_months", "trend_pct", "trend_slope",
  "volatility_score", "seasonality_strength", "content_fit_percent", "base_rank", "har_position",
  "har_confidence", "rank_attainment_probability", "authority_score", "link_power_score", "link_gap_score",
  "content_fit_score", "serp_visibility_multiplier", "annual_volume", "volume_forward", "factor_applied",
  "ctr_now", "ctr_target", "current_revenue_annual", "target_absolute_revenue_annual",
  "target_incremental_revenue_annual", "expected_incremental_annual", "expected_incremental_low_annual", "expected_incremental_high_annual",
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCalculationExportPage(pool: DatabasePool, user: AuthenticatedUser, projectId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const limit = Number(params.get("limit") ?? "200");
  const after = params.get("after");
  const requestedRun = params.get("runId");
  const scenario = params.get("scenario");
  if (scenario !== null && !["conservative", "realistic", "stretch"].includes(scenario)) {
    throw new HttpError(400, "invalid_export_scenario", "Choose conservative, realistic or stretch.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (after && !uuid.test(after)) || (requestedRun && !uuid.test(requestedRun)) || (after && !requestedRun)) {
    throw new HttpError(400, "invalid_export_page", "Export pagination is invalid.");
  }
  const runs = await pool.query<{ id: string; completed_at: Date; currency: string | null; dirty: boolean; active: boolean }>(
    `SELECT run.id, run.completed_at, project.currency,
       (project.inputs_dirty OR project.keywords_dirty OR project.serp_dirty) AS dirty,
       EXISTS (SELECT 1 FROM pipeline_runs AS active WHERE active.input->>'projectId' = $1::text AND active.status IN ('pending', 'running')) AS active
     FROM pipeline_runs AS run JOIN navigator_projects AS project ON project.id = $1::uuid
     WHERE run.input->>'projectId' = $1::text AND run.status = 'succeeded'
     ORDER BY run.completed_at DESC, run.id DESC LIMIT 1`, [projectId]);
  const run = runs.rows[0];
  if (!run) throw new HttpError(409, "export_not_ready", "Complete the pipeline before downloading final results.");
  if (run.dirty || run.active || (requestedRun && run.id !== requestedRun)) throw new HttpError(409, "export_inputs_changed", "The project is changing or its inputs have changed. Complete the pipeline, then restart the export.");
  const page = await pool.query<Record<string, unknown>>(
    `WITH export_keywords AS (
       SELECT * FROM keywords WHERE project_id = $1 AND detox_status = 'keep'
         AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT $4
     )
     SELECT keyword.id AS keyword_id, keyword.keyword, scenario.value AS scenario,
       keyword.category, keyword.search_intent, keyword.categorisation_source, keyword.intent_source,
       keyword.is_branded, keyword.brand_source, keyword.device, keyword.ranking_url,
       keyword.detox_status, keyword.detox_reason, keyword.detox_rule,
       keyword.avg_monthly_volume, keyword.keyword_difficulty, keyword.gsc_clicks, keyword.gsc_impressions, keyword.gsc_position,
       cluster.cluster_key, canonical.keyword AS canonical_keyword,
       authority.metric_source AS authority_source, authority.domain_rating AS domain_authority,
       authority.referring_domains, authority.backlinks,
       architecture.metric_source AS content_fit_source, architecture.input_scope AS content_fit_scope,
       architecture.content_status, architecture.tactical_status, architecture.relevancy_score AS content_fit_percent,
       demand.coverage_months, demand.trend_direction, demand.trend_pct, demand.trend_slope,
       demand.trend_confidence, demand.volatility_score, demand.seasonality_strength, demand.demand_warning_reason,
       har.model_version AS har_model_version, har.base_rank, har.har_position, har.har_confidence,
       har.rank_attainment_probability, har.authority_score, har.link_power_score, har.link_gap_score,
       CASE WHEN har.har_position IS NOT NULL THEN 'attainable_target'
         WHEN har.explanation_json #>> '{no_beat_reason,reason}' = 'authority_below_threshold' THEN 'no_attainable_target'
         ELSE 'insufficient_inputs' END AS har_outcome,
       COALESCE(har.explanation_json #>> '{no_beat_reason,reason}', 'not_applicable') AS har_no_beat_reason,
       har.content_fit_score, har.serp_visibility_multiplier, har.explanation_json AS har_explanation,
       revenue.model_version AS revenue_model_version, revenue.annual_volume, revenue.volume_forward,
       revenue.factor_applied, revenue.ctr_now, revenue.ctr_target, revenue.current_revenue_annual,
       revenue.target_absolute_revenue_annual, revenue.target_incremental_revenue_annual,
       revenue.expected_incremental_annual, revenue.expected_incremental_low_annual, revenue.expected_incremental_high_annual,
       revenue.warnings
     FROM export_keywords AS keyword
     CROSS JOIN (VALUES ('conservative'), ('realistic'), ('stretch')) AS scenario(value)
     LEFT JOIN har_forecasts AS har ON har.keyword_id = keyword.id AND har.pipeline_run_id = $2 AND har.scenario = scenario.value
     LEFT JOIN revenue_forecasts AS revenue ON revenue.keyword_id = keyword.id AND revenue.pipeline_run_id = $2 AND revenue.scenario = scenario.value
     LEFT JOIN site_architecture AS architecture ON architecture.keyword_id = keyword.id AND architecture.pipeline_run_id = $2
     LEFT JOIN keyword_demand_signals AS demand ON demand.keyword_id = keyword.id AND demand.pipeline_run_id = $2
     LEFT JOIN client_domain_metrics AS authority ON authority.project_id = $1
     LEFT JOIN LATERAL (
       SELECT cluster.cluster_key, cluster.canonical_keyword_id
       FROM keyword_cluster_members AS member JOIN keyword_clusters AS cluster ON cluster.id = member.cluster_id
       WHERE member.keyword_id = keyword.id AND cluster.pipeline_run_id = $2 LIMIT 1
     ) AS cluster ON true
     LEFT JOIN keywords AS canonical ON canonical.id = cluster.canonical_keyword_id
     WHERE ($5::text IS NULL OR scenario.value = $5)
     ORDER BY keyword.id, scenario.value`, [projectId, run.id, after, limit, scenario]);
  const keys = new Set(page.rows.map((row) => String(row.keyword_id)));
  if (page.rows.some((row) => !row.har_model_version || !row.revenue_model_version || row.expected_incremental_annual == null)) {
    throw new HttpError(409, "export_incomplete", "The completed run does not contain forecasts for every eligible keyword. Re-run the pipeline before exporting final results.");
  }
  const columns = ["project_id", "run_id", "completed_at", "currency", ...TEXT_FIELDS, ...NUMBER_FIELDS];
  const rows = page.rows.map((row) => ({
    project_id: projectId, run_id: run.id, completed_at: run.completed_at.toISOString(), currency: run.currency?.trim() || "not_available",
    ...Object.fromEntries(TEXT_FIELDS.map((key) => [key, row[key] === null || row[key] === undefined || row[key] === "" ? "not_available" : typeof row[key] === "object" ? JSON.stringify(row[key]) : String(row[key])])),
    ...Object.fromEntries(NUMBER_FIELDS.map((key) => [key, row[key] === null || row[key] === undefined
      ? ((key === "har_position" || key === "rank_attainment_probability") && row.har_outcome === "no_attainable_target" ? "no_attainable_target" : "not_available")
      : Number(row[key])])),
  }));
  return { columns, rows, runId: run.id, keywordCount: keys.size, completedAt: run.completed_at.toISOString(),
    nextAfter: keys.size === limit ? [...keys].at(-1) : null,
    filename: `seer-results-${projectId}-${run.id}${scenario ? `-${scenario}` : ""}.csv`,
  };
}
