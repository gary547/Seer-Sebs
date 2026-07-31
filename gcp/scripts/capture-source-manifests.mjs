import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import pg from "pg";

import {
  buildIdentityArtifacts,
  buildStorageManifest,
} from "../../dist/gcp/packages/migration/src/source-manifests.js";

const { Client } = pg;
const databaseUrl = process.env.SEER_SOURCE_DATABASE_URL;
if (!databaseUrl) throw new Error("SEER_SOURCE_DATABASE_URL is required.");

const outputIndex = process.argv.indexOf("--output-directory");
const outputDirectory = resolve(
  outputIndex >= 0 && process.argv[outputIndex + 1]
    ? process.argv[outputIndex + 1]
    : "migration-evidence/source-manifests",
);

const client = new Client({
  connectionString: databaseUrl,
  statement_timeout: 120_000,
});

function valueExpression(columns, name, fallback, cast = "") {
  return columns.has(name) ? `${name}${cast} AS ${name}` : `${fallback} AS ${name}`;
}

async function columns(schema, table) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    [schema, table],
  );
  return new Set(result.rows.map((row) => String(row.column_name)));
}

function assertColumns(actual, required, relation) {
  const missing = required.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(`${relation} is missing required columns: ${missing.join(", ")}.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

await client.connect();
try {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const [userColumns, identityColumns, objectColumns, bucketColumns] =
    await Promise.all([
      columns("auth", "users"),
      columns("auth", "identities"),
      columns("storage", "objects"),
      columns("storage", "buckets"),
    ]);
  assertColumns(
    userColumns,
    ["id", "email", "encrypted_password"],
    "auth.users",
  );
  assertColumns(objectColumns, ["id", "bucket_id", "name"], "storage.objects");
  assertColumns(bucketColumns, ["id", "name"], "storage.buckets");

  const users = await client.query(`
    SELECT
      id::text AS id,
      email,
      encrypted_password,
      ${valueExpression(userColumns, "email_confirmed_at", "NULL::timestamptz")},
      ${valueExpression(userColumns, "created_at", "NULL::timestamptz")},
      ${valueExpression(userColumns, "last_sign_in_at", "NULL::timestamptz")},
      ${valueExpression(userColumns, "banned_until", "NULL::timestamptz")},
      ${valueExpression(userColumns, "raw_user_meta_data", "NULL::jsonb")}
    FROM auth.users
    ORDER BY id
  `);
  const identities =
    identityColumns.size > 0 &&
    identityColumns.has("user_id") &&
    identityColumns.has("provider")
      ? (
          await client.query(`
            SELECT
              user_id::text AS user_id,
              provider,
              ${valueExpression(identityColumns, "provider_id", "NULL::text")},
              ${valueExpression(identityColumns, "identity_data", "NULL::jsonb")}
            FROM auth.identities
            ORDER BY user_id, provider, provider_id
          `)
        ).rows
      : [];
  const storageObjects = await client.query(`
    SELECT
      id::text AS id,
      bucket_id,
      name,
      ${valueExpression(objectColumns, "owner", "NULL::uuid", "::text")},
      ${valueExpression(objectColumns, "created_at", "NULL::timestamptz")},
      ${valueExpression(objectColumns, "updated_at", "NULL::timestamptz")},
      ${valueExpression(objectColumns, "metadata", "NULL::jsonb")}
    FROM storage.objects
    WHERE bucket_id IN ('client-logos', 'slide-exports')
    ORDER BY bucket_id, name
  `);
  const storageBuckets = await client.query(`
    SELECT
      id,
      name,
      ${valueExpression(bucketColumns, "public", "false::boolean")},
      ${valueExpression(bucketColumns, "file_size_limit", "NULL::bigint", "::text")},
      ${valueExpression(bucketColumns, "allowed_mime_types", "NULL::text[]")}
    FROM storage.buckets
    WHERE id IN ('client-logos', 'slide-exports')
    ORDER BY id
  `);

  const identityArtifacts = buildIdentityArtifacts(
    users.rows.map((row) => ({
      bannedUntil: row.banned_until?.toISOString?.() ?? row.banned_until ?? null,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
      email: row.email,
      emailConfirmedAt:
        row.email_confirmed_at?.toISOString?.() ?? row.email_confirmed_at ?? null,
      encryptedPassword: row.encrypted_password,
      id: row.id,
      lastSignInAt:
        row.last_sign_in_at?.toISOString?.() ?? row.last_sign_in_at ?? null,
      rawUserMetadata: row.raw_user_meta_data,
    })),
    identities.map((row) => ({
      identityData: row.identity_data,
      provider: row.provider,
      providerId: row.provider_id,
      userId: row.user_id,
    })),
  );
  const storageManifest = buildStorageManifest(
    storageObjects.rows.map((row) => ({
      bucketId: row.bucket_id,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
      id: row.id,
      metadata: row.metadata,
      name: row.name,
      owner: row.owner,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at ?? null,
    })),
  );
  const capturedAt = new Date().toISOString();
  const outputs = {
    "firebase-auth-import.json": serialise(identityArtifacts.firebaseImport),
    "identity-reset-required.json": serialise({
      capturedAt,
      uids: identityArtifacts.resetRequiredUids,
    }),
    "identity-summary.json": serialise({
      capturedAt,
      ...identityArtifacts.summary,
    }),
    "storage-manifest.json": serialise({
      buckets: storageBuckets.rows,
      capturedAt,
      ...storageManifest,
    }),
    "uid-reconciliation.csv": identityArtifacts.reconciliationCsv,
  };
  const checksums = Object.entries(outputs)
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join("\n");

  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  await Promise.all([
    ...Object.entries(outputs).map(([name, content]) =>
      writeFile(`${outputDirectory}/${name}`, content, { mode: 0o600 }),
    ),
    writeFile(`${outputDirectory}/SHA256SUMS`, `${checksums}\n`, {
      mode: 0o600,
    }),
  ]);
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      identitySummary: identityArtifacts.summary,
      outputDirectory,
      storageBuckets: storageManifest.buckets,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
