import type { PoolClient } from "pg";

import { PIPELINE_STAGES } from "../../../packages/pipeline/src/definition.js";
import { PIPELINE_AI_MODEL } from "../../../packages/pipeline/src/ai-model.js";
import { forecastScope } from "../../../packages/pipeline/src/forecast-scope.js";
import { FORECAST_ELIGIBILITY_POLICY } from "../../../packages/pipeline/src/forecast-eligibility.js";
import { HttpError } from "../../../packages/runtime/src/http.js";

export function checkpointMatches(source: { input: Record<string, unknown>; created_at: Date }, checkpoint: Record<string, unknown>): boolean {
  if (source.input.checkpoint) return JSON.stringify(source.input.checkpoint) === JSON.stringify(checkpoint);
  return [checkpoint.lastDirtyAt, checkpoint.latestUploadAt, checkpoint.clientChangedAt]
    .every(value => value === null || (typeof value === "string" && new Date(value).getTime() <= source.created_at.getTime()));
}

export async function projectCheckpoint(client: PoolClient, projectId: string): Promise<Record<string, unknown>> {
  const result = await client.query<{ checkpoint: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
       'lastDirtyAt', project.last_dirty_at,
       'latestUploadAt', (SELECT max(created_at) FROM gsc_uploads WHERE project_id = project.id),
       'clientChangedAt', client.updated_at,
       'context', jsonb_build_object('company', client.company_name, 'domain', client.domain,
         'industry', client.industry, 'brandTerms', client.brand_terms, 'country', project.country,
         'language', project.language, 'categoryFocus', project.category_focus,
         'promotionFloor', project.gsc_promotion_impressions_floor,
         'competitiveFloor', project.competitive_enrichment_volume_floor),
       'model', $2::text) AS checkpoint
     FROM navigator_projects AS project JOIN clients AS client ON client.id = project.client_id
     WHERE project.id = $1`, [projectId, PIPELINE_AI_MODEL]);
  if (!result.rows[0]) throw new HttpError(404, "project_not_found", "Project not found.");
  return result.rows[0].checkpoint;
}

export async function lockIdleRun(client: PoolClient, runId: string): Promise<boolean> {
  const result = await client.query<{ idle: boolean }>(
    `SELECT bool_and(pg_try_advisory_xact_lock(hashtextextended($1 || ':' || stage_id, 0))) AS idle
     FROM unnest($2::text[]) AS stage(stage_id)`, [runId, PIPELINE_STAGES.map(stage => stage.id)]);
  return result.rows[0]?.idle === true;
}

export async function recoverPipelineRun(client: PoolClient, projectId: string, checkpoint: Record<string, unknown>, sourceRunId?: string): Promise<Record<string, unknown>> {
  const sources = await client.query<{ id: string; input: Record<string, unknown>; created_at: Date; completed_count: number }>(
    `SELECT run.id, run.input, run.created_at,
       (SELECT count(*)::int FROM pipeline_stage_runs WHERE run_id = run.id AND state = 'succeeded') AS completed_count
     FROM pipeline_runs AS run WHERE input->>'projectId' = $1 AND status = 'failed'
       AND NOT EXISTS (SELECT 1 FROM pipeline_runs AS newer WHERE newer.input->>'projectId' = $1
         AND newer.status = 'succeeded' AND newer.completed_at > run.created_at)
       AND NOT EXISTS (SELECT 1 FROM pipeline_stage_runs AS replacement
         JOIN pipeline_runs AS other ON other.id = replacement.run_id
         JOIN pipeline_stage_runs AS original ON original.run_id = run.id AND original.stage_id = replacement.stage_id
         WHERE other.input->>'projectId' = $1 AND other.id <> run.id
           AND replacement.stage_id IN ('detox', 'categorisation') AND replacement.state = 'succeeded'
           AND replacement.completed_at > COALESCE(original.completed_at, run.created_at))
       AND ($2::text IS NULL OR run.id::text = $2) AND COALESCE(input->>'mode', 'full') <> 'recalculate'
     ORDER BY completed_count DESC, last_activity_at DESC, id DESC LIMIT 20`, [projectId, sourceRunId ?? null]);
  const compatible = sources.rows.filter(source => checkpointMatches(source, checkpoint));
  const source = compatible[0];
  if (!source) throw new HttpError(409, "pipeline_resume_unavailable", sources.rows.length
    ? "Project inputs changed since the saved run. Review the changes and start a full pipeline explicitly."
    : "No failed or stopped pipeline checkpoint is available. Start a full pipeline explicitly.");
  if (!await lockIdleRun(client, source.id)) throw new HttpError(409, "pipeline_still_stopping", "Provider requests are still finishing. Resume once the saved run has stopped.");
  forecastScope(source.input); // Preserve and validate any historical operator approval.
  const stages = await client.query<{ stage_id: string; state: string; output: unknown }>(
    `SELECT stage_id, state, output FROM pipeline_stage_runs WHERE run_id = $1`, [source.id]);
  const saved = new Map(stages.rows.map(stage => [stage.stage_id, stage]));
  if (saved.size !== PIPELINE_STAGES.length || PIPELINE_STAGES.some(stage => {
    const row = saved.get(stage.id);
    return !row || (row.state === 'succeeded' && (row.output == null || stage.dependencies.some(id => saved.get(id)?.state !== 'succeeded')));
  })) throw new HttpError(409, "pipeline_checkpoint_invalid", "Saved stage outputs or dependencies are incomplete. Contact support before resuming.");
  const generation = Number(source.input.generation ?? 0) + 1;
  const resumedAt = new Date().toISOString();
  const input: Record<string, unknown> = { ...source.input, forecastEligibilityPolicy: FORECAST_ELIGIBILITY_POLICY,
    generation, checkpoint, resumedAt, recoveredStageCount: source.completed_count };
  delete input.stopRequestedAt;
  await client.query(
    `UPDATE pipeline_stage_runs SET state = 'pending', completed_at = NULL,
       output = (COALESCE(output, '{}'::jsonb) - 'reason' - 'failedStage') ||
         jsonb_build_object('message', 'Resuming saved progress; completed provider work is reused.')
     WHERE run_id = $1 AND state <> 'succeeded'`, [source.id]);
  await client.query(
    `UPDATE provider_work_items SET state = CASE WHEN provider_task_id IS NOT NULL THEN 'submitted' ELSE 'pending' END,
       attempt_offset = attempt_count, last_error = NULL, updated_at = now()
     WHERE pipeline_run_id = $1 AND state <> 'succeeded'`, [source.id]);
  await client.query(
    `UPDATE pipeline_runs SET status = 'pending', completed_at = NULL, input = $2::jsonb, last_activity_at = now()
     WHERE id = $1 AND status = 'failed'`, [source.id, JSON.stringify(input)]);
  return { id: source.id, resumed: true, startExecution: true, generation, recoveredStageCount: source.completed_count, status: "pending", stageCount: PIPELINE_STAGES.length };
}
