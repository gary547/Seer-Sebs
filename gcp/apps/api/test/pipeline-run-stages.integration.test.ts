import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PIPELINE_STAGES } from "../../../packages/pipeline/src/definition.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
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
    throw new Error(`Unexpected SQL in pipeline stage batch test: ${sql}`);
  });
  return { connect: vi.fn(), query } as unknown as DatabasePool;
}

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

  it("returns only the requested stage outputs", async () => {
    const response = await fetch(
      `${baseUrl}/v1/pipeline-runs/${runId}/stages?ids=rollup-output,categorisation`,
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
        {
          attempts: 1,
          completedAt: completedAt.toISOString(),
          id: "categorisation",
          output: { rows: 12, stageId: "categorisation" },
          startedAt: startedAt.toISOString(),
          state: "succeeded",
        },
      ],
    });
  });

  it("rejects oversized or unknown batches", async () => {
    const oversized = await fetch(
      `${baseUrl}/v1/pipeline-runs/${runId}/stages?ids=intake,detox,preflight,categorisation,clustering,authority,backlinks`,
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
      stages: Array<{ output?: unknown }>;
    };
    expect(body.stages[0]?.output).toBeUndefined();
  });
});
