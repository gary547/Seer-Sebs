import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PIPELINE_STAGES } from "../../../packages/pipeline/src/definition.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { resolvePipelineRunFailure } from "../src/pipeline-runs.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000004";
const startedAt = new Date("2026-08-18T11:00:00.000Z");
const completedAt = new Date("2026-08-18T12:00:00.000Z");

function result(rows: unknown[], rowCount = rows.length) {
  return { rowCount, rows };
}

function database(): DatabasePool {
  const query = vi.fn(async (sqlValue: string, params: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, " ").trim();
    if (sql.includes("SELECT approval_status FROM profiles")) {
      return result([{ approval_status: "approved" }]);
    }
    if (
      sql.includes("SELECT id, user_id, status, input, created_at, started_at, completed_at") &&
      sql.includes("FROM pipeline_runs")
    ) {
      return result([
        {
          completed_at: completedAt,
          created_at: startedAt,
          id: runId,
          input: { projectId: "00000000-0000-4000-8000-000000000002" },
          started_at: startedAt,
          status: "succeeded",
          user_id: userId,
        },
      ]);
    }
    if (
      sql.includes("FROM pipeline_stage_runs") &&
      sql.includes("AND stage_id = ANY")
    ) {
      const requested = params[1] as string[];
      return result(
        requested.map((stageId) => ({
          attempts: 1,
          completed_at: completedAt,
          output: { stageId, rows: 12 },
          stage_id: stageId,
          started_at: startedAt,
          state: "succeeded",
        })),
      );
    }
    if (sql.includes("FROM pipeline_stage_runs")) {
      return result(
        PIPELINE_STAGES.map((definition) => ({
          attempts: 1,
          completed_at: completedAt,
          output: null,
          stage_id: definition.id,
          started_at: startedAt,
          state: "succeeded",
        })),
      );
    }
    if (sql.includes("FROM event_deliveries")) {
      return result([{ count: "3" }]);
    }
    if (sql.includes("FROM provider_work_items")) {
      return result([]);
    }
    throw new Error(`Unexpected SQL in pipeline stage batch test: ${sql}`);
  });
  return { connect: vi.fn(), query } as unknown as DatabasePool;
}

describe("pipeline failure attribution", () => {
  it("prefers the recorded failed stage over cascaded zeros", () => {
    expect(
      resolvePipelineRunFailure([
        {
          attempts: 0,
          id: "categorisation",
          output: { failedStage: "keyword-enrichment", reason: "pipeline_failed" },
          state: "failed",
        },
        {
          attempts: 2,
          id: "keyword-enrichment",
          output: {
            failedStage: "keyword-enrichment",
            message: "Provider API failed after five attempts.",
          },
          state: "failed",
        },
      ]),
    ).toEqual({
      attempts: 2,
      message: "Provider API failed after five attempts.",
      stageId: "keyword-enrichment",
    });
  });

  it("does not expose legacy workflow payloads for failed runs", () => {
    expect(
      resolvePipelineRunFailure([
        {
          attempts: 81,
          id: "detox",
          output: {
            failedStage: "detox",
            message:
              '{"code":500,"message":"HTTP server responded with error code 500","headers":{"x-cloud-trace":"secret"}}',
          },
          state: "failed",
        },
      ]),
    ).toEqual({
      attempts: 81,
      message:
        "Keyword qualification did not finish after automatic retries. Project data was left unchanged; resume the pipeline to try again.",
      stageId: "detox",
    });
  });
});

describe("pipeline run stage batches", () => {
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("returns only the requested stage output", async () => {
    const response = await fetch(
      `${baseUrl}/v1/pipeline-runs/${runId}/stages?ids=rollup-output`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId,
      stages: [
        {
          attempts: 1,
          completedAt: completedAt.toISOString(),
          id: "rollup-output",
          output: { rows: 12, stageId: "rollup-output" },
          startedAt: startedAt.toISOString(),
          state: "succeeded",
        },
      ],
    });
  });

  it("rejects oversized or unknown batches", async () => {
    const oversized = await fetch(
      `${baseUrl}/v1/pipeline-runs/${runId}/stages?ids=intake,detox`,
    );
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "pipeline_stage_batch_too_large" },
    });

    const unknown = await fetch(
      `${baseUrl}/v1/pipeline-runs/${runId}/stages?ids=not-a-stage`,
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      error: { code: "invalid_pipeline_stage" },
    });
  });

  it("keeps the detailed run payload off by default", async () => {
    const response = await fetch(`${baseUrl}/v1/pipeline-runs/${runId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      failure: unknown;
      stages: Array<{ output?: unknown }>;
    };
    expect(body.stages[0]?.output).toBeUndefined();
    expect(body.failure).toBeNull();
  });

  it("cancels a running pipeline run from the API", async () => {
    let cancelled = false;
    const query = vi.fn(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
      if (sql.includes("SELECT approval_status FROM profiles")) {
        return result([{ approval_status: "approved" }]);
      }
      if (sql.includes("SELECT id, user_id, status, input, created_at, started_at, completed_at")) {
        return result([
          {
            completed_at: cancelled ? completedAt : null,
            created_at: startedAt,
            id: runId,
            input: { projectId: "00000000-0000-4000-8000-000000000002" },
            started_at: startedAt,
            status: cancelled ? "failed" : "running",
            user_id: userId,
          },
        ]);
      }
      if (sql.includes("SELECT client_id FROM navigator_projects")) {
        return result([{ client_id: "00000000-0000-4000-8000-000000000003" }]);
      }
      if (sql.includes("SELECT user_role.role FROM user_roles")) {
        return result([{ role: "super_admin" }]);
      }
      if (sql.includes("SELECT stage_id, state FROM pipeline_stage_runs")) {
        return result([
          { stage_id: "serp-collection", state: "running" },
          { stage_id: "authority", state: "pending" },
        ]);
      }
      if (sql.includes("UPDATE pipeline_runs")) {
        cancelled = true;
        return result([], 1);
      }
      if (sql.includes("UPDATE pipeline_stage_runs")) {
        return result([], 1);
      }
      if (sql.includes("FROM pipeline_stage_runs")) {
        return result(
          PIPELINE_STAGES.map((definition) => ({
            attempts: definition.id === "serp-collection" ? 1 : 0,
            completed_at: completedAt,
            output:
              definition.id === "serp-collection"
                ? { failedStage: "serp-collection", reason: "pipeline_cancelled" }
                : null,
            stage_id: definition.id,
            started_at: startedAt,
            state: ["intake", "detox", "preflight", "categorisation"].includes(
              definition.id,
            )
              ? "succeeded"
              : "failed",
          })),
        );
      }
      if (sql.includes("FROM event_deliveries")) {
        return result([{ count: "3" }]);
      }
      if (sql.includes("FROM provider_work_items")) {
        return result([]);
      }
      throw new Error(`Unexpected SQL in cancel test: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    server.close();
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
      pool: {
        connect: vi.fn(async () => client),
        query,
      } as unknown as DatabasePool,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}/v1/pipeline-runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      failure: { stageId: string } | null;
      status: string;
    };
    expect(body.status).toBe("failed");
    expect(body.failure?.stageId).toBe("serp-collection");
  });
});
