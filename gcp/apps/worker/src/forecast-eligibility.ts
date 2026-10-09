import type { PoolClient } from "pg";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { FORECAST_ELIGIBILITY_POLICY, type ForecastExclusion } from "../../../packages/pipeline/src/forecast-eligibility.js";

export async function loadForecastExclusions(pool: DatabasePool, runId: string): Promise<ForecastExclusion[]> {
  const result = await pool.query<ForecastExclusion>(
    `SELECT keyword_id AS id, normalised_text AS "normalisedText", source_keyword_id AS "sourceKeywordId", reason
     FROM pipeline_forecast_exclusions WHERE run_id = $1 ORDER BY keyword_id`, [runId]);
  return result.rows;
}

export async function persistForecastExclusions(client: PoolClient, runId: string, exclusions: ForecastExclusion[]): Promise<void> {
  for (let start = 0; start < exclusions.length; start += 1_000) {
    await client.query(
      `INSERT INTO pipeline_forecast_exclusions (run_id, keyword_id, normalised_text, source_keyword_id, reason, policy)
       SELECT $1, item.id::uuid, item."normalisedText", item."sourceKeywordId"::uuid, item.reason, $3
       FROM jsonb_to_recordset($2::jsonb) AS item(id text, "normalisedText" text, "sourceKeywordId" text, reason text)
       ON CONFLICT (run_id, keyword_id) DO NOTHING`, [runId, JSON.stringify(exclusions.slice(start, start + 1_000)), FORECAST_ELIGIBILITY_POLICY]);
  }
  const saved = await loadForecastExclusions(client as unknown as DatabasePool, runId);
  const canonical = (rows: ForecastExclusion[]) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  if (canonical(saved) !== canonical(exclusions)) throw new Error("Saved forecast eligibility differs from this run's observations.");
}
