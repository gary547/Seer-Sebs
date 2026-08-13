import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const clientId = "00000000-0000-4000-8000-000000000003";
const successfulRunId = "00000000-0000-4000-8000-000000000004";

function result(rows: unknown[], rowCount = rows.length) {
  return { rowCount, rows };
}

function database(): DatabasePool {
  const query = vi.fn(async (sqlValue: string) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
    if (sql.includes("SELECT approval_status FROM profiles")) {
      return result([{ approval_status: "approved" }]);
    }
    if (sql.includes("SELECT client_id FROM navigator_projects")) {
      return result([{ client_id: clientId }]);
    }
    if (sql.includes("FROM user_roles AS user_role")) {
      return result([{ role: "super_admin" }]);
    }
    if (sql.includes("SELECT client.domain") && sql.includes("promotable_gsc_query_count")) {
      return result([{
        aov: "100",
        authority_backlinks: "1200",
        authority_domain_rating: "55",
        authority_referring_domains: 300,
        brand_terms: ["Seer"],
        competitor_count: "3",
        competitive_enrichment_volume_floor: 200,
        conversion_rate: "0.02",
        domain: "example.com",
        duplicate_gsc_query_count: "1400",
        gsc_promotion_impressions_floor: 10,
        inputs_dirty: false,
        kept_keyword_count: "1200",
        keywords_dirty: false,
        latest_gsc_query_count: "25000",
        manual_keyword_count: "1200",
        paid_eligible_keyword_count: "900",
        promotable_gsc_query_count: "8400",
        scoring_config_count: "1",
        serp_dirty: false,
      }]);
    }
    if (sql.includes("FROM pipeline_rollups AS rollup")) {
      expect(sql).toContain("rollup.project_id = $1::uuid");
      expect(sql).toContain("run.input->>'projectId' = $1::text");
      return result([{
        category_rollup: [{ category: "Medicine", expectedIncrementalAnnual: 40000, keywordCount: 50 }],
        cluster_deduped_expected_incremental_annual: "120000",
        cluster_rollup: [],
        double_count_annual: "30000",
        naive_expected_incremental_annual: "150000",
        quarter_rollup: [],
        scenario: "realistic",
        trend_rollup: [],
      }]);
    }
    if (sql.includes("stage.stage_id IN ('har-readiness', 'revenue-readiness')")) {
      return result([{
        output: {
          substitutions: [{ count: 12, input: "content_fit", substitute: "neutral_with_confidence_penalty" }],
        },
        stage_id: "har-readiness",
      }]);
    }
    if (sql.includes("FROM provider_work_items AS item")) {
      return result([{
        cache_entries_available: "48",
        failed: "0",
        max_attempts: 1,
        pending: "0",
        submitted: "0",
        succeeded: "240",
      }]);
    }
    if (sql.startsWith("UPDATE keywords AS keyword")) {
      return result([{ id: "00000000-0000-4000-8000-000000000005" }]);
    }
    if (sql.startsWith("UPDATE navigator_projects")) return result([], 1);
    if (sql.includes("SELECT pg_advisory_xact_lock")) return result([{}]);
    if (sql.includes("FROM pipeline_runs") && sql.includes("status IN ('pending', 'running')")) {
      return result([]);
    }
    if (sql.startsWith("INSERT INTO pipeline_runs")) return result([], 1);
    if (sql.startsWith("INSERT INTO pipeline_stage_runs")) return result([], 1);
    throw new Error(`Unexpected SQL in pipeline readiness test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return { connect: vi.fn(async () => client), query } as unknown as DatabasePool;
}

describe("autonomous pipeline readiness API", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;
  const orchestrator = { start: vi.fn(async () => ({ executionName: "executions/test" })) };

  beforeEach(async () => {
    orchestrator.start.mockClear();
    server = createApiServer({
      authenticateRequest: vi.fn(async () => ({ email: "admin@example.com", id: userId })),
      objectStore: {
        assertReady: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        get: vi.fn(async () => Buffer.alloc(0)),
        put: vi.fn(async () => undefined),
      },
      orchestrator,
      pool: database(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns gates, qualification preview, substitutions, and deduplicated rollups", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-readiness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preview: { latestGscQueryCount: 25000, promotableGscQueryCount: 8400 },
      ready: true,
      providerSummary: { cacheEntriesAvailable: 48, succeeded: 240 },
      rollups: [{ clusterDedupedExpectedIncrementalAnnual: 120000, doubleCountAnnual: 30000 }],
      substitutions: [{ count: 12, input: "content_fit", stageId: "har-readiness" }],
    });
  });

  it("marks an operator-confirmed manual set as pre-curated", async () => {
    const response = await fetch(
      `${baseUrl}/v1/projects/${projectId}/pipeline-precurated`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectId,
      stampedKeywordCount: 1,
    });
  });

  it("persists operator thresholds and starts a server-side run in the requested mode", async () => {
    const policy = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-readiness`, {
      body: JSON.stringify({ competitiveEnrichmentVolumeFloor: 500, gscPromotionImpressionsFloor: 25 }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(policy.status).toBe(200);

    const run = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      body: JSON.stringify({ mode: "resume" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(run.status).toBe(202);
    await expect(run.json()).resolves.toMatchObject({
      executionName: "executions/test",
      stageCount: 24,
      status: "pending",
    });
    expect(orchestrator.start).toHaveBeenCalledOnce();
    expect(orchestrator.start).not.toHaveBeenCalledWith(successfulRunId);
  });
});
