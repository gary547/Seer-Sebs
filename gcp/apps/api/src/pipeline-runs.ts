import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  PIPELINE_STAGES,
  type PipelineStageId,
} from "../../../packages/pipeline/src/definition.js";
import { assertProjectAccessByRole } from "./authorization.js";

interface PipelineRunRow {
  completed_at: Date | null;
  created_at: Date;
  id: string;
  input: unknown;
  started_at: Date | null;
  status: string;
  user_id: string;
}

interface PipelineStageRow {
  attempts: number;
  completed_at: Date | null;
  output: unknown;
  stage_id: PipelineStageId;
  started_at: Date | null;
  state: string;
}

interface EventCountRow {
  count: string;
}

async function insertStages(client: PoolClient, runId: string): Promise<void> {
  for (const stage of PIPELINE_STAGES) {
    await client.query(
      `
        INSERT INTO pipeline_stage_runs (run_id, stage_id)
        VALUES ($1, $2)
      `,
      [runId, stage.id],
    );
  }
}

export async function createPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const projectId =
    typeof input.projectId === "string" ? input.projectId : null;
  let id: string = randomUUID();
  let resumed = false;
  let status = "pending";

  await withTransaction(pool, async (client) => {
    if (projectId) {
      await assertProjectAccessByRole(client, user.id, projectId, true);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [projectId],
      );
      const existing = await client.query<{ id: string; status: string }>(
        `
          SELECT id, status
          FROM pipeline_runs
          WHERE input->>'projectId' = $1
            AND status IN ('pending', 'running')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [projectId],
      );
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        status = existing.rows[0].status;
        resumed = true;
        return;
      }
    }
    await client.query(
      `
        INSERT INTO pipeline_runs (id, user_id, input)
        VALUES ($1, $2, $3)
      `,
      [id, user.id, JSON.stringify(input)],
    );
    await insertStages(client, id);
  });

  return {
    id,
    resumed,
    stageCount: PIPELINE_STAGES.length,
    status,
  };
}

export async function getPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
  includeOutput = true,
): Promise<Record<string, unknown>> {
  const runResult = await pool.query<PipelineRunRow>(
    `
      SELECT id, user_id, status, input, created_at, started_at, completed_at
      FROM pipeline_runs
      WHERE id = $1
    `,
    [id],
  );
  const run = runResult.rows[0];

  if (!run) {
    throw new HttpError(404, "pipeline_run_not_found", "Pipeline run not found.");
  }
  const input =
    run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>)
      : {};
  if (run.user_id !== user.id) {
    const projectId = input.projectId;
    if (typeof projectId !== "string") {
      throw new HttpError(
        404,
        "pipeline_run_not_found",
        "Pipeline run not found.",
      );
    }
    await assertProjectAccessByRole(pool, user.id, projectId);
  }

  const [stageResult, eventResult] = await Promise.all([
    pool.query<PipelineStageRow>(
      `
        SELECT
          stage_id,
          state,
          attempts,
          ${includeOutput ? "output" : "NULL::jsonb AS output"},
          started_at,
          completed_at
        FROM pipeline_stage_runs
        WHERE run_id = $1
      `,
      [id],
    ),
    pool.query<EventCountRow>(
      `
        SELECT count(*)::text AS count
        FROM event_deliveries
        WHERE aggregate_id = $1
      `,
      [id],
    ),
  ]);
  const rowsByStage = new Map(stageResult.rows.map((stage) => [stage.stage_id, stage]));

  return {
    completedAt: run.completed_at?.toISOString() ?? null,
    createdAt: run.created_at.toISOString(),
    deliveredEventCount: Number(eventResult.rows[0]?.count ?? "0"),
    id: run.id,
    input: run.input,
    stages: PIPELINE_STAGES.map((definition) => {
      const stage = rowsByStage.get(definition.id);

      if (!stage) {
        throw new Error(`Missing stage row for ${definition.id}.`);
      }

      return {
        attempts: stage.attempts,
        completedAt: stage.completed_at?.toISOString() ?? null,
        dependencies: definition.dependencies,
        execution: definition.execution,
        id: definition.id,
        ...(includeOutput ? { output: stage.output } : {}),
        startedAt: stage.started_at?.toISOString() ?? null,
        state: stage.state,
      };
    }),
    startedAt: run.started_at?.toISOString() ?? null,
    status: run.status,
  };
}

export async function getLatestProjectPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  includeOutput = false,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM pipeline_runs
      WHERE input->>'projectId' = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [projectId],
  );
  const run = result.rows[0];
  if (!run) {
    return {
      projectId,
      run: null,
    };
  }
  return {
    projectId,
    run: await getPipelineRun(pool, user, run.id, includeOutput),
  };
}
