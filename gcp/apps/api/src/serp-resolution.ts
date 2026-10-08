import type { PoolClient } from "pg";

import { forecastScope, MAX_FORECAST_EXCLUSIONS, type ForecastScope } from "../../../packages/pipeline/src/forecast-scope.js";
import { withTransaction, type DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertAdministrator, assertProjectAccessByRole } from "./authorization.js";
import { checkpointMatches, lockIdleRun, projectCheckpoint } from "./pipeline-recovery.js";

type Database = DatabasePool | PoolClient;
interface ExcludedKeyword {
  id: string;
  text: string;
  normalisedText: string;
  sourceKeywordId: string;
  query: string;
}

async function loadResolution(database: Database, user: AuthenticatedUser, runId: string) {
  await assertAdministrator(database, user.id);
  const result = await database.query<{ input: Record<string, unknown>; status: string; created_at: Date; state: string; failed_stage: string }>(
    `SELECT run.input, run.status, run.created_at, stage.state, stage.output->>'failedStage' AS failed_stage
     FROM pipeline_runs AS run JOIN pipeline_stage_runs AS stage ON stage.run_id = run.id AND stage.stage_id = 'serp-collection'
     WHERE run.id = $1`, [runId]);
  const run = result.rows[0];
  if (!run || typeof run.input.projectId !== "string") throw new HttpError(404, "pipeline_run_not_found", "Pipeline run not found.");
  const projectId = run.input.projectId;
  await assertProjectAccessByRole(database, user.id, projectId, true);
  if (run.status !== "failed" || run.state !== "failed" || run.failed_stage !== "serp-collection") {
    throw new HttpError(409, "serp_resolution_unavailable", "Review exclusions only for a stopped run whose SERP collection failed.");
  }
  const keywords = await database.query<ExcludedKeyword>(
    `SELECT keyword.id, keyword.keyword AS text, keyword.normalised_keyword AS "normalisedText",
       canonical.id AS "sourceKeywordId", work.item_key AS query
     FROM provider_work_items AS work
     JOIN keywords AS canonical ON canonical.project_id = work.project_id AND canonical.normalised_keyword = work.item_key
     JOIN keyword_clusters AS cluster ON cluster.pipeline_run_id = work.pipeline_run_id
       AND cluster.project_id = work.project_id AND cluster.canonical_keyword_id = canonical.id
     JOIN keyword_cluster_members AS member ON member.cluster_id = cluster.id
     JOIN keywords AS keyword ON keyword.id = member.keyword_id AND keyword.project_id = work.project_id
     WHERE work.pipeline_run_id = $1 AND work.project_id = $2 AND work.stage_id = 'serp-collection'
       AND work.provider = 'dataforseo' AND work.state = 'succeeded' AND work.result->>'outcome' = 'no_results'
       AND keyword.detox_status = 'keep'
     ORDER BY work.item_key, keyword.id LIMIT $3`, [runId, projectId, MAX_FORECAST_EXCLUSIONS + 1]);
  const counts = await database.query<{ count: string; kept_count: string }>(
    `SELECT count(*)::text AS count,
       (SELECT count(*)::text FROM keywords WHERE project_id = $2 AND detox_status = 'keep') AS kept_count
     FROM provider_work_items
     WHERE pipeline_run_id = $1 AND project_id = $2 AND stage_id = 'serp-collection'
       AND provider = 'dataforseo' AND state = 'succeeded' AND result->>'outcome' = 'no_results'`, [runId, projectId]);
  const queries = [...new Set(keywords.rows.map(keyword => keyword.query))];
  if (!keywords.rows.length || queries.length !== Number(counts.rows[0]?.count ?? 0)
    || keywords.rows.length > MAX_FORECAST_EXCLUSIONS
    || new Set(keywords.rows.map(keyword => keyword.id)).size !== keywords.rows.length) {
    throw new HttpError(409, "serp_resolution_incomplete", "The affected keyword scope cannot be reviewed completely. Contact support before resuming.");
  }
  const remainingKeywordCount = Number(counts.rows[0]!.kept_count) - keywords.rows.length;
  if (!Number.isSafeInteger(remainingKeywordCount) || remainingKeywordCount < 1) {
    throw new HttpError(409, "forecast_scope_empty", "No forecastable keywords would remain. Resolve the missing search results before resuming.");
  }
  return { run, projectId, queries, keywords: keywords.rows, remainingKeywordCount };
}

export async function getSerpResolution(pool: DatabasePool, user: AuthenticatedUser, runId: string) {
  const resolution = await loadResolution(pool, user, runId);
  return { runId, projectId: resolution.projectId, queryCount: resolution.queries.length,
    keywordCount: resolution.keywords.length, queries: resolution.queries, keywords: resolution.keywords,
    remainingKeywordCount: resolution.remainingKeywordCount,
    approved: forecastScope(resolution.run.input) !== null };
}

export async function approveSerpExclusions(pool: DatabasePool, user: AuthenticatedUser, runId: string, body: unknown) {
  const ids = body && typeof body === "object" && !Array.isArray(body) && "keywordIds" in body ? body.keywordIds : null;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_FORECAST_EXCLUSIONS
    || ids.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, "invalid_serp_exclusions", "Confirm the exact keyword list shown in the exclusion review.");
  }
  return withTransaction(pool, async client => {
    const initial = await loadResolution(client, user, runId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [initial.projectId]);
    await client.query("SELECT id FROM pipeline_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (!await lockIdleRun(client, runId)) throw new HttpError(409, "pipeline_still_stopping", "Provider requests are still finishing. Review exclusions once the run has stopped.");
    const resolution = await loadResolution(client, user, runId);
    const active = await client.query(
      `SELECT 1 FROM pipeline_runs WHERE input->>'projectId' = $1 AND status IN ('pending', 'running') LIMIT 1`, [resolution.projectId]);
    if (active.rowCount) throw new HttpError(409, "pipeline_active", "Stop the active project pipeline before changing its forecast scope.");
    const checkpoint = await projectCheckpoint(client, resolution.projectId);
    if (!checkpointMatches(resolution.run, checkpoint)) throw new HttpError(409, "pipeline_resume_unavailable", "Project inputs changed since the saved run. Review them before changing its forecast scope.");
    const requested = new Set(ids);
    if (resolution.keywords.length !== requested.size || resolution.keywords.some(keyword => !requested.has(keyword.id))) {
      throw new HttpError(409, "serp_exclusion_scope_changed", "The affected keyword list changed. Reload the review and confirm the complete scope.");
    }
    const existing = forecastScope(resolution.run.input);
    if (existing) return { runId, keywordCount: existing.keywords.length, queryCount: existing.queries.length, approved: true, idempotent: true };
    const scope: ForecastScope = { reason: "dataforseo_no_results", approvedBy: user.id, approvedAt: new Date().toISOString(),
      queries: resolution.queries,
      keywords: resolution.keywords.map(({ id, normalisedText, sourceKeywordId }) => ({ id, normalisedText, sourceKeywordId })) };
    await client.query("UPDATE pipeline_runs SET input = input || jsonb_build_object('forecastScope', $2::jsonb) WHERE id = $1 AND status = 'failed'",
      [runId, JSON.stringify(scope)]);
    return { runId, keywordCount: scope.keywords.length, queryCount: scope.queries.length, approved: true };
  });
}
