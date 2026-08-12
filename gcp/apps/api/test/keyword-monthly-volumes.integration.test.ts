import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { getProjectKeywords } from "../src/core-domain.js";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const clientId = "00000000-0000-4000-8000-000000000003";
const keywordId = "00000000-0000-4000-8000-000000000004";

function result(rows: unknown[]) {
  return { rowCount: rows.length, rows };
}

describe("project keyword monthly volumes", () => {
  it("uses one canonical migrated value for each keyword month", async () => {
    let monthlySql = "";
    const query = vi.fn(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT client_id FROM navigator_projects")) {
        return result([{ client_id: clientId }]);
      }
      if (sql.includes("FROM user_roles AS user_role")) {
        return result([{ role: "admin" }]);
      }
      if (sql.includes("FROM keywords") && sql.includes("LIMIT $6 OFFSET $7")) {
        return result([{
          avg_monthly_volume: 1200,
          base_rank: 3,
          categorisation_source: null,
          categorisation_status: "done",
          categorisation_tier: null,
          category: null,
          competition: null,
          detox_reason: null,
          detox_rule: null,
          detox_status: "keep",
          device: "mobile",
          human_reviewed: false,
          id: keywordId,
          intent_confidence: null,
          intent_source: null,
          keyword: "seo agency",
          keyword_difficulty: null,
          keyword_priority: null,
          ranking_url: null,
          search_intent: null,
          tags: [],
        }]);
      }
      if (sql.includes("count(*)::text AS total_count")) {
        return result([{
          categorised_count: "0",
          keep_count: "1",
          pending_count: "0",
          ranking_url_count: "0",
          remove_count: "0",
          review_count: "0",
          total_count: "1",
        }]);
      }
      if (sql.includes("WITH migrated AS")) {
        monthlySql = sql;
        return result([
          { keyword_id: keywordId, month: new Date("2026-05-01T00:00:00Z"), volume: 1200 },
          { keyword_id: keywordId, month: new Date("2026-06-01T00:00:00Z"), volume: 1400 },
        ]);
      }
      throw new Error(`Unexpected SQL in keyword monthly-volume test: ${sql}`);
    });
    const pool = { query } as unknown as DatabasePool;

    const response = await getProjectKeywords(
      pool,
      { email: "admin@example.com", id: userId },
      projectId,
      {},
    );

    expect(monthlySql).toContain("DISTINCT ON (keyword_id, month)");
    expect(monthlySql).toContain("fetched_at DESC");
    expect(response).toMatchObject({
      items: [{
        id: keywordId,
        monthlyVolumes: [
          { month: "2026-05-01", volume: 1200 },
          { month: "2026-06-01", volume: 1400 },
        ],
      }],
    });
  });
});
