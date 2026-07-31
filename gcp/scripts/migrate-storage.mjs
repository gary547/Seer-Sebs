import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { MetadataAccessTokenProvider } from "../../dist/gcp/packages/runtime/src/google-auth.js";
import {
  buildGcsMultipartUpload,
  sourceObjectUrl,
  sourceStorageHeaders,
  targetBucket,
  targetObjectMatches,
} from "../../dist/gcp/packages/migration/src/storage-transfer.js";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in apply mode.`);
  return value;
}

function contentType(object) {
  const value = object.metadata?.mimetype ?? object.metadata?.contentType;
  return typeof value === "string" && value
    ? value
    : "application/octet-stream";
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function withRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await wait(250 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${label} failed after five attempts.`, { cause: lastError });
}

async function readCheckpoint(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed?.version !== 1 ||
      !parsed.completed ||
      typeof parsed.completed !== "object"
    ) {
      throw new Error("Storage migration checkpoint is invalid.");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { completed: {}, updatedAt: new Date().toISOString(), version: 1 };
    }
    throw error;
  }
}

async function writeCheckpoint(path, checkpoint) {
  const temporary = `${path}.tmp`;
  checkpoint.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

const manifestPath = resolve(
  argument("--manifest", "migration-evidence/source-manifests/storage-manifest.json"),
);
const checkpointPath = resolve(
  argument("--checkpoint", "migration-evidence/storage-transfer-checkpoint.json"),
);
const apply = process.argv.includes("--apply");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.objects)) {
  throw new Error("Storage manifest contains no object list.");
}
const plannedBytes = manifest.objects.reduce(
  (sum, object) => sum + Number(object.recordedBytes ?? 0),
  0,
);
if (!apply) {
  console.log(
    JSON.stringify({
      apply: false,
      manifestPath,
      plannedBytes,
      plannedObjects: manifest.objects.length,
    }),
  );
  process.exit(0);
}

const sourceUrl = requiredEnvironment("SEER_SOURCE_SUPABASE_URL");
const sourceServiceKey = requiredEnvironment("SEER_SOURCE_SERVICE_ROLE_KEY");
const targets = {
  assets: requiredEnvironment("SEER_TARGET_GCS_ASSETS_BUCKET"),
  exports: requiredEnvironment("SEER_TARGET_GCS_EXPORTS_BUCKET"),
};
const staticAccessToken = process.env.SEER_GCP_ACCESS_TOKEN;
const metadataTokenProvider = new MetadataAccessTokenProvider();
const accessToken = async () =>
  staticAccessToken ?? metadataTokenProvider.getAccessToken();
const checkpoint = await readCheckpoint(checkpointPath);

for (const object of manifest.objects) {
  const key = `${object.bucketId}/${object.name}`;
  if (checkpoint.completed[key]?.status === "verified") continue;
  const sourceResponse = await withRetry(
    async () => {
      const response = await fetch(
        sourceObjectUrl(sourceUrl, object.bucketId, object.name),
        {
          headers: sourceStorageHeaders(sourceServiceKey),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Source object download returned ${response.status}.`);
      }
      return response;
    },
    `Source download for ${key}`,
  );
  const content = Buffer.from(await sourceResponse.arrayBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const bucket = targetBucket(object.bucketId, targets);
  const transferObject = {
    bucketId: object.bucketId,
    contentType: contentType(object),
    name: object.name,
    sourceId: object.id,
  };
  const upload = buildGcsMultipartUpload(transferObject, content, sha256);
  const uploadUrl =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    "?uploadType=multipart&ifGenerationMatch=0";
  const uploadResponse = await withRetry(
    async () => {
      const response = await fetch(uploadUrl, {
        body: new Uint8Array(upload.body),
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": upload.contentType,
        },
        method: "POST",
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status !== 412 && !response.ok) {
        throw new Error(`Target object upload returned ${response.status}.`);
      }
      return response;
    },
    `Target upload for ${key}`,
  );
  let targetMetadata;
  if (uploadResponse.status === 412) {
    const metadataResponse = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object.name)}`,
      {
        headers: { authorization: `Bearer ${await accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!metadataResponse.ok) {
      throw new Error(`Existing target metadata returned ${metadataResponse.status}.`);
    }
    targetMetadata = await metadataResponse.json();
  } else {
    targetMetadata = await uploadResponse.json();
  }
  if (!targetObjectMatches(targetMetadata, content.length, sha256)) {
    throw new Error(`Target object did not reconcile for ${key}.`);
  }
  checkpoint.completed[key] = {
    bytes: content.length,
    sha256,
    status: "verified",
    targetBucket: bucket,
    targetGeneration: targetMetadata.generation ?? null,
  };
  await writeCheckpoint(checkpointPath, checkpoint);
}

const completed = Object.values(checkpoint.completed);
console.log(
  JSON.stringify({
    apply: true,
    completedBytes: completed.reduce(
      (sum, object) => sum + Number(object.bytes ?? 0),
      0,
    ),
    completedObjects: completed.length,
    checkpointPath,
  }),
);
