import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import {
  parseRepresentativeProjectFixture,
  summariseRepresentativeFixture,
  type ProjectPipelineSource,
  type RepresentativeProjectFixture,
  type RepresentativeSourceSummary,
} from "../../../packages/fixtures/src/representative-project.js";
import {
  PIPELINE_STAGES,
  type PipelineStageDefinition,
  type PipelineStageId,
} from "../../../packages/pipeline/src/definition.js";
import { pipelineStageFailureMessage } from "../../../packages/pipeline/src/failure-messages.js";
import { executeDataDrivenStage } from "../../../packages/pipeline/src/stage-handlers.js";
import {
  loadProjectPipelineSource,
  persistProjectStageData,
  projectIdFromInput,
} from "./project-data.js";
import type { PipelineProviderHydrator } from "./live-providers.js";

export interface StageTask {
  runId: string;
  stageId: PipelineStageId;
  taskId: string;
}

export interface PipelineFailure {
  reason: string;
  runId: string;
  stageId: PipelineStageId;
}

interface StageStateRow {
  stage_id: PipelineStageId;
  state: string;
}

interface StageLockRow {
  state: string;
}

interface StageAttemptRow {
  attempts: number;
}

interface PipelineInputRow {
  input: unknown;
}

interface DependencyOutputRow {
  output: unknown;
  stage_id: PipelineStageId;
}

interface MarkRunningResult {
  attempts: number;
  state: "already_succeeded" | "running";
}

export interface StageExecutionOptions {
  allowLocalFailureInjection?: boolean;
  providerHydrator?: PipelineProviderHydrator;
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_task", "The task body is invalid.");
  }

  return value as Record<string, unknown>;
}

function stageDefinition(value: unknown): PipelineStageDefinition {
  const stageId = requireString(value, "stageId", 64);
  const definition = PIPELINE_STAGES.find((stage) => stage.id === stageId);

  if (!definition) {
    throw new HttpError(400, "unknown_stage", "The pipeline stage is unknown.");
  }

  return definition;
}

export function parseStageTask(body: unknown): StageTask {
  const record = recordBody(body);
  const definition = stageDefinition(record.stageId);

  return {
    runId: requireString(record.runId, "runId", 64),
    stageId: definition.id,
    taskId: requireString(record.taskId, "taskId", 64),
  };
}

export function parsePipelineFailure(body: unknown): PipelineFailure {
  const record = recordBody(body);
  const definition = stageDefinition(record.stageId);
  return {
    reason: requireString(record.reason, "reason", 1_000),
    runId: requireString(record.runId, "runId", 64),
    stageId: definition.id,
  };
}

export async function failPipelineRun(
  pool: DatabasePool,
  failure: PipelineFailure,
): Promise<Record<string, unknown>> {
  const userMessage = pipelineStageFailureMessage(failure.stageId);
  await withTransaction(pool, async (client) => {
    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'failed',
            output = COALESCE(output, '{}'::jsonb) ||
              jsonb_build_object(
                'reason', 'pipeline_failed',
                'failedStage', $2::text,
                'message', $3::text
              ),
            completed_at = COALESCE(completed_at, now())
        WHERE run_id = $1
          AND state <> 'succeeded'
      `,
      [failure.runId, failure.stageId, userMessage],
    );
    const result = await client.query(
      `
        UPDATE pipeline_runs
        SET status = 'failed',
            completed_at = COALESCE(completed_at, now())
        WHERE id = $1
          AND status <> 'succeeded'
      `,
      [failure.runId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new HttpError(404, "pipeline_run_not_found", "Pipeline run not found.");
    }
  });

  return {
    failedStage: failure.stageId,
    runId: failure.runId,
    status: "failed",
  };
}

async function markRunning(
  client: PoolClient,
  task: StageTask,
  definition: PipelineStageDefinition,
): Promise<MarkRunningResult> {
  const lockResult = await client.query<StageLockRow>(
    `
      SELECT state
      FROM pipeline_stage_runs
      WHERE run_id = $1
        AND stage_id = $2
      FOR UPDATE
    `,
    [task.runId, task.stageId],
  );
  const stage = lockResult.rows[0];

  if (!stage) {
    throw new HttpError(404, "stage_not_found", "Pipeline stage not found.");
  }
  if (stage.state === "succeeded") {
    return { attempts: 0, state: "already_succeeded" };
  }
  if (stage.state === "failed") {
    throw new HttpError(409, "stage_failed", "Pipeline stage is already failed.");
  }

  const statesResult = await client.query<StageStateRow>(
    `
      SELECT stage_id, state
      FROM pipeline_stage_runs
      WHERE run_id = $1
    `,
    [task.runId],
  );
  const states = new Map(statesResult.rows.map((row) => [row.stage_id, row.state]));
  const unavailableDependency = definition.dependencies.find(
    (dependency) => states.get(dependency) !== "succeeded",
  );

  if (unavailableDependency) {
    throw new HttpError(
      409,
      "dependencies_not_ready",
      `Dependency ${unavailableDependency} is not ready.`,
    );
  }

  const attemptResult = await client.query<StageAttemptRow>(
    `
      UPDATE pipeline_stage_runs
      SET state = 'running',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, now())
      WHERE run_id = $1
        AND stage_id = $2
      RETURNING attempts
    `,
    [task.runId, task.stageId],
  );
  const attempts = attemptResult.rows[0]?.attempts;
  if (attempts === undefined) {
    throw new Error(`Could not increment attempts for ${task.stageId}.`);
  }
  await client.query(
    `
      UPDATE pipeline_runs
      SET status = 'running',
          started_at = COALESCE(started_at, now())
      WHERE id = $1
        AND status = 'pending'
    `,
    [task.runId],
  );

  return { attempts, state: "running" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function shouldInjectLocalFailure(
  input: unknown,
  stageId: PipelineStageId,
  attempt: number,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  const validation = object(object(input)?.localValidation);
  if (!validation) return false;

  const failStage = validation.failStage;
  const failAttempts = validation.failAttempts;
  if (
    typeof failStage !== "string" ||
    !PIPELINE_STAGES.some((stage) => stage.id === failStage) ||
    typeof failAttempts !== "number" ||
    !Number.isInteger(failAttempts) ||
    failAttempts < 1 ||
    failAttempts > 5
  ) {
    throw new Error("Invalid local failure-injection contract.");
  }

  return failStage === stageId && attempt <= failAttempts;
}

function representativeFixture(input: unknown): RepresentativeProjectFixture | null {
  const fixture = object(input)?.fixture;
  if (fixture === undefined) return null;
  return parseRepresentativeProjectFixture(fixture);
}

function fixtureSummary(
  fixture: RepresentativeProjectFixture | null,
): RepresentativeSourceSummary | null {
  return fixture ? summariseRepresentativeFixture(fixture) : null;
}

async function loadDependencyOutputs(
  pool: DatabasePool,
  runId: string,
  dependencies: readonly PipelineStageId[],
): Promise<Partial<Record<PipelineStageId, unknown>>> {
  if (dependencies.length === 0) return {};
  const result = await pool.query<DependencyOutputRow>(
    `
      SELECT stage_id, output
      FROM pipeline_stage_runs
      WHERE run_id = $1
        AND stage_id = ANY($2::text[])
        AND state = 'succeeded'
    `,
    [runId, dependencies],
  );
  const outputs = Object.fromEntries(
    result.rows.map((row) => [row.stage_id, row.output]),
  ) as Partial<Record<PipelineStageId, unknown>>;
  const missing = dependencies.find((stageId) => outputs[stageId] === undefined);
  if (missing) {
    throw new Error(`Dependency output ${missing} is missing for run ${runId}.`);
  }
  return outputs;
}

export async function executeStageTask(
  pool: DatabasePool,
  task: StageTask,
  options: StageExecutionOptions = {},
): Promise<Record<string, unknown>> {
  const definition = PIPELINE_STAGES.find((stage) => stage.id === task.stageId);

  if (!definition) {
    throw new HttpError(400, "unknown_stage", "The pipeline stage is unknown.");
  }

  const execution = await withTransaction(pool, (client) =>
    markRunning(client, task, definition),
  );

  if (execution.state === "already_succeeded") {
    return {
      idempotent: true,
      runId: task.runId,
      stageId: task.stageId,
      status: "succeeded",
    };
  }

  const inputResult = await pool.query<PipelineInputRow>(
    `
      SELECT input
      FROM pipeline_runs
      WHERE id = $1
    `,
    [task.runId],
  );
  const input = inputResult.rows[0]?.input;
  if (input === undefined) {
    throw new Error(`Pipeline input is missing for run ${task.runId}.`);
  }
  if (
    shouldInjectLocalFailure(
      input,
      task.stageId,
      execution.attempts,
      options.allowLocalFailureInjection === true,
    )
  ) {
    throw new Error(
      `Injected local failure for ${task.stageId} attempt ${execution.attempts}.`,
    );
  }

  const fixture = representativeFixture(input);
  const runMode = object(input)?.mode === "recalculate" ? "recalculate" : "full";
  const projectId = projectIdFromInput(input);
  if (!fixture && projectId && options.providerHydrator) {
    await options.providerHydrator.hydrate(
      pool,
      projectId,
      task.runId,
      task.stageId,
    );
  }
  const source: ProjectPipelineSource | null =
    fixture ?? (projectId ? await loadProjectPipelineSource(pool, projectId) : null);
  const representativeSummary = fixtureSummary(fixture);
  const dependencyOutputs = await loadDependencyOutputs(
    pool,
    task.runId,
    definition.dependencies,
  );
  const stageData = source
    ? executeDataDrivenStage(task.stageId, source, dependencyOutputs)
    : null;
  const digest = createHash("sha256")
    .update(`${task.runId}:${task.stageId}`)
    .digest("hex");
  const output = {
    dependencyCount: definition.dependencies.length,
    digest,
    execution: definition.execution,
    ...(representativeSummary ? { fixtureSummary: representativeSummary } : {}),
    ...(stageData ?? {}),
    validationMode: representativeSummary
      ? "local-synthetic-contract"
      : projectId
        ? options.providerHydrator
          ? "managed-project-data"
          : "local-project-data"
        : "local-structural",
  };

  await withTransaction(pool, async (client) => {
    const result = await client.query<StageLockRow>(
      `
        SELECT state
        FROM pipeline_stage_runs
        WHERE run_id = $1
          AND stage_id = $2
        FOR UPDATE
      `,
      [task.runId, task.stageId],
    );

    if (result.rows[0]?.state === "succeeded") {
      return;
    }
    if (result.rows[0]?.state === "failed") {
      throw new HttpError(409, "stage_failed", "Pipeline failure stopped this stage.");
    }

    if (projectId && stageData) {
      await persistProjectStageData(client, projectId, task.runId, stageData);
    }

    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'succeeded',
            output = $3,
            completed_at = now()
        WHERE run_id = $1
          AND stage_id = $2
      `,
      [task.runId, task.stageId, JSON.stringify(output)],
    );
    await client.query(
      `
        INSERT INTO outbox_events (
          event_id,
          idempotency_key,
          event_type,
          aggregate_id,
          payload
        )
        VALUES ($1, $2, 'pipeline.stage.succeeded', $3, $4)
      `,
      [
        randomUUID(),
        `${task.runId}:${task.stageId}:succeeded`,
        task.runId,
        JSON.stringify({
          runId: task.runId,
          stageId: task.stageId,
          taskId: task.taskId,
        }),
      ],
    );

    const incompleteResult = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM pipeline_stage_runs
        WHERE run_id = $1
          AND state <> 'succeeded'
      `,
      [task.runId],
    );

    if (incompleteResult.rows[0]?.count === "0") {
      await client.query(
        `
          UPDATE pipeline_runs
          SET status = 'succeeded',
              completed_at = now()
          WHERE id = $1
        `,
        [task.runId],
      );
      if (projectId) {
        await client.query(
          `
            UPDATE navigator_projects
            SET
              last_synced_at = now(),
              last_dirty_at = CASE
                WHEN $2 = 'recalculate' AND (keywords_dirty OR serp_dirty)
                  THEN last_dirty_at
                ELSE NULL
              END,
              keywords_dirty = CASE
                WHEN $2 = 'recalculate' THEN keywords_dirty
                ELSE false
              END,
              serp_dirty = CASE
                WHEN $2 = 'recalculate' THEN serp_dirty
                ELSE false
              END,
              inputs_dirty = false,
              updated_at = now()
            WHERE id = $1
          `,
          [projectId, runMode],
        );
      }
    }
  });

  return {
    idempotent: false,
    output,
    runId: task.runId,
    stageId: task.stageId,
    status: "succeeded",
  };
}
