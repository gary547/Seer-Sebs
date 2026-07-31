import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import {
  PIPELINE_STAGES,
  type PipelineStageId,
} from "../../../packages/pipeline/src/definition.js";

const MAXIMUM_ATTEMPTS = 5;
const LEASE_SECONDS = 30;

interface RunRow {
  id: string;
}

interface StageRow {
  stage_id: PipelineStageId;
  state: string;
}

interface TaskRow {
  attempt_count: number;
  id: string;
  run_id: string;
  stage_id: PipelineStageId;
}

export interface DispatcherConfig {
  identityToken?: (audience: string) => Promise<string>;
  internalToken: string;
  onLoopError?: (error: unknown) => void;
  pollMilliseconds: number;
  pool: DatabasePool;
  workerAudience?: string;
  workerUrl: string;
}

export async function fetchMetadataIdentityToken(audience: string): Promise<string> {
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`,
    {
      headers: {
        "metadata-flavor": "Google",
      },
      signal: AbortSignal.timeout(5_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Metadata identity endpoint returned ${response.status}.`);
  }

  const token = (await response.text()).trim();
  if (!token) {
    throw new Error("Metadata identity endpoint returned an empty token.");
  }
  return token;
}

async function scheduleRun(client: PoolClient, runId: string): Promise<number> {
  const stageResult = await client.query<StageRow>(
    `
      SELECT stage_id, state
      FROM pipeline_stage_runs
      WHERE run_id = $1
      FOR UPDATE
    `,
    [runId],
  );
  const states = new Map(stageResult.rows.map((row) => [row.stage_id, row.state]));
  let scheduled = 0;

  for (const definition of PIPELINE_STAGES) {
    if (states.get(definition.id) !== "pending") {
      continue;
    }

    const ready = definition.dependencies.every(
      (dependency) => states.get(dependency) === "succeeded",
    );

    if (!ready) {
      continue;
    }

    const taskResult = await client.query(
      `
        INSERT INTO local_task_queue (
          idempotency_key,
          run_id,
          stage_id
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [`${runId}:${definition.id}`, runId, definition.id],
    );

    if ((taskResult.rowCount ?? 0) === 0) {
      continue;
    }

    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'queued'
        WHERE run_id = $1
          AND stage_id = $2
          AND state = 'pending'
      `,
      [runId, definition.id],
    );
    scheduled += 1;
  }

  return scheduled;
}

export async function scheduleReadyStages(pool: DatabasePool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const runResult = await client.query<RunRow>(
      `
        SELECT id
        FROM pipeline_runs
        WHERE status IN ('pending', 'running')
          AND EXISTS (
            SELECT 1
            FROM pipeline_stage_runs
            WHERE pipeline_stage_runs.run_id = pipeline_runs.id
              AND pipeline_stage_runs.state = 'pending'
          )
        ORDER BY created_at
        LIMIT 10
        FOR UPDATE SKIP LOCKED
      `,
    );
    let scheduled = 0;

    for (const run of runResult.rows) {
      scheduled += await scheduleRun(client, run.id);
    }

    return scheduled;
  });
}

export async function recoverExpiredLeases(pool: DatabasePool): Promise<number> {
  const result = await pool.query(
    `
      UPDATE local_task_queue
      SET state = 'ready',
          lease_owner = NULL,
          lease_expires_at = NULL,
          available_at = now()
      WHERE state = 'leased'
        AND lease_expires_at < now()
    `,
  );

  return result.rowCount ?? 0;
}

export async function claimTask(
  pool: DatabasePool,
  leaseOwner: string,
): Promise<TaskRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<TaskRow>(
      `
        WITH candidate AS (
          SELECT task.id
          FROM local_task_queue AS task
          JOIN pipeline_runs AS run
            ON run.id = task.run_id
          WHERE task.state = 'ready'
            AND task.available_at <= now()
            AND run.status IN ('pending', 'running')
          ORDER BY task.id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE local_task_queue AS task
        SET state = 'leased',
            attempt_count = task.attempt_count + 1,
            lease_owner = $1,
            lease_expires_at = now() + ($2 * interval '1 second')
        FROM candidate
        WHERE task.id = candidate.id
        RETURNING
          task.id::text,
          task.run_id,
          task.stage_id,
          task.attempt_count
      `,
      [leaseOwner, LEASE_SECONDS],
    );

    return result.rows[0] ?? null;
  });
}

async function completeTask(pool: DatabasePool, taskId: string): Promise<void> {
  await pool.query(
    `
      UPDATE local_task_queue
      SET state = 'succeeded',
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now()
      WHERE id = $1
        AND state = 'leased'
    `,
    [taskId],
  );
}

async function retryOrFailTask(
  pool: DatabasePool,
  task: TaskRow,
  error: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    if (task.attempt_count < MAXIMUM_ATTEMPTS) {
      await client.query(
        `
          UPDATE local_task_queue
          SET state = 'ready',
              available_at = now() + ($2 * interval '1 second'),
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = $3
          WHERE id = $1
        `,
        [task.id, task.attempt_count, error.slice(0, 1_000)],
      );
      return;
    }

    await client.query(
      `
        UPDATE local_task_queue
        SET state = 'failed',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = $2,
            completed_at = now()
        WHERE id = $1
      `,
      [task.id, error.slice(0, 1_000)],
    );
    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'failed',
            output = COALESCE(
              output,
              jsonb_build_object(
                'reason', 'pipeline_failed',
                'failedStage', $2::text
              )
            ),
            completed_at = COALESCE(completed_at, now())
        WHERE run_id = $1
          AND state <> 'succeeded'
      `,
      [task.run_id, task.stage_id],
    );
    await client.query(
      `
        UPDATE local_task_queue
        SET state = 'failed',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = COALESCE(last_error, $3),
            completed_at = COALESCE(completed_at, now())
        WHERE run_id = $1
          AND id <> $2
          AND state IN ('ready', 'leased')
      `,
      [
        task.run_id,
        task.id,
        `Pipeline stopped after ${task.stage_id} exhausted delivery attempts.`,
      ],
    );
    await client.query(
      `
        UPDATE pipeline_runs
        SET status = 'failed',
            completed_at = now()
        WHERE id = $1
      `,
      [task.run_id],
    );
  });
}

export async function dispatchTask(
  config: DispatcherConfig,
  task: TaskRow,
): Promise<void> {
  try {
    const authorizationToken = config.workerAudience
      ? await (config.identityToken ?? fetchMetadataIdentityToken)(
          config.workerAudience,
        )
      : config.internalToken;
    const response = await fetch(`${config.workerUrl}/internal/tasks`, {
      body: JSON.stringify({
        runId: task.run_id,
        stageId: task.stage_id,
        taskId: task.id,
      }),
      headers: {
        authorization: `Bearer ${authorizationToken}`,
        "content-type": "application/json",
        "x-seer-internal-token": config.internalToken,
      },
      method: "POST",
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Worker returned ${response.status}: ${body}`);
    }

    await completeTask(config.pool, task.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await retryOrFailTask(config.pool, task, message);
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runDispatcher(
  config: DispatcherConfig,
  signal: AbortSignal,
): Promise<void> {
  const leaseOwner = `dispatcher-${randomUUID()}`;

  while (!signal.aborted) {
    try {
      await recoverExpiredLeases(config.pool);
      await scheduleReadyStages(config.pool);
      const task = await claimTask(config.pool, leaseOwner);

      if (task) {
        await dispatchTask(config, task);
        continue;
      }
    } catch (error) {
      if (config.onLoopError) {
        config.onLoopError(error);
      } else {
        console.error(error);
      }
    }

    await wait(config.pollMilliseconds, signal);
  }
}
