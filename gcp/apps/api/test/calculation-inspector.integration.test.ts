import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const keywordId = "00000000-0000-4000-8000-000000000005";
const completedAt = new Date("2026-08-12T10:00:00.000Z");

function result(rows: unknown[]) {
  return { rowCount: rows.length, rows };
}

function database(): DatabasePool {
  return {
    query: vi.fn(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT client_id FROM navigator_projects")) {
        return result([{ client_id: clientId }]);
      }
      if (sql.includes("FROM user_roles AS user_role")) {
        return result([{ role: "admin" }]);
      }
      if (sql.includes("SELECT approval_status FROM profiles")) {
        return result([{ approval_status: "approved" }]);
      }
      if (sql.includes("FROM pipeline_runs") && sql.includes("status = 'succeeded'")) {
        return result([{ completed_at: completedAt, id: runId }]);
      }
      if (sql.includes("WITH keyword_page AS")) {
        return result([
          {
            average_order_value_override_id: null,
            base_rank: 18,
            content_fit_score: "0.72",
            conversion_rate_override_id: null,
            ctr_now: "0.01",
            ctr_target: "0.08",
            current_revenue_annual: "1200",
            device: "mobile",
            expected_incremental_annual: "4200",
            explanation_json: { inputs: { source: "gcp" } },
            har_confidence: "0.84",
            har_position: 5,
            keyword: "weight loss medication",
            keyword_id: keywordId,
            link_power_score: "61.5",
            rank_attainment_probability: "0.74",
            scenario: "realistic",
            target_absolute_revenue_annual: "6400",
            target_incremental_revenue_annual: "5200",
          },
        ]);
      }
      if (sql.includes("count(DISTINCT har.keyword_id)")) {
        return result([{ count: "1" }]);
      }
      if (sql.includes("percentile_cont(0.1)")) {
        return result([
          {
            average_score: "54.2",
            high_confidence_count: "3",
            keyword_count: "2",
            low_confidence_count: "1",
            medium_confidence_count: "2",
            p10_score: "20",
            p50_score: "55",
            p90_score: "88",
            scored_count: "6",
          },
        ]);
      }
      if (
        sql.includes("FROM link_power_scores AS score") &&
        sql.includes("keyword.id AS keyword_id")
      ) {
        return result([
          {
            backlinks: "950",
            confidence: "high",
            domain: "pilltime.co.uk",
            domain_rating: "68",
            is_client_domain: true,
            keyword: "weight loss medication",
            keyword_id: keywordId,
            rank_absolute: 7,
            referring_domains: "110",
            score: "72.4",
            url: "https://pilltime.co.uk/weight-loss",
            url_rating: "51",
          },
        ]);
      }
      if (sql.includes("GROUP BY result.domain, result.is_client_domain")) {
        return result([
          {
            appearance_count: "2",
            best_rank: 7,
            domain: "pilltime.co.uk",
            is_client_domain: true,
            mean_score: "70.1",
          },
        ]);
      }
      if (
        sql.includes("SELECT count(*)::text AS count") &&
        sql.includes("FROM link_power_scores AS score")
      ) {
        return result([{ count: "1" }]);
      }
      throw new Error(`Unexpected SQL in inspector integration test: ${sql}`);
    }),
  } as unknown as DatabasePool;
}

describe("calculation inspector API", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApiServer({
      authenticateRequest: vi.fn(async () => ({
        email: "admin@example.com",
        id: userId,
      })),
      objectStore: {
        assertReady: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        get: vi.fn(async () => Buffer.alloc(0)),
        put: vi.fn(async () => undefined),
      },
      pool: database(),
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns scenario data grouped by keyword", async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/${projectId}/calculation-inspector?search=weight&limit=50`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          baseRank: 18,
          keyword: "weight loss medication",
          scenarios: {
            realistic: {
              expectedIncrementalAnnual: 4200,
              harPosition: 5,
              linkPowerScore: 61.5,
            },
          },
        },
      ],
      runId,
      total: 1,
    });
  });

  it("returns Link Power distribution and source rows", async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/${projectId}/link-power-inspector?limit=50`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      domains: [
        {
          domain: "pilltime.co.uk",
          isClientDomain: true,
          meanScore: 70.1,
        },
      ],
      items: [
        {
          confidence: "high",
          domain: "pilltime.co.uk",
          score: 72.4,
        },
      ],
      summary: {
        averageScore: 54.2,
        confidence: { high: 3, low: 1, medium: 2 },
        scoredCount: 6,
      },
      total: 1,
    });
  });

  it("rejects unbounded inspector requests", async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/${projectId}/calculation-inspector?limit=1000`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
