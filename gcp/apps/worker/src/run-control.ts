import { AsyncLocalStorage } from "node:async_hooks";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";

interface RunExecution {
  pool: DatabasePool;
  runId: string;
  generation: number;
}

const execution = new AsyncLocalStorage<RunExecution>();

export function withProviderRun<T>(pool: DatabasePool, runId: string, generation: number, work: () => Promise<T>): Promise<T> {
  return execution.run({ pool, runId, generation }, work);
}

export async function checkProviderRunActive(): Promise<void> {
  const current = execution.getStore();
  if (!current) return;
  const result = await current.pool.query<{ status: string; generation: number }>(
    `SELECT status, COALESCE((input->>'generation')::int, 0) AS generation
     FROM pipeline_runs WHERE id = $1`, [current.runId]);
  const run = result.rows[0];
  if (!run || !["pending", "running"].includes(run.status) || run.generation !== current.generation) {
    throw new HttpError(422, "pipeline_stopped", "Pipeline stopped. Completed results and submitted provider tasks are saved for resume.");
  }
}
