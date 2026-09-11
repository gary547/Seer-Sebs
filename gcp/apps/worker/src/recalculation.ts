import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import { loadStageOutput } from "../../../packages/runtime/src/stage-output.js";
import type { DataDrivenStageData } from "../../../packages/pipeline/src/stage-handlers.js";

export async function restoreKeywordDecisions(pool: DatabasePool, projectId: string, data: DataDrivenStageData): Promise<DataDrivenStageData> {
  if (data.handlerVersion !== "detox-v1" && data.handlerVersion !== "categorisation-v1") return data;
  const stageId = data.handlerVersion === "detox-v1" ? "detox" : "categorisation";
  const result = await pool.query<{ run_id: string; output: DataDrivenStageData }>(
    `SELECT stage.run_id, stage.output FROM pipeline_stage_runs AS stage
     JOIN (SELECT id FROM pipeline_runs WHERE input->>'projectId' = $1 AND status = 'succeeded'
       ORDER BY completed_at DESC, id DESC LIMIT 1) AS baseline ON baseline.id = stage.run_id
     WHERE stage.stage_id = $2 AND stage.state = 'succeeded'`, [projectId, stageId]);
  const row = result.rows[0];
  const previous = row ? await loadStageOutput(pool, row.run_id, stageId, row.output) as DataDrivenStageData : undefined;
  if (!previous || previous.handlerVersion !== data.handlerVersion || !('keywords' in previous) || !Array.isArray(previous.keywords)) {
    throw new HttpError(422, "recalculation_baseline_missing", "No completed keyword qualification is available. Run the full pipeline before recalculating.");
  }
  const currentIds = new Set(data.keywords.map(keyword => keyword.id));
  if (previous.keywords.length !== currentIds.size || previous.keywords.some(keyword => !currentIds.has(keyword.id))) {
    throw new HttpError(422, "recalculation_keywords_changed", "The keyword set changed since the completed run. Run the full pipeline before recalculating.");
  }
  return previous;
}
