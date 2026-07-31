import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { buildDatabaseCanonicalPlan } from "../../dist/gcp/packages/migration/src/database-canonical-plan.js";

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

const sourceInventoryPath = resolve(requiredArgument("--source"));
const targetInventoryPath = resolve(requiredArgument("--target"));
const catalogPath = resolve(
  argument("--catalog", "gcp/migration/source-table-catalog.json"),
);
const rulesPath = resolve(
  argument("--rules", "gcp/migration/canonical-table-rules.json"),
);
const outputPath = resolve(
  argument("--output", "migration-evidence/database-canonical-plan.json"),
);
const [catalog, rules, sourceInventory, targetInventory] = await Promise.all([
  readFile(catalogPath, "utf8").then(JSON.parse),
  readFile(rulesPath, "utf8").then(JSON.parse),
  readFile(sourceInventoryPath, "utf8").then(JSON.parse),
  readFile(targetInventoryPath, "utf8").then(JSON.parse),
]);
const plan = buildDatabaseCanonicalPlan(
  catalog,
  rules,
  sourceInventory,
  targetInventory,
  process.argv.includes("--approve-canonical"),
);
const bytes = `${JSON.stringify(plan, null, 2)}\n`;
await writeFile(outputPath, bytes, { mode: 0o600 });
console.log(
  JSON.stringify({
    approved: plan.approved,
    mappedColumns: plan.tables.reduce(
      (total, table) => total + table.columns.length,
      0,
    ),
    outputPath,
    planSha256: createHash("sha256").update(bytes).digest("hex"),
    tables: plan.tables.length,
  }),
);
