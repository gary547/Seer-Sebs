import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { reconcileIdentityUsers } from "../../dist/gcp/packages/migration/src/identity-reconciliation.js";

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
if (!Array.isArray(source.users) || !Array.isArray(target.users)) {
  throw new Error("Identity exports must contain a users array.");
}
const report = {
  capturedAt: new Date().toISOString(),
  ...reconcileIdentityUsers(source.users, target.users),
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    matchedUsers: report.matchedUsers,
    outputPath,
    passed: report.passed,
    sourceUsers: report.sourceUsers,
    targetUsers: report.targetUsers,
  }),
);
if (!report.passed) process.exitCode = 1;
