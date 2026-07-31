import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { buildDatabaseArchivePlan } from "../../dist/gcp/packages/migration/src/database-archive-plan.js";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const inventoryPath = resolve(requiredArgument("--source"));
const catalogPath = resolve(
  argument("--catalog", "gcp/migration/source-table-catalog.json"),
);
const outputPath = resolve(
  argument("--output", "migration-evidence/database-archive-plan.json"),
);
const [inventory, catalog] = await Promise.all([
  readFile(inventoryPath, "utf8").then(JSON.parse),
  readFile(catalogPath, "utf8").then(JSON.parse),
]);
const plan = buildDatabaseArchivePlan(
  catalog,
  inventory,
  process.argv.includes("--approve-archive"),
);
const bytes = `${JSON.stringify(plan, null, 2)}\n`;
await writeFile(outputPath, bytes, { mode: 0o600 });
console.log(
  JSON.stringify({
    approved: plan.approved,
    outputPath,
    planSha256: createHash("sha256").update(bytes).digest("hex"),
    tables: plan.tables.length,
  }),
);
