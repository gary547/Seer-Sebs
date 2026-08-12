import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const clientId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const uploadId = "00000000-0000-4000-8000-000000000005";
let applicationRole = "admin";
let executedSql: string[] = [];

function result(rows: unknown[]) {
  return { rowCount: rows.length, rows };
}

function database(): DatabasePool {
  const query = vi.fn(async (sqlValue: string) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    executedSql.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
    if (sql.includes("SELECT approval_status FROM profiles")) return result([{ approval_status: "approved" }]);
    if (sql.includes("FROM user_roles AS user_role")) return result([{ role: applicationRole }]);
    if (sql.includes("SELECT project.id, project.archived_at, client.brand_terms")) {
      return result([{ archived_at: null, brand_terms: ["Seer"], id: projectId }]);
    }
    if (sql.includes("FROM pipeline_runs") && sql.includes("status = 'succeeded'")) {
      return result([{ completed_at: new Date("2026-08-12T10:00:00Z"), id: runId }]);
    }
    if (sql.includes("FROM gsc_uploads AS upload")) {
      return result([{ created_at: new Date("2026-08-11T10:00:00Z"), date_range_end: new Date("2026-06-30T00:00:00Z"), date_range_start: new Date("2026-04-01T00:00:00Z"), device: "mobile", id: uploadId, original_filename: "gsc.xlsx", page_count: "8", query_count: "240", row_count: 240, source_name: "gsc_workbook_v1" }]);
    }
    if (sql.includes("WITH base_sources AS")) {
      return result([{ base_rank_sources: { gsc: 9 }, branded_count: "2", kept_count: "10", missing_base_rank_count: "1", total_count: "12", unbranded_count: "9", unclassified_brand_count: "1", with_base_rank_count: "9" }]);
    }
    if (sql.includes("), history AS (")) {
      return result([{ earliest_month: new Date("2024-01-01T00:00:00Z"), history_row_count: "240", kept_keyword_count: "10", latest_month: new Date("2025-12-01T00:00:00Z"), maximum_months: "24", median_months: "24", minimum_months: "0", with_12_months_count: "9", with_24_months_count: "8", with_history_count: "9" }]);
    }
    if (sql.includes("count(volume.month)::text AS month_count")) {
      return result([{ keyword: "seo agency", keyword_id: "00000000-0000-4000-8000-000000000006", month_count: "24", months: [{ month: "2025-12-01", volume: 1200 }] }]);
    }
    if (sql.includes("WITH clusters AS")) {
      return result([{ canonical_bases: { volume: 3 }, cluster_count: "3", largest_cluster: "5", member_count: "10", multi_member_count: "2", top_clusters: [{ canonicalKeyword: "seo agency", clusterKey: "seo-agency", memberCount: 5 }] }]);
    }
    if (sql.includes("WITH signals AS")) {
      return result([{ average_coverage_months: "23.4", category_rows: [{ category: "SEO", keywordCount: 10, monthlyVolume: 12000, warningCount: 1 }], signal_count: "10", trend_directions: { growing: 8, stable: 2 }, warning_count: "1" }]);
    }
    if (sql.includes("WITH feature_types AS")) {
      return result([{ average_visibility_multiplier: "0.82", feature_count: "16", feature_types: [{ count: 10, ownedCount: 2, resultType: "organic" }], keyword_count: "10", owned_count: "2" }]);
    }
    if (sql.includes("WITH rows AS")) {
      return result([{ average_score: "72.5", matched_count: "9", missing_count: "1", scored_count: "9", total_count: "10", zero_count: "1", zero_rows: [{ keyword: "missing page", rankingUrl: null, tacticalStatus: "create_content" }] }]);
    }
    if (sql.includes("WITH comparison AS")) {
      return result([{ average_har_delta: "1.5", comparable_har_count: "8", comparable_revenue_count: "7", items: [{ currentRevenueV1: 100, currentRevenueV2: 120, harV1: 7, harV2: 5, keyword: "seo agency", keywordId: "00000000-0000-4000-8000-000000000006", targetIncrementalRevenueV1: 500, targetIncrementalRevenueV2: 650 }], keyword_count: "10" }]);
    }
    if (sql.includes("LEFT JOIN LATERAL")) {
      return result([{ completed_at: new Date("2026-08-12T10:00:00Z"), created_at: new Date("2026-08-12T09:55:00Z"), failure_stage: null, id: runId, started_at: new Date("2026-08-12T09:56:00Z"), status: "succeeded" }]);
    }
    if (sql.includes("DELETE FROM gsc_uploads")) return result([{ id: uploadId }]);
    if (sql.includes("UPDATE navigator_projects")) return result([]);
    throw new Error(`Unexpected SQL in calculation control test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return { connect: vi.fn(async () => client), query } as unknown as DatabasePool;
}

describe("calculation control API", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    applicationRole = "admin";
    executedSql = [];
    server = createApiServer({
      authenticateRequest: vi.fn(async () => ({ email: "admin@example.com", id: userId })),
      objectStore: {
        assertReady: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        get: vi.fn(async () => Buffer.alloc(0)),
        put: vi.fn(async () => undefined),
      },
      pool: database(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns every calculation-control section with bounded detail", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      baseRank: { missing: 1, total: 10, withRank: 9 },
      brandClassification: { branded: 2, unclassified: 1 },
      clustering: { clusterCount: 3, memberCount: 10 },
      comparisons: { comparableHarCount: 8, comparableRevenueCount: 7 },
      contentFit: { matched: 9, zero: 1 },
      demand: { signals: 10, warnings: 1 },
      gscReadiness: { uploads: [{ id: uploadId, queryRows: 240 }] },
      projectId,
      recentRuns: [{ id: runId, status: "succeeded" }],
      serpVisibility: { featureCount: 16, ownedCount: 2 },
      volumeHistory: { with24Months: 8, withHistory: 9 },
    });
    expect(
      executedSql.filter((sql) =>
        sql.includes("DISTINCT ON (volume.keyword_id, volume.month)"),
      ),
    ).toHaveLength(2);
  });

  it("deletes only a project-scoped GSC upload", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/gsc-uploads/${uploadId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true, projectId, uploadId });
  });

  it("rejects non-administrators", async () => {
    applicationRole = "view_only";
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "administrator_required" },
    });
  });
});
