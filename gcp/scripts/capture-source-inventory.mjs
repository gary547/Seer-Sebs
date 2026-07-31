import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import pg from "pg";

const { Client } = pg;
const databaseUrl =
  process.env.SEER_INVENTORY_DATABASE_URL ??
  process.env.SEER_SOURCE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "SEER_INVENTORY_DATABASE_URL or SEER_SOURCE_DATABASE_URL is required.",
  );
}

const labelArgumentIndex = process.argv.indexOf("--label");
const databaseLabel =
  labelArgumentIndex >= 0 && process.argv[labelArgumentIndex + 1]
    ? process.argv[labelArgumentIndex + 1]
    : "source";
if (!/^[a-z][a-z0-9_-]{1,31}$/.test(databaseLabel)) {
  throw new Error("--label must be a short lowercase evidence label.");
}
const outputArgumentIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1]
    ? process.argv[outputArgumentIndex + 1]
    : `migration-evidence/${databaseLabel}-inventory.json`,
);

const client = new Client({
  connectionString: databaseUrl,
  statement_timeout: 120_000,
});

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function tableCounts(tables) {
  const counts = [];
  for (const table of tables) {
    const result = await client.query(
      `SELECT count(*)::text AS count FROM ${quotedIdentifier(table.schema)}.${quotedIdentifier(table.name)}`,
    );
    counts.push({
      ...table,
      rowCount: Number(result.rows[0]?.count ?? "0"),
    });
  }
  return counts;
}

await client.connect();
try {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const version = await client.query("SELECT version() AS version");
  const extensions = await client.query(`
      SELECT extname AS name, extversion AS version
      FROM pg_extension
      ORDER BY extname
    `);
  const tables = await client.query(`
      SELECT
        schemaname AS schema,
        tablename AS name,
        pg_total_relation_size(
          format('%I.%I', schemaname, tablename)::regclass
        )::text AS total_bytes
      FROM pg_tables
      WHERE schemaname IN ('public', 'auth', 'storage')
      ORDER BY schemaname, tablename
    `);
  const columns = await client.query(`
      SELECT
        table_schema AS schema,
        table_name AS table,
        ordinal_position AS position,
        column_name AS name,
        data_type,
        udt_name,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema IN ('public', 'auth', 'storage')
      ORDER BY table_schema, table_name, ordinal_position
    `);
  const indexes = await client.query(`
      SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef
      FROM pg_indexes
      WHERE schemaname IN ('public', 'auth', 'storage')
      ORDER BY schemaname, tablename, indexname
    `);
  const foreignKeys = await client.query(`
      SELECT
        namespace.nspname AS schema,
        relation.relname AS table,
        constraint_record.conname AS name,
        pg_get_constraintdef(constraint_record.oid) AS definition
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE constraint_record.contype = 'f'
        AND namespace.nspname IN ('public', 'auth', 'storage')
      ORDER BY namespace.nspname, relation.relname, constraint_record.conname
    `);
  const functions = await client.query(`
      SELECT
        namespace.nspname AS schema,
        procedure.proname AS name,
        pg_get_function_identity_arguments(procedure.oid) AS arguments,
        pg_get_function_result(procedure.oid) AS result,
        language.lanname AS language,
        md5(pg_get_functiondef(procedure.oid)) AS definition_hash
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      JOIN pg_language AS language ON language.oid = procedure.prolang
      WHERE namespace.nspname = 'public'
      ORDER BY procedure.proname, arguments
    `);
  const triggers = await client.query(`
      SELECT
        event_object_schema AS schema,
        event_object_table AS table,
        trigger_name AS name,
        action_timing,
        event_manipulation,
        action_statement
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
      ORDER BY event_object_table, trigger_name, event_manipulation
    `);
  const policies = await client.query(`
      SELECT
        schemaname AS schema,
        tablename AS table,
        policyname AS name,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE schemaname IN ('public', 'storage')
      ORDER BY schemaname, tablename, policyname
    `);
  const grants = await client.query(`
      SELECT
        table_schema AS schema,
        table_name AS table,
        grantee,
        privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema IN ('public', 'auth', 'storage')
      ORDER BY table_schema, table_name, grantee, privilege_type
    `);
  const sequences = await client.query(`
      SELECT
        sequence_schema AS schema,
        sequence_name AS name,
        data_type,
        start_value,
        minimum_value,
        maximum_value,
        increment
      FROM information_schema.sequences
      WHERE sequence_schema IN ('public', 'auth', 'storage')
      ORDER BY sequence_schema, sequence_name
    `);
  const cronAccess = await client.query(`
      SELECT
        to_regclass('cron.job') IS NOT NULL AS exists,
        CASE
          WHEN to_regclass('cron.job') IS NULL THEN false
          ELSE has_table_privilege(current_user, 'cron.job', 'SELECT')
        END AS readable
    `);
  const countedTables = await tableCounts(
    tables.rows.map((row) => ({
      name: row.name,
      schema: row.schema,
      totalBytes: Number(row.total_bytes),
    })),
  );
  const cronJobs =
    cronAccess.rows[0]?.exists && cronAccess.rows[0]?.readable
      ? (
          await client.query(`
            SELECT
              jobid,
              schedule,
              command,
              database,
              username,
              active,
              jobname
            FROM cron.job
            ORDER BY jobid
          `)
        ).rows
      : [];
  const inventory = {
    capturedAt: new Date().toISOString(),
    columns: columns.rows,
    cron: {
      accessible: Boolean(cronAccess.rows[0]?.readable),
      jobs: cronJobs,
    },
    extensions: extensions.rows,
    foreignKeys: foreignKeys.rows,
    functions: functions.rows,
    grants: grants.rows,
    indexes: indexes.rows,
    policies: policies.rows,
    sequences: sequences.rows,
    database: {
      databaseVersion: version.rows[0]?.version ?? null,
      label: databaseLabel,
      schemas: [...new Set(countedTables.map((table) => table.schema))].sort(),
    },
    tables: countedTables,
    triggers: triggers.rows,
  };
  const signatureEvidence = {
    ...inventory,
    capturedAt: undefined,
    database: {
      ...inventory.database,
      label: undefined,
    },
  };
  const signature = createHash("sha256")
    .update(JSON.stringify(signatureEvidence))
    .digest("hex");
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(
    outputPath,
    JSON.stringify({ ...inventory, signature }, null, 2),
    { mode: 0o600 },
  );
  await client.query("COMMIT");
  process.stdout.write(
    `${JSON.stringify({
      functionCount: inventory.functions.length,
      outputPath,
      policyCount: inventory.policies.length,
      signature,
      tableCount: inventory.tables.length,
      triggerCount: inventory.triggers.length,
    })}\n`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
