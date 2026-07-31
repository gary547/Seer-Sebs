import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { buildDatabaseReconciliationMap } from "../../dist/gcp/packages/migration/src/database-reconciliation.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

const sourcePath = argument("--source");
const targetPath = argument("--target");
const outputPath = argument("--output");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const target = JSON.parse(await readFile(targetPath, "utf8"));
const map = buildDatabaseReconciliationMap(source, target);
if (process.argv.includes("--approve-identical")) {
  if (!source.signature || source.signature !== target.signature) {
    throw new Error(
      "--approve-identical is only valid when both inventory signatures match.",
    );
  }
  map.approved = true;
}
await writeFile(outputPath, `${JSON.stringify(map, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    mappedSequences: map.sequences.length,
    mappedTables: map.tables.length,
    missingTargetTables: map.missingTargetTables.length,
    outputPath,
  }),
);
