import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import { loadStageOutput, storeStageOutput } from "../../../packages/runtime/src/stage-output.js";
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
import {
  executeDataDrivenStage,
  PipelinePreflightError,
  PipelineReadinessError,
} from "../../../packages/pipeline/src/stage-handlers.js";
import {
  loadProjectPipelineSource,
  persistProjectStageData,
  projectIdFromInput,
} from "./project-data.js";
import type { PipelineProviderHydrator } from "./live-providers.js";
import { restoreKeywordDecisions } from "./recalculation.js";
import { StageContinuation, STAGE_EXECUTION_BUDGET_MS } from "./stage-continuation.js";

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
  stageBudgetMilliseconds?: number;
}

export function pipelineStageExecutionError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && error.code === "54000") {
    return new HttpError(422, "pipeline_output_storage_failed",
      "Calculation output exceeded a storage limit. Automatic retries stopped; previously completed stages are preserved.");
  }
  if (error instanceof PipelineReadinessError) {
    return new HttpError(422, "pipeline_inputs_incomplete", error.message);
  }
  if (error instanceof PipelinePreflightError) {
    return new HttpError(422, "pipeline_preflight_failed", error.message);
  }
  return error;
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
  const userMessage = pipelineStageFailureMessage(failure.stageId, failure.reason);
  return withTransaction(pool, async (client) => {
    const run = await client.query<{ status: string }>(
      `SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
      [failure.runId],
    );
    if (!run.rows[0]) {
      throw new HttpError(404, "pipeline_run_not_found", "Pipeline run not found.");
    }
    if (run.rows[0].status === "succeeded") {
      return { runId: failure.runId, status: "succeeded", idempotent: true };
    }
    if (run.rows[0].status === "failed") {
      const original = await client.query<{ failed_stage: string }>(
        `SELECT output->>'failedStage' AS failed_stage FROM pipeline_stage_runs
         WHERE run_id = $1 AND output->>'reason' = 'pipeline_failed' LIMIT 1`,
        [failure.runId],
      );
      return { runId: failure.runId, status: "failed", failedStage: original.rows[0]?.failed_stage ?? null, idempotent: true };
    }
    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'failed',
            output = COALESCE(output, '{}'::jsonb) ||
              jsonb_build_object(
                'reason', CASE WHEN stage_id = $2 THEN 'pipeline_failed' ELSE 'pipeline_blocked' END,
                'failedStage', $2::text,
                'message', CASE WHEN stage_id = $2 THEN $3::text
                  ELSE 'Stopped because ' || $2::text || ' failed. Saved progress is preserved; resume after resolving that step.' END
              ),
            completed_at = COALESCE(completed_at, now())
        WHERE run_id = $1
          AND state <> 'succeeded'
      `,
      [failure.runId, failure.stageId, userMessage],
    );
    await client.query(
      `
        UPDATE pipeline_runs
        SET status = 'failed',
            completed_at = COALESCE(completed_at, now())
        WHERE id = $1
          AND status <> 'succeeded'
      `,
      [failure.runId],
    );
    return { failedStage: failure.stageId, runId: failure.runId, status: "failed" };
  });
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
  const outputs = await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL statement_timeout = '600s'");
    const result = await client.query<DependencyOutputRow>(
      `
        SELECT stage_id, output
        FROM pipeline_stage_runs
        WHERE run_id = $1
          AND stage_id = ANY($2::text[])
          AND state = 'succeeded'
      `,
      [runId, dependencies],
    );
    const entries: Array<[PipelineStageId, unknown]> = [];
    for (const row of result.rows) entries.push([row.stage_id, await loadStageOutput(client, runId, row.stage_id, row.output)]);
    return Object.fromEntries(entries) as Partial<Record<PipelineStageId, unknown>>;
  });
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
  const deadline = Date.now() + (options.stageBudgetMilliseconds ?? STAGE_EXECUTION_BUDGET_MS);
  const lease = await pool.connect();
  const key = `${task.runId}:${task.stageId}`;
  let acquired = false;
  try {
    const lock = await lease.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`, [key]);
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return { runId: task.runId, stageId: task.stageId, status: "continuing" };
    try {
      return await executeStageAttempt(pool, task, options, deadline);
    } catch (error) {
      if (!(error instanceof StageContinuation)) {
        const failure = pipelineStageExecutionError(error);
        if (failure instanceof HttpError && failure.code === "pipeline_output_storage_failed") {
          await failPipelineRun(pool, { runId: task.runId, stageId: task.stageId, reason: failure.code });
        }
        throw failure;
      }
      await pool.query(
        `UPDATE pipeline_stage_runs
         SET output = COALESCE(output, '{}'::jsonb) || jsonb_build_object('message', $3::text)
         WHERE run_id = $1 AND stage_id = $2 AND state = 'running'`,
        [task.runId, task.stageId, error.message]);
      return { runId: task.runId, stageId: task.stageId, status: "continuing" };
    }
  } finally {
    // Destroy the dedicated session so a pooled connection can never retain its execution lock.
    lease.release(true);
  }
}

async function executeStageAttempt(
  pool: DatabasePool,
  task: StageTask,
  options: StageExecutionOptions,
  deadline: number,
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
      deadline,
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
  let stageData: ReturnType<typeof executeDataDrivenStage> | null;
  try {
    stageData = source
      ? executeDataDrivenStage(task.stageId, source, dependencyOutputs)
      : null;
  } catch (error) {
    throw pipelineStageExecutionError(error);
  }
  if (!fixture && projectId && source && stageData && options.providerHydrator?.refineStage) {
    stageData = await options.providerHydrator.refineStage(pool, projectId, task.runId, source, stageData, deadline);
  }
  if (!fixture && projectId && stageData && runMode === "recalculate") {
    stageData = await restoreKeywordDecisions(pool, projectId, stageData);
  }
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
    const run = await client.query<{ status: string }>(
      `SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE`, [task.runId]);
    if (run.rows[0]?.status === "failed") {
      throw new HttpError(409, "stage_failed", "Pipeline failure stopped this stage.");
    }
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

    await client.query("SET LOCAL statement_timeout = '600s'");
    if (projectId && stageData) {
      await persistProjectStageData(client, projectId, task.runId, stageData);
    }

    const storedOutput = await storeStageOutput(client, task.runId, task.stageId, output);
    await client.query("SET LOCAL statement_timeout = '600s'");
    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'succeeded',
            output = $3,
            completed_at = now()
        WHERE run_id = $1
          AND stage_id = $2
      `,
      [task.runId, task.stageId, JSON.stringify(storedOutput)],
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
