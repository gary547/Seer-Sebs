import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import pg from "pg";

import {
  archiveInsertBatchStatement,
  archiveRowValues,
  copyRowValues,
  insertBatchStatement,
  normaliseDatabaseTransferPlan,
  quotedIdentifier,
  quotedRelation,
  transformCopyRows,
} from "../../dist/gcp/packages/migration/src/database-transfer.js";

const { Client } = pg;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in apply mode.`);
  return value;
}

async function checkpoint(path, planSha256) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value.version !== 1 ||
      value.planSha256 !== planSha256 ||
      !value.completedTables ||
      typeof value.completedTables !== "object"
    ) {
      throw new Error("The database transfer checkpoint is invalid.");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        completedSequences: {},
        completedTables: {},
        planSha256,
        updatedAt: new Date().toISOString(),
        version: 1,
      };
    }
    throw error;
  }
}

async function saveCheckpoint(path, value) {
  const temporary = `${path}.tmp`;
  value.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function columns(client, relation) {
  const [schema, table] = relation.split(".");
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
    `,
    [schema, table],
  );
  return new Set(result.rows.map((row) => String(row.column_name)));
}

async function nonNullableColumns(client, relation) {
  const [schema, table] = relation.split(".");
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND is_nullable = 'NO'
    `,
    [schema, table],
  );
  return new Set(result.rows.map((row) => String(row.column_name)));
}

async function assertTableContract(source, target, table) {
  const [sourceColumns, targetColumns] = await Promise.all([
    columns(source, table.source),
    columns(target, table.target),
  ]);
  if (sourceColumns.size === 0) {
    throw new Error(`Source table ${table.source} does not exist.`);
  }
  if (targetColumns.size === 0) {
    throw new Error(`Target table ${table.target} does not exist.`);
  }
  const requiredSourceColumns =
    table.mode === "copy"
      ? table.columns
          .map((column) => column.source)
          .filter((column) => column !== null)
      : table.keyColumns;
  for (const column of requiredSourceColumns) {
    if (!sourceColumns.has(column)) {
      throw new Error(
        `Source column ${table.source}.${column} does not exist.`,
      );
    }
  }
  const requiredTargetColumns =
    table.mode === "copy"
      ? table.columns.map((column) => column.target)
      : [
          "plan_entry_id",
          "source_table",
          "source_key",
          "source_row",
          "row_sha256",
        ];
  for (const column of requiredTargetColumns) {
    if (!targetColumns.has(column)) {
      throw new Error(
        `Target column ${table.target}.${column} does not exist.`,
      );
    }
  }
  if (table.mode === "copy") {
    const requiredTargets = await nonNullableColumns(target, table.target);
    const preflightSources = [
      ...new Set(
        table.columns
          .filter(
            (column) =>
              requiredTargets.has(column.target) &&
              column.source !== null &&
              !Object.hasOwn(column, "fallback") &&
              column.transform !== "json_array_or_empty",
          )
          .map((column) => column.source),
      ),
    ];
    if (preflightSources.length > 0) {
      const nullRows = await source.query(
        `SELECT count(*)::text AS count FROM ${quotedRelation(table.source)} WHERE ${preflightSources
          .map((column) => `${quotedIdentifier(column)} IS NULL`)
          .join(" OR ")}`,
      );
      const count = Number(nullRows.rows[0]?.count ?? "0");
      if (count > 0) {
        throw new Error(
          `${table.source} contains ${count} rows with null values required by ${table.target}.`,
        );
      }
    }
  }
}

async function rowCount(client, relation) {
  const result = await client.query(
    `SELECT count(*)::text AS count FROM ${quotedRelation(relation)}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function archivedRowCount(client, planEntryId) {
  const result = await client.query(
    `
      SELECT count(*)::text AS count
      FROM migration.source_rows
      WHERE plan_entry_id = $1
    `,
    [planEntryId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

const planPath = resolve(
  argument("--plan", "migration-evidence/database-transfer-plan.json"),
);
const checkpointPath = resolve(
  argument(
    "--checkpoint",
    "migration-evidence/database-transfer-checkpoint.json",
  ),
);
const batchSize = Number(argument("--batch-size", "500"));
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
  throw new Error("--batch-size must be an integer between 1 and 2000.");
}
const planBytes = await readFile(planPath);
const plan = normaliseDatabaseTransferPlan(JSON.parse(planBytes.toString()));
const planSha256 = createHash("sha256").update(planBytes).digest("hex");
const apply = process.argv.includes("--apply");
if (!apply) {
  console.log(
    JSON.stringify({
      apply: false,
      mappedColumns: plan.tables.reduce(
        (total, table) => total + table.columns.length,
        0,
      ),
      archiveTables: plan.tables.filter((table) => table.mode === "archive_json")
        .length,
      copyTables: plan.tables.filter((table) => table.mode === "copy").length,
      planPath,
      planSha256,
      sequences: plan.sequences.length,
      tables: plan.tables.length,
    }),
  );
  process.exit(0);
}

const source = new Client({
  connectionString: requiredEnvironment("SEER_SOURCE_DATABASE_URL"),
  statement_timeout: 600_000,
});
const target = new Client({
  connectionString: requiredEnvironment("SEER_TARGET_DATABASE_URL"),
  statement_timeout: 600_000,
});
const state = await checkpoint(checkpointPath, planSha256);

await Promise.all([source.connect(), target.connect()]);
try {
  await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  for (let tableIndex = 0; tableIndex < plan.tables.length; tableIndex += 1) {
    const table = plan.tables[tableIndex];
    if (state.completedTables[table.id]?.status === "verified") continue;
    await assertTableContract(source, target, table);
    const sourceRows = await rowCount(source, table.source);
    const existingTargetRows =
      table.mode === "copy"
        ? await rowCount(target, table.target)
        : await archivedRowCount(target, table.id);
    if (existingTargetRows !== 0) {
      throw new Error(
        `Target entry ${table.id} is not empty and has no verified checkpoint.`,
      );
    }
    const cursor = `seer_transfer_${tableIndex}`;
    const selectColumns =
      table.mode === "copy"
        ? table.columns
            .filter((column) => column.source !== null)
            .map(
              (column) =>
                `${quotedIdentifier(column.source)} AS ${quotedIdentifier(column.target)}`,
            )
            .join(", ")
        : `to_jsonb(source_row) AS ${quotedIdentifier("source_row")}`;
    const sourceAlias =
      table.mode === "archive_json"
        ? ` AS ${quotedIdentifier("source_row")}`
        : "";
    const orderBy =
      table.mode === "archive_json"
        ? ` ORDER BY ${table.keyColumns.map(quotedIdentifier).join(", ")}`
        : "";
    await source.query(
      `DECLARE ${quotedIdentifier(cursor)} NO SCROLL CURSOR FOR SELECT ${selectColumns} FROM ${quotedRelation(table.source)}${sourceAlias}${orderBy}`,
    );
    await target.query("BEGIN");
    try {
      if (table.mode === "copy" && table.disableUserTriggers) {
        await target.query(
          `ALTER TABLE ${quotedRelation(table.target)} DISABLE TRIGGER USER`,
        );
      }
      let fetchedRows = 0;
      let insertedRows = 0;
      const transformedSourceRows = [];
      while (true) {
        const result = await source.query(
          `FETCH FORWARD ${batchSize} FROM ${quotedIdentifier(cursor)}`,
        );
        if (result.rows.length === 0) break;
        fetchedRows += result.rows.length;
        if (table.mode === "copy") {
          if (table.rowTransform) {
            transformedSourceRows.push(...result.rows);
          } else {
            const values = result.rows.flatMap((row) =>
              copyRowValues(table, row),
            );
            await target.query(
              insertBatchStatement(table, result.rows.length),
              values,
            );
            insertedRows += result.rows.length;
          }
        } else {
          const values = result.rows.flatMap((row) =>
            archiveRowValues(table, row.source_row),
          );
          await target.query(
            archiveInsertBatchStatement(result.rows.length),
            values,
          );
          insertedRows += result.rows.length;
        }
      }
      if (fetchedRows !== sourceRows) {
        throw new Error(
          `${table.source} returned ${fetchedRows} of ${sourceRows} rows.`,
        );
      }
      if (table.mode === "copy" && table.rowTransform) {
        const transformedRows = transformCopyRows(table, transformedSourceRows);
        for (let offset = 0; offset < transformedRows.length; offset += batchSize) {
          const batch = transformedRows.slice(offset, offset + batchSize);
          await target.query(
            insertBatchStatement(table, batch.length),
            batch.flat(),
          );
          insertedRows += batch.length;
        }
      }
      const targetRows =
        table.mode === "copy"
          ? await rowCount(target, table.target)
          : await archivedRowCount(target, table.id);
      if (targetRows !== insertedRows) {
        throw new Error(
          `${table.target} contains ${targetRows} rows after importing ${sourceRows} source rows into ${insertedRows} canonical rows.`,
        );
      }
      if (table.mode === "copy" && table.disableUserTriggers) {
        await target.query(
          `ALTER TABLE ${quotedRelation(table.target)} ENABLE TRIGGER USER`,
        );
      }
      await target.query("COMMIT");
      await source.query(`CLOSE ${quotedIdentifier(cursor)}`);
      state.completedTables[table.id] = {
        mode: table.mode,
        rowCount: targetRows,
        sourceRowCount: sourceRows,
        source: table.source,
        status: "verified",
      };
      await saveCheckpoint(checkpointPath, state);
    } catch (error) {
      await target.query("ROLLBACK").catch(() => undefined);
      await source
        .query(`CLOSE ${quotedIdentifier(cursor)}`)
        .catch(() => undefined);
      throw error;
    }
  }
  for (const sequence of plan.sequences) {
    if (state.completedSequences[sequence.target]?.status === "verified") {
      continue;
    }
    const sourceValue = await source.query(
      `SELECT last_value::text, is_called FROM ${quotedRelation(sequence.source)}`,
    );
    const lastValue = sourceValue.rows[0]?.last_value;
    const isCalled = sourceValue.rows[0]?.is_called;
    if (typeof lastValue !== "string" || typeof isCalled !== "boolean") {
      throw new Error(`Source sequence ${sequence.source} is invalid.`);
    }
    await target.query("SELECT setval($1::regclass, $2::bigint, $3::boolean)", [
      sequence.target,
      lastValue,
      isCalled,
    ]);
    state.completedSequences[sequence.target] = {
      isCalled,
      lastValue,
      source: sequence.source,
      status: "verified",
    };
    await saveCheckpoint(checkpointPath, state);
  }
  await source.query("COMMIT");
  console.log(
    JSON.stringify({
      apply: true,
      checkpointPath,
      completedSequences: Object.keys(state.completedSequences).length,
      completedTables: Object.keys(state.completedTables).length,
    }),
  );
} catch (error) {
  await source.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await Promise.all([source.end(), target.end()]);
}
