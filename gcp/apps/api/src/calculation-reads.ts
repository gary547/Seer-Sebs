import type { QueryResult, QueryResultRow } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";

interface DiagnosticReads {
  active: number;
  waiting: Array<() => void>;
}

const diagnosticReads = new WeakMap<DatabasePool, DiagnosticReads>();

export async function queryCalculationDiagnostic<Row extends QueryResultRow>(
  pool: DatabasePool, text: string, values: unknown[],
): Promise<QueryResult<Row>> {
  let state = diagnosticReads.get(pool);
  if (!state) {
    state = { active: 0, waiting: [] };
    diagnosticReads.set(pool, state);
  }
  if (state.active < 2) state.active += 1;
  else await new Promise<void>(resolve => state.waiting.push(resolve));
  try {
    return await pool.query<Row>(text, values);
  } finally {
    const next = state.waiting.shift();
    if (next) next();
    else state.active -= 1;
  }
}
