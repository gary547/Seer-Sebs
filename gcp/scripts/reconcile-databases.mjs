import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import pg from "pg";

const { Client } = pg;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}.`);
  }
  return `"${value}"`;
}

function relation(value) {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error(`Invalid relation name: ${value}.`);
  return parts.map(identifier).join(".");
}

async function begin(client) {
  await client.connect();
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
}

async function relationEvidence(client, table, columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`${table} has no approved checksum columns.`);
  }
  const relationSql = relation(table);
  const values = columns.map((column) => `row_value.${identifier(column)}`).join(", ");
  const result = await client.query(`
    SELECT
      count(*)::text AS row_count,
      md5(
        COALESCE(
          string_agg(row_hash, '' ORDER BY row_hash),
          ''
        )
      ) AS row_checksum
    FROM (
      SELECT md5(jsonb_build_array(${values})::text) AS row_hash
      FROM ${relationSql} AS row_value
    ) AS hashed_rows
  `);
  return {
    rowChecksum: result.rows[0]?.row_checksum ?? null,
    rowCount: Number(result.rows[0]?.row_count ?? "0"),
  };
}

async function sequenceEvidence(client, sequence) {
  const result = await client.query(
    `SELECT last_value::text, is_called FROM ${relation(sequence)}`,
  );
  return {
    isCalled: Boolean(result.rows[0]?.is_called),
    lastValue: result.rows[0]?.last_value ?? null,
  };
}

const sourceUrl = process.env.SEER_SOURCE_DATABASE_URL;
const targetUrl = process.env.SEER_TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) {
  throw new Error(
    "SEER_SOURCE_DATABASE_URL and SEER_TARGET_DATABASE_URL are required.",
  );
}
const mapPath = argument("--map");
const outputPath = argument("--output");
const map = JSON.parse(await readFile(mapPath, "utf8"));
if (map.version !== 1 || map.approved !== true) {
  throw new Error("The reconciliation map must be version 1 and explicitly approved.");
}
if (map.missingTargetTables?.length > 0) {
  throw new Error("The approved map still contains missing target tables.");
}
const source = new Client({
  connectionString: sourceUrl,
  statement_timeout: 600_000,
});
const target = new Client({
  connectionString: targetUrl,
  statement_timeout: 600_000,
});

try {
  await Promise.all([begin(source), begin(target)]);
  const tableResults = [];
  for (const table of map.tables) {
    const [sourceEvidence, targetEvidence] = await Promise.all([
      relationEvidence(source, table.source, table.columns),
      relationEvidence(target, table.target, table.columns),
    ]);
    const countMatches =
      table.countMode === "equal" &&
      sourceEvidence.rowCount === targetEvidence.rowCount;
    const checksumMatches =
      table.checksumMode === "equal" &&
      sourceEvidence.rowChecksum === targetEvidence.rowChecksum;
    tableResults.push({
      checksumMatches,
      countMatches,
      passed: countMatches && checksumMatches,
      source: table.source,
      sourceEvidence,
      target: table.target,
      targetEvidence,
    });
  }
  const sequenceResults = [];
  for (const sequence of map.sequences) {
    const [sourceEvidence, targetEvidence] = await Promise.all([
      sequenceEvidence(source, sequence.source),
      sequenceEvidence(target, sequence.target),
    ]);
    sequenceResults.push({
      passed:
        sourceEvidence.lastValue === targetEvidence.lastValue &&
        sourceEvidence.isCalled === targetEvidence.isCalled,
      source: sequence.source,
      sourceEvidence,
      target: sequence.target,
      targetEvidence,
    });
  }
  await Promise.all([source.query("COMMIT"), target.query("COMMIT")]);
  const passed =
    tableResults.every((table) => table.passed) &&
    sequenceResults.every((sequence) => sequence.passed);
  const report = {
    capturedAt: new Date().toISOString(),
    passed,
    sequenceResults,
    tableResults,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      outputPath,
      passed,
      sequencesChecked: sequenceResults.length,
      tablesChecked: tableResults.length,
    }),
  );
  if (!passed) process.exitCode = 1;
} catch (error) {
  await Promise.all([
    source.query("ROLLBACK").catch(() => undefined),
    target.query("ROLLBACK").catch(() => undefined),
  ]);
  throw error;
} finally {
  await Promise.all([source.end(), target.end()]);
}
