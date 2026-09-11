import { withTransaction, type DatabasePool } from "../../../packages/runtime/src/database.js";
import { INTENT_CLASSIFICATION_VERSION, OPENROUTER_MODEL, type AiClassificationCache } from "./openrouter.js";

export function classificationCache(pool: DatabasePool, clientId: string): AiClassificationCache {
  return {
    get: async context => {
      const result = await pool.query<{ normalised_keyword: string; result: unknown }>(
        `SELECT normalised_keyword, result FROM keyword_intent_cache
         WHERE client_id = $1 AND context_hash = $2 AND model = $3 AND prompt_version = $4`,
        [clientId, context, OPENROUTER_MODEL, INTENT_CLASSIFICATION_VERSION]);
      return new Map(result.rows.map(row => [row.normalised_keyword, row.result]));
    },
    set: async (context, items) => withTransaction(pool, async client => {
      const rows = [...items].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([normalised_keyword, result]) => ({ normalised_keyword, result }));
      await client.query(
        `INSERT INTO keyword_intent_cache (client_id, context_hash, normalised_keyword, model, prompt_version, result)
         SELECT $1, $2, normalised_keyword, $3, $4, result
         FROM jsonb_to_recordset($5::jsonb) AS input(normalised_keyword text, result jsonb)
         ON CONFLICT (client_id, context_hash, normalised_keyword) DO NOTHING`,
        [clientId, context, OPENROUTER_MODEL, INTENT_CLASSIFICATION_VERSION, JSON.stringify(rows)]);
      const canonical = await client.query<{ normalised_keyword: string; result: unknown }>(
        `SELECT normalised_keyword, result FROM keyword_intent_cache
         WHERE client_id = $1 AND context_hash = $2 AND normalised_keyword = ANY($3::text[])
           AND model = $4 AND prompt_version = $5`,
        [clientId, context, rows.map(row => row.normalised_keyword), OPENROUTER_MODEL, INTENT_CLASSIFICATION_VERSION]);
      return new Map(canonical.rows.map(row => [row.normalised_keyword, row.result]));
    }),
  };
}
