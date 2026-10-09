import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { PIPELINE_STAGES } from "../../../packages/pipeline/src/definition.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const clientId = "00000000-0000-4000-8000-000000000003";
const successfulRunId = "00000000-0000-4000-8000-000000000004";
let readinessOverrides: Record<string, unknown> = {};
let completedQualification = true;
const failedRunId = "00000000-0000-4000-8000-000000000006";
let hasCheckpoint = false;
let changedInputs = false;
let idle = true;
let recoveryWrites: string[] = [];
let unresolvedSerps = false;
let previousScope: unknown;
let previousEligibility: unknown;
let createdInput: Record<string, unknown>;

function result(rows: unknown[], rowCount = rows.length) {
  return { rowCount, rows };
}

function database(): DatabasePool {
  const query = vi.fn(async (sqlValue: string, values: unknown[] = []) => {
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
        ...readinessOverrides,
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
    if (sql.startsWith("SELECT 1 FROM pipeline_stage_runs AS stage")) return result(completedQualification ? [{}] : []);
    if (sql.includes("SELECT pg_advisory_xact_lock")) return result([{}]);
    if (sql.includes("FROM pipeline_runs") && sql.includes("status IN ('pending', 'running')")) {
      return result([]);
    }
    if (sql.includes("AS checkpoint")) return result([{ checkpoint: { lastDirtyAt: changedInputs ? "2026-10-08T00:00:00Z" : null, latestUploadAt: null, clientChangedAt: null } }]);
    if (sql.includes("AS completed_count")) return result(hasCheckpoint ? [{ id: failedRunId, input: { mode: "full", projectId }, created_at: new Date("2026-10-07T00:00:00Z"), completed_count: 2 }] : []);
    if (sql.includes("AS idle")) return result([{ idle }]);
    if (sql.startsWith("SELECT 1 FROM provider_work_items")) return result(unresolvedSerps ? [{}] : []);
    if (sql.startsWith("SELECT id, input FROM pipeline_runs")) return result([{ id: failedRunId, input: {
      ...(previousScope ? { forecastScope: previousScope } : {}), ...(previousEligibility ? { forecastEligibility: previousEligibility } : {}) } }]);
    if (sql.includes("SELECT stage_id, state, output")) return result(PIPELINE_STAGES.map((stage, index) => ({ stage_id: stage.id, state: index < 2 ? "succeeded" : "failed", output: { preserved: stage.id } })));
    if (sql.startsWith("UPDATE pipeline") || sql.startsWith("UPDATE provider_work_items")) { recoveryWrites.push(sql); return result([], 1); }
    if (sql.startsWith("INSERT INTO pipeline_runs")) { createdInput = JSON.parse(String(values[2])); return result([], 1); }
    if (sql.startsWith("INSERT INTO pipeline_stage_runs")) return result([], 1);
    if (sql.startsWith("INSERT INTO pipeline_forecast_exclusions")) { recoveryWrites.push(sql); return result([], 1); }
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
    readinessOverrides = {};
    completedQualification = true;
    hasCheckpoint = false; changedInputs = false; idle = true; recoveryWrites = [];
    unresolvedSerps = false; previousScope = undefined; previousEligibility = undefined; createdInput = {};
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
  it("inherits approved forecast exclusions for recalculation and clears them for a new full run", async () => {
    previousScope = { reason: "dataforseo_no_results", approvedBy: userId, approvedAt: "2026-10-08T12:00:00Z",
      queries: ["empty query"], keywords: [{ id: failedRunId, normalisedText: "empty query", sourceKeywordId: failedRunId }] };
    const route = `${baseUrl}/v1/projects/${projectId}/pipeline-runs`;
    const post = (mode: string) => fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    expect((await post("recalculate")).status).toBe(202);
    expect(createdInput.forecastScope).toEqual(previousScope);
    expect((await post("full")).status).toBe(202);
    expect(createdInput.forecastScope).toBeUndefined();
  });
  it("inherits automatic eligibility for a provider-free recalculation and reassesses it on a full run", async () => {
    previousEligibility = { policy: "automatic-v1", excludedKeywordCount: 2, calculatedKeywordCount: 10 };
    const route = `${baseUrl}/v1/projects/${projectId}/pipeline-runs`;
    const post = (mode: string) => fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    expect((await post("recalculate")).status).toBe(202);
    expect(createdInput.forecastEligibility).toEqual(previousEligibility);
    expect(recoveryWrites.some(sql => sql.includes("FROM pipeline_forecast_exclusions WHERE run_id = $2"))).toBe(true);
    expect((await post("full")).status).toBe(202);
    expect(createdInput.forecastEligibility).toBeUndefined();
    expect(createdInput.forecastEligibilityPolicy).toBe("automatic-v1");
    previousEligibility = undefined;
  });

  it("resumes saved terminal searches with automatic eligibility and without requiring manual exclusions", async () => {
    hasCheckpoint = true; unresolvedSerps = true;
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "resume" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: failedRunId, recoveredStageCount: 2, generation: 1 });
    expect(orchestrator.start).toHaveBeenCalled();
    expect(recoveryWrites.length).toBeGreaterThan(0);
  });

  it("uses a safe domain fallback and resolves missing authority at run start", async () => {
    readinessOverrides = {
      authority_backlinks: "0",
      authority_domain_rating: "0",
      authority_referring_domains: 0,
      brand_terms: [],
      domain: "pilltime.co.uk",
    };
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-readiness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configuration: {
        brandTerms: ["pilltime"],
        brandTermsSource: "domain_fallback",
        explicitBrandTerms: [],
      },
      missing: [],
      ready: true,
    });
  });

  it("blocks an unqualified manual set before it can fail preflight", async () => {
    readinessOverrides = {
      kept_keyword_count: "0",
      manual_keyword_count: "17561",
      paid_eligible_keyword_count: "0",
    };
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-readiness`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      missing: ["qualified_keywords"],
      ready: false,
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

  it.each([
    { baseline: true, mode: "recalculate", dirty: false, status: 202 },
    { baseline: false, mode: "recalculate", dirty: false, status: 409 },
    { baseline: true, mode: "recalculate", dirty: true, status: 409 },
    { baseline: true, mode: "full", dirty: false, status: 409 },
  ])("recovers qualification only from an unchanged completed baseline: %j", async ({ baseline, mode, dirty, status }) => {
    completedQualification = baseline;
    readinessOverrides = { kept_keyword_count: "0", keywords_dirty: dirty };
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
    });
    expect(response.status).toBe(status);
    expect(orchestrator.start).toHaveBeenCalledTimes(status === 202 ? 1 : 0);
  });

  it("persists operator thresholds and starts a server-side full run", async () => {
    const policy = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-readiness`, {
      body: JSON.stringify({ competitiveEnrichmentVolumeFloor: 500, gscPromotionImpressionsFloor: 25 }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(policy.status).toBe(200);

    const run = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      body: JSON.stringify({ mode: "full" }),
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
  it("resumes a failed run and starts another execution with its saved stages", async () => {
    hasCheckpoint = true;
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "resume", sourceRunId: failedRunId }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: failedRunId, resumed: true, recoveredStageCount: 2, generation: 1, startExecution: true });
    expect(orchestrator.start).toHaveBeenCalledWith(failedRunId, 1);
    expect(recoveryWrites.find(sql => sql.startsWith("UPDATE pipeline_stage_runs"))).toContain("state <> 'succeeded'");
    expect(recoveryWrites.find(sql => sql.startsWith("UPDATE provider_work_items"))).toContain("provider_task_id IS NOT NULL THEN 'submitted'");
  });

  it.each(["missing", "changed", "draining"])("rejects %s checkpoints without starting paid work", async kind => {
    hasCheckpoint = kind !== "missing"; changedInputs = kind === "changed"; idle = kind !== "draining";
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/pipeline-runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "resume" }),
    });
    expect(response.status).toBe(409);
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(recoveryWrites).toHaveLength(0);
  });

});
