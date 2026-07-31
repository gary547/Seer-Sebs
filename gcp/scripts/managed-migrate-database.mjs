import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { GcsMigrationEvidenceStore } from "../../dist/gcp/packages/migration/src/managed-evidence.js";
import { MetadataAccessTokenProvider } from "../../dist/gcp/packages/runtime/src/google-auth.js";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function runTransfer(planPath, checkpointPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "/app/gcp/scripts/migrate-database.mjs",
        "--plan",
        planPath,
        "--checkpoint",
        checkpointPath,
        "--batch-size",
        process.env.SEER_DATABASE_TRANSFER_BATCH_SIZE ?? "500",
        "--apply",
      ],
      {
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Database transfer exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

const bucket = requiredEnvironment("SEER_MIGRATION_EVIDENCE_BUCKET");
const planObject = requiredEnvironment("SEER_DATABASE_TRANSFER_PLAN_OBJECT");
const checkpointObject = requiredEnvironment(
  "SEER_DATABASE_TRANSFER_CHECKPOINT_OBJECT",
);
const lockObject = requiredEnvironment("SEER_DATABASE_TRANSFER_LOCK_OBJECT");
const expectedPlanSha256 = requiredEnvironment(
  "SEER_DATABASE_TRANSFER_PLAN_SHA256",
);
if (!/^[0-9a-f]{64}$/.test(expectedPlanSha256)) {
  throw new Error("SEER_DATABASE_TRANSFER_PLAN_SHA256 is invalid.");
}
requiredEnvironment("SEER_SOURCE_DATABASE_URL");
requiredEnvironment("SEER_TARGET_DATABASE_URL");

const execution = process.env.CLOUD_RUN_EXECUTION ?? "local-managed-execution";
const store = new GcsMigrationEvidenceStore(
  bucket,
  new MetadataAccessTokenProvider(),
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "seer-db-transfer-"));
const planPath = join(temporaryDirectory, "plan.json");
const checkpointPath = join(temporaryDirectory, "checkpoint.json");
let lockGeneration = null;
let transferError = null;

try {
  const plan = await store.get(planObject);
  if (!plan) throw new Error("The approved database transfer plan is missing.");
  const actualPlanSha256 = createHash("sha256").update(plan).digest("hex");
  if (actualPlanSha256 !== expectedPlanSha256) {
    throw new Error("The database transfer plan checksum does not match.");
  }
  const checkpoint = await store.get(checkpointObject);
  await writeFile(planPath, plan, { mode: 0o600 });
  if (checkpoint) {
    await writeFile(checkpointPath, checkpoint, { mode: 0o600 });
  }
  lockGeneration = await store.acquireLock(lockObject, execution);
  await runTransfer(planPath, checkpointPath);
} catch (error) {
  transferError = error;
} finally {
  let persistenceError = null;
  if (lockGeneration) {
    try {
      const checkpoint = await readFile(checkpointPath);
      await store.put(checkpointObject, checkpoint);
    } catch (error) {
      if (error?.code !== "ENOENT") persistenceError = error;
    }
    try {
      await store.releaseLock(lockObject, lockGeneration);
    } catch (error) {
      persistenceError ??= error;
    }
  }
  await rm(temporaryDirectory, { force: true, recursive: true });
  if (transferError) throw transferError;
  if (persistenceError) throw persistenceError;
}

console.log(
  JSON.stringify({
    checkpointObject,
    execution,
    planObject,
    status: "completed",
  }),
);
