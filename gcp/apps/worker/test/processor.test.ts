import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import { PipelinePreflightError } from "../../../packages/pipeline/src/stage-handlers.js";
import {
  failPipelineRun,
  executeStageTask,
  pipelineStageExecutionError,
  shouldInjectLocalFailure,
} from "../src/processor.js";

describe("local worker failure injection", () => {
  const input = {
    localValidation: {
      failAttempts: 2,
      failStage: "categorisation",
    },
  };

  it("is disabled unless the worker explicitly enables local injection", () => {
    expect(shouldInjectLocalFailure(input, "categorisation", 1, false)).toBe(false);
  });

  it("fails only the configured stage and attempt window", () => {
    expect(shouldInjectLocalFailure(input, "categorisation", 1, true)).toBe(true);
    expect(shouldInjectLocalFailure(input, "categorisation", 2, true)).toBe(true);
    expect(shouldInjectLocalFailure(input, "categorisation", 3, true)).toBe(false);
    expect(shouldInjectLocalFailure(input, "detox", 1, true)).toBe(false);
  });

  it("rejects malformed local validation contracts", () => {
    expect(() =>
      shouldInjectLocalFailure(
        { localValidation: { failAttempts: 10, failStage: "unknown" } },
        "categorisation",
        1,
        true,
      ),
    ).toThrow("Invalid local failure-injection contract");
  });
});

describe("pipeline failure recording", () => {
  it("loads large dependency outputs with a transaction-local timeout", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT state")) return { rows: [{ state: "running" }], rowCount: 1 };
      if (sql.includes("SELECT stage_id, state")) return { rows: [{ stage_id: "calibration", state: "running" }, { stage_id: "revenue-v2", state: "succeeded" }], rowCount: 2 };
      if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }], rowCount: 1 };
      if (sql.includes("SELECT input")) return { rows: [{ input: {} }], rowCount: 1 };
      if (sql.includes("SELECT stage_id, output")) return { rows: [{ stage_id: "revenue-v2", output: {} }], rowCount: 1 };
      if (sql.includes("count(*)::text")) return { rows: [{ count: "1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: async () => client } as unknown as DatabasePool;
    expect(await executeStageTask(pool, { runId: "test-run", stageId: "calibration", taskId: "test-task" })).toMatchObject({ status: "succeeded" });
    const statements = query.mock.calls.map(([sql]) => sql);
    const dependencyIndex = statements.findIndex(sql => sql.includes("SELECT stage_id, output"));
    expect(statements[dependencyIndex - 1]).toBe("SET LOCAL statement_timeout = '600s'");
    expect(statements[dependencyIndex + 1]).toBe("COMMIT");
  });

  it("extends only the transactional stage-output write timeout for large results", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT state")) return { rows: [{ state: "running" }], rowCount: 1 };
      if (sql.includes("SELECT stage_id, state")) return { rows: [{ stage_id: "intake", state: "running" }], rowCount: 1 };
      if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }], rowCount: 1 };
      if (sql.includes("SELECT input")) return { rows: [{ input: {} }], rowCount: 1 };
      if (sql.includes("count(*)::text")) return { rows: [{ count: "23" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: async () => client } as unknown as DatabasePool;
    expect(await executeStageTask(pool, { runId: "test-run", stageId: "intake", taskId: "test-task" })).toMatchObject({ status: "succeeded" });
    const statements = query.mock.calls.map(([sql]) => sql);
    const persistIndex = statements.findIndex(sql => sql.includes("SET state = 'succeeded'"));
    expect(statements[persistIndex - 1]).toBe("SET LOCAL statement_timeout = '600s'");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("maps deterministic preflight failures to a non-retryable response", () => {
    const error = pipelineStageExecutionError(
      new PipelinePreflightError(["kept_keywords"]),
    );

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: "pipeline_preflight_failed",
      statusCode: 422,
    });
  });

  it("stores a stage-specific operator message instead of the raw workflow error", async () => {
    const queries: Array<{ params: unknown[]; sql: string }> = [];
    const client = {
      query: async (sqlValue: string, params: unknown[] = []) => {
        const sql = sqlValue.replace(/\s+/g, " ").trim();
        queries.push({ params, sql });
        return {
          rowCount: sql.startsWith("UPDATE pipeline_runs") ? 1 : null,
          rows: [],
        };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as DatabasePool;

    await failPipelineRun(pool, {
      reason: '{"code":500,"message":"internal_error","headers":{"x-cloud-trace":"secret"}}',
      runId: "00000000-0000-4000-8000-000000000004",
      stageId: "detox",
    });

    const stageUpdate = queries.find((query) =>
      query.sql.startsWith("UPDATE pipeline_stage_runs"),
    );
    expect(stageUpdate?.params[2]).toBe(
      "Keyword qualification did not finish after automatic retries. Project data was left unchanged; resume the pipeline to try again.",
    );
    expect(String(stageUpdate?.params[2])).not.toContain("500");
  });
});
