import process from "node:process";

import pg, { type PoolClient, type QueryResultRow } from "pg";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(
  connectionString = process.env.DATABASE_URL,
): DatabasePool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  return new Pool({
    connectionString,
    max: 10,
    statement_timeout: 10_000,
  });
}

export async function assertDatabaseReady(pool: DatabasePool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function withTransaction<T>(
  pool: DatabasePool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function firstRow<T extends QueryResultRow>(
  rows: readonly T[],
  message: string,
): T {
  const row = rows[0];

  if (!row) {
    throw new Error(message);
  }

  return row;
}
