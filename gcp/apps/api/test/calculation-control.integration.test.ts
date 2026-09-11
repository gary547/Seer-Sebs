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
let calendarDates: Array<string | null> = [];
let diagnosticDelay = 0;
let activeDiagnostics = 0;
let peakDiagnostics = 0;
let failSummaryOnce = false;

function result(rows: unknown[]) {
  return { rowCount: rows.length, rows };
}

function database(): DatabasePool {
  const execute = async (sqlValue: string, values: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    executedSql.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
    if (sql.includes("SELECT approval_status FROM profiles")) return result([{ approval_status: "approved" }]);
    if (sql.includes("FROM user_roles AS user_role")) return result([{ role: applicationRole }]);
    if (sql.includes("SELECT project.id, project.archived_at, client.brand_terms")) {
      return result([{ archived_at: null, brand_terms: ["Seer"], domain: "seer.example", id: values[0] ?? projectId }]);
    }
    if (sql.includes("FROM pipeline_runs") && sql.includes("status = 'succeeded'")) {
      return result([{ completed_at: new Date("2026-08-12T10:00:00Z"), id: runId }]);
    }
    if (sql.includes("FROM gsc_uploads AS upload")) {
      return result([{ created_at: new Date("2026-08-11T10:00:00Z"), date_range_end: calendarDates[1], date_range_start: calendarDates[0], device: "mobile", id: uploadId, original_filename: "gsc.xlsx", page_count: "8", query_count: "240", row_count: 240, source_name: "gsc_workbook_v1" }]);
    }
    if (sql.includes("WITH base_sources AS")) {
      return result([{ base_rank_sources: { gsc: 9 }, branded_count: "2", kept_count: "10", missing_base_rank_count: "1", total_count: "12", unbranded_count: "9", unclassified_brand_count: "1", with_base_rank_count: "9" }]);
    }
    if (sql.includes("AS history_row_count")) {
      if (failSummaryOnce) { failSummaryOnce = false; throw new Error("Injected diagnostic failure"); }
      return result([{ earliest_month: calendarDates[2], history_row_count: "240", kept_keyword_count: "10", latest_month: calendarDates[3], maximum_months: "24", median_months: "24", minimum_months: "0", with_12_months_count: "9", with_24_months_count: "8", with_history_count: "9" }]);
    }
    if (sql.includes("sample_keywords AS MATERIALIZED")) {
      return result([{ keyword: "seo agency", keyword_id: "00000000-0000-4000-8000-000000000006", month_count: "24", months: [{ month: "2025-12-01", volume: 1200 }] }]);
    }
    if (sql.includes("WITH clusters AS")) {
      return result([{ canonical_bases: { volume: 3 }, cluster_count: "3", largest_cluster: "5", member_count: "10", multi_member_count: "2", top_clusters: [{ canonicalKeyword: "seo agency", clusterKey: "seo-agency", memberCount: 5 }] }]);
    }
    if (sql.includes("WITH signals AS")) {
      return result([{ average_coverage_months: "23.4", category_rows: [{ category: "SEO", keywordCount: 10, monthlyVolume: 12000, warningCount: 1 }], confidence_distribution: { high: 8, medium: 2 }, signal_count: "10", trend_directions: { growing: 8, stable: 2 }, warning_count: "1", warning_reasons: { sparse_history: 1 } }]);
    }
    if (sql.includes("signal.coverage_months")) {
      return result([{ category: "SEO", coverage_months: 24, demand_warning: false, demand_warning_reason: null, keyword: "seo agency", keyword_id: "00000000-0000-4000-8000-000000000006", monthly_volume: 1200, peak_months: [1, 9], seasonality_strength: "0.35", trend_confidence: "high", trend_direction: "growing", trend_pct: "0.18", volatility_score: "0.21" }]);
    }
    if (sql.includes("WITH feature_types AS")) {
      return result([{ average_visibility_multiplier: "0.82", feature_count: "16", feature_types: [{ count: 10, ownedCount: 2, resultType: "organic" }], keyword_count: "10", owned_count: "2" }]);
    }
    if (sql.includes("WITH feature_summary AS")) {
      return result([{ feature_count: "3", keyword: "seo agency", keyword_id: "00000000-0000-4000-8000-000000000006", multiplier: "0.82", owned_count: "1", result_types: ["organic", "people_also_ask"], search_intent: "commercial" }]);
    }
    if (sql.includes("WITH rows AS")) {
      return result([{ average_score: "72.5", matched_count: "9", domain_fallback_count: "3", metric_sources: ["openrouter:z-ai/glm-5.3-flash"], missing_count: "1", scored_count: "9", total_count: "10", zero_count: "1", zero_rows: [{ keyword: "missing page", rankingUrl: null, tacticalStatus: "create_content" }] }]);
    }
    if (sql.includes("WITH aggregate AS")) {
      return result([{ average_har_delta: "1.5", comparable_har_count: "8", comparable_revenue_count: "7", items: [{ currentRevenueV1: 100, currentRevenueV2: 120, harV1: 7, harV2: 5, keyword: "seo agency", keywordId: "00000000-0000-4000-8000-000000000006", targetIncrementalRevenueV1: 500, targetIncrementalRevenueV2: 650 }], keyword_count: "10" }]);
    }
    if (sql.includes("LEFT JOIN LATERAL")) {
      return result([{ completed_at: new Date("2026-08-12T10:00:00Z"), created_at: new Date("2026-08-12T09:55:00Z"), failure_stage: null, id: runId, started_at: new Date("2026-08-12T09:56:00Z"), status: "succeeded" }]);
    }
    if (sql.includes("DELETE FROM gsc_uploads")) return result([{ id: uploadId }]);
    if (sql.includes("UPDATE navigator_projects")) return result([]);
    throw new Error(`Unexpected SQL in calculation control test: ${sql}`);
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const diagnostic = /FROM gsc_uploads AS upload|WITH base_sources AS|provider_history AS MATERIALIZED|WITH clusters AS|WITH signals AS|signal.coverage_months|WITH feature_types AS|WITH feature_summary AS|WITH rows AS|WITH aggregate AS|LEFT JOIN LATERAL/.test(sql);
    if (!diagnostic) return execute(sql, values);
    peakDiagnostics = Math.max(peakDiagnostics, ++activeDiagnostics);
    try {
      if (diagnosticDelay) await new Promise(resolve => setTimeout(resolve, diagnosticDelay));
      return await execute(sql, values);
    } finally { activeDiagnostics -= 1; }
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
    diagnosticDelay = 0;
    activeDiagnostics = 0;
    peakDiagnostics = 0;
    failSummaryOnce = false;
    calendarDates = ["2026-04-01", "2026-06-30", "2024-01-01", "2025-12-01"];
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

  it("shares overlapping authorized reads and caps diagnostics at two without caching settled responses", async () => {
    diagnosticDelay = 15;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(executedSql.filter(sql => sql.includes("AS history_row_count"))).toHaveLength(1);
    expect(peakDiagnostics).toBe(2);
    expect((await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`)).status).toBe(200);
    expect(executedSql.filter(sql => sql.includes("AS history_row_count"))).toHaveLength(2);
  });

  it("does not share project data and keeps one diagnostic limit across concurrent projects", async () => {
    diagnosticDelay = 15;
    const otherId = "00000000-0000-4000-8000-000000000099";
    const responses = await Promise.all([projectId, otherId].map(id => fetch(`${baseUrl}/v1/projects/${id}/calculation-control`)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies.map(body => (body as { projectId: string }).projectId)).toEqual([projectId, otherId]);
    expect(executedSql.filter(sql => sql.includes("AS history_row_count"))).toHaveLength(2);
    expect(peakDiagnostics).toBe(2);
  });

  it("checks authorization before joining pending project diagnostics", async () => {
    diagnosticDelay = 20;
    const pending = fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`);
    await vi.waitFor(() => expect(activeDiagnostics).toBeGreaterThan(0));
    applicationRole = "client";
    expect((await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`)).status).toBe(403);
    expect((await pending).status).toBe(200);
    expect(executedSql.filter(sql => sql.includes("AS history_row_count"))).toHaveLength(1);
  });

  it("releases failed in-flight reads so a later request can recover", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    failSummaryOnce = true;
    try {
      expect((await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`)).status).toBe(500);
      expect((await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`)).status).toBe(200);
      expect(executedSql.filter(sql => sql.includes("AS history_row_count"))).toHaveLength(2);
      expect(peakDiagnostics).toBeLessThanOrEqual(2);
    } finally { errorLog.mockRestore(); }
  });

  it("returns every calculation-control section with bounded detail", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      baseRank: { missing: 1, total: 10, withRank: 9 },
      brandClassification: { branded: 2, unclassified: 1 },
      clustering: { clusterCount: 3, memberCount: 10 },
      comparisons: { comparableHarCount: 8, comparableRevenueCount: 7 },
      contentFit: { matched: 9, zero: 1, domainFallback: 3, metricSources: ["openrouter:z-ai/glm-5.3-flash"] },
      demand: {
        confidenceDistribution: { high: 8, medium: 2 },
        samples: [{ keyword: "seo agency", trendDirection: "growing" }],
        signals: 10,
        warningReasons: { sparse_history: 1 },
        warnings: 1,
      },
      gscReadiness: { uploads: [{ id: uploadId, queryRows: 240 }] },
      projectId,
      recentRuns: [{ id: runId, status: "succeeded" }],
      serpVisibility: {
        featureCount: 16,
        ownedCount: 2,
        samples: [{ keyword: "seo agency", multiplier: 0.82 }],
      },
      volumeHistory: { with24Months: 8, withHistory: 9 },
    });
    expect(
      executedSql.filter((sql) =>
        sql.includes("provider_history AS MATERIALIZED"),
      ),
    ).toHaveLength(2);
    expect(executedSql.filter((sql) => sql.includes("provider.month = volume.month"))).toHaveLength(2);
    expect(executedSql.filter((sql) => sql.includes("sample_keywords AS MATERIALIZED"))).toHaveLength(1);
    expect(executedSql.some(sql => sql.includes("ORDER BY month, priority, fetched_at DESC, source DESC, id DESC"))).toBe(true);
    expect(executedSql.some((sql) => sql.includes("ORDER BY stage.attempts DESC"))).toBe(true);
  });

  it("deletes only a project-scoped GSC upload", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/gsc-uploads/${uploadId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true, projectId, uploadId });
  });

  it.each([
    ["2025-03-21", "2026-08-01", "2024-02-01", "2026-08-01"],
    ["2024-02-29", "2024-10-27", "2024-03-01", "2024-10-01"],
    [null, null, null, null],
  ])("preserves calendar dates without JavaScript timezone conversion: %s to %s", async (...dates) => {
    calendarDates = dates;
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/calculation-control`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      gscReadiness: { uploads: [{ dateRangeStart: dates[0], dateRangeEnd: dates[1], createdAt: "2026-08-11T10:00:00.000Z" }] },
      volumeHistory: { earliestMonth: dates[2], latestMonth: dates[3] },
    });
    const uploadsSql = executedSql.find((sql) => sql.includes("FROM gsc_uploads AS upload"));
    expect(uploadsSql).toContain("to_char(upload.date_range_start, 'YYYY-MM-DD') AS date_range_start");
    expect(uploadsSql).toContain("to_char(upload.date_range_end, 'YYYY-MM-DD') AS date_range_end");
    const volumeSql = executedSql.find((sql) => sql.includes("), history AS ("));
    expect(volumeSql).toContain("to_char(min(earliest_month), 'YYYY-MM-DD') AS earliest_month");
    expect(volumeSql).toContain("to_char(max(latest_month), 'YYYY-MM-DD') AS latest_month");
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
