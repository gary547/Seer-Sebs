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
            annual_volume: "14400",
            average_order_value_override_id: null,
            base_rank: 18,
            category: "Medication",
            content_fit_score: "0.72",
            conversion_rate_override_id: null,
            ctr_now: "0.01",
            ctr_target: "0.08",
            current_revenue_annual: "1200",
            device: "mobile",
            expected_incremental_annual: "4200",
            expected_incremental_high_annual: "4800",
            expected_incremental_low_annual: "3600",
            explanation_json: { inputs: { source: "gcp" } },
            factor_applied: "0.74",
            har_confidence: "0.84",
            har_model_version: "har-v2",
            har_position: 5,
            keyword: "weight loss medication",
            keyword_id: keywordId,
            legacy_current_revenue_annual: "1000",
            legacy_har: "8",
            legacy_har_is_manual: true,
            legacy_har_source: "manual",
            legacy_target_incremental_revenue_annual: "3900",
            link_power_score: "61.5",
            rank_attainment_probability: "0.74",
            revenue_model_version: "revenue-v2",
            scenario: "realistic",
            search_intent: "commercial",
            serp_visibility_multiplier: "0.81",
            target_absolute_revenue_annual: "6400",
            target_incremental_revenue_annual: "5200",
            volume_forward: "1200",
            warnings: ["confidence_interval_wide"],
          },
        ]);
      }
      if (
        sql.includes("SELECT count(*)::text AS count") &&
        sql.includes("FROM har_forecasts AS har") &&
        sql.includes("har.scenario = 'realistic'")
      ) {
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
            missing_backlinks_count: "1",
            missing_domain_rating_count: "2",
            missing_referring_domains_count: "3",
            missing_url_rating_count: "4",
          },
        ]);
      }
      if (sql.includes("WITH domain_benchmark AS MATERIALIZED")) {
        return result([{ appearance_count: "2", best_rank: 7, domain: "pilltime.co.uk", is_client_domain: true, mean_score: "70.1", total: "12" }]);
      }
      if (
        sql.includes("FROM link_power_scores AS score") &&
        sql.includes("keyword.id AS keyword_id")
      ) {
        return result([
          {
            backlinks: "950",
            metric_source: "dataforseo",
            authority_scope: "domain_fallback",
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
      if (sql.includes("FROM client_domain_metrics")) {
        return result([
          {
            ahrefs_rank: "125000",
            backlinks: "8200",
            domain: "pilltime.co.uk",
            domain_rating: "68",
            fetched_at: completedAt,
            metric_source: "ahrefs",
            referring_domains: "610",
            url_rating: "51",
          },
        ]);
      }
      throw new Error(`Unexpected SQL in inspector integration test: ${sql}`);
    }),
  } as unknown as DatabasePool;
}

describe("calculation inspector API", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;
  let pool: DatabasePool;

  beforeEach(async () => {
    pool = database();
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
      pool,
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
          category: "Medication",
          currentRevenueV1: 1000,
          harIsManualV1: true,
          harV1: 8,
          keyword: "weight loss medication",
          scenarios: {
            realistic: {
              expectedIncrementalHighAnnual: 4800,
              expectedIncrementalLowAnnual: 3600,
              expectedIncrementalAnnual: 4200,
              harPosition: 5,
              linkPowerScore: 61.5,
              warnings: ["confidence_interval_wide"],
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
      clientAuthority: {
        domain: "pilltime.co.uk",
        domainRating: 68,
      },
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
          metricSource: "dataforseo",
          authorityScope: "domain_fallback",
        },
      ],
      summary: {
        averageScore: 54.2,
        confidence: { high: 3, low: 1, medium: 2 },
        missingComponents: {
          backlinks: 1,
          domainRating: 2,
          referringDomains: 3,
          urlRating: 4,
        },
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

  it.each(["meanScore", "appearances"])("sorts the entire domain benchmark by %s before pagination", async (sort) => {
    for (const direction of ["asc", "desc"]) {
      const response = await fetch(`${baseUrl}/v1/projects/${projectId}/link-power-domains?sort=${sort}&direction=${direction}&limit=10&offset=10&runId=${runId}`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        domains: [{ appearances: 2, bestRank: 7, domain: "pilltime.co.uk", isClientDomain: true, meanScore: 70.1 }],
        total: 12, limit: 10, offset: 10, runId, sort, direction,
      });
      const calls = vi.mocked(pool.query).mock.calls;
      const domainQuery = [...calls].reverse().find(([sql]) => String(sql).includes("WITH domain_benchmark"));
      const column = sort === "meanScore" ? "mean_score" : "appearance_count";
      expect(String(domainQuery?.[0]).replace(/\s+/g, " ")).toContain(`ORDER BY ${column} ${direction.toUpperCase()}, domain ASC LIMIT $3 OFFSET $4`);
      expect(domainQuery?.[1]).toEqual([projectId, runId, 10, 10]);
      expect([...calls].reverse().find(([sql]) => String(sql).includes("FROM pipeline_runs"))?.[1]).toEqual([projectId, runId]);
    }
  });

  it.each(["limit=201", "offset=-1", "offset=Infinity", "sort=bestRank", "sort=constructor", "direction=desc;DELETE", "runId=invalid"])("rejects invalid domain benchmark parameters: %s", async (params) => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/link-power-domains?${params}`);
    expect(response.status).toBe(400);
    expect(vi.mocked(pool.query).mock.calls.some(([sql]) => String(sql).includes("FROM pipeline_runs"))).toBe(false);
  });

  it("requires an administrator for domain results and CSV pages", async () => {
    vi.mocked(pool.query).mockImplementation(async (sql) => result(String(sql).includes("FROM profiles") ? [{ approval_status: "approved" }] : [{ role: "user" }]) as never);
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/link-power-domains?limit=200`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "administrator_required" } });
    expect(vi.mocked(pool.query).mock.calls.some(([sql]) => String(sql).includes("WITH domain_benchmark"))).toBe(false);
  });

  it("rejects missing projects and runs outside the authorised project", async () => {
    const original = database();
    vi.mocked(pool.query).mockImplementation(async (sql, values) => {
      if (String(sql).includes("FROM pipeline_runs")) return result([]) as never;
      return original.query(sql, values) as never;
    });
    const missingRun = await fetch(`${baseUrl}/v1/projects/${projectId}/link-power-domains?runId=${runId}`);
    expect(missingRun.status).toBe(404);
    expect(vi.mocked(pool.query).mock.calls.some(([sql]) => String(sql).includes("WITH domain_benchmark"))).toBe(false);
    vi.mocked(pool.query).mockImplementation(async (sql) => result(String(sql).includes("FROM user_roles") ? [{ role: "admin" }] : String(sql).includes("FROM profiles") ? [{ approval_status: "approved" }] : []) as never);
    expect((await fetch(`${baseUrl}/v1/projects/${projectId}/link-power-domains`)).status).toBe(404);
  });

  it("accepts supported diagnostic filters and rejects unknown filters", async () => {
    const filtered = await fetch(
      `${baseUrl}/v1/projects/${projectId}/calculation-inspector?filters=delta,overrides`,
    );
    expect(filtered.status).toBe(200);

    const invalid = await fetch(
      `${baseUrl}/v1/projects/${projectId}/calculation-inspector?filters=unknown`,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
