import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { ObjectStore } from "./object-store-client.js";

const MAXIMUM_ASSET_BYTES = 5 * 1_024 * 1_024;

interface AssetRow {
  content_type: string;
  created_at: Date;
  file_name: string;
  id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
}

interface AssetRequest {
  contentBase64: string;
  contentType: string;
  fileName: string;
}

function assetRequest(body: unknown): AssetRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }

  const record = body as Record<string, unknown>;

  return {
    contentBase64: requireString(
      record.contentBase64,
      "contentBase64",
      Math.ceil((MAXIMUM_ASSET_BYTES * 4) / 3) + 4,
    ),
    contentType: requireString(record.contentType, "contentType", 128),
    fileName: requireString(record.fileName, "fileName", 255),
  };
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(400, "invalid_base64", "contentBase64 is invalid.");
  }

  const content = Buffer.from(value, "base64");

  if (content.length > MAXIMUM_ASSET_BYTES) {
    throw new HttpError(413, "asset_too_large", "The asset is too large.");
  }

  return content;
}

function publicAsset(row: AssetRow): Record<string, unknown> {
  return {
    contentType: row.content_type,
    createdAt: row.created_at.toISOString(),
    fileName: row.file_name,
    id: row.id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  };
}

export async function createAsset(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const request = assetRequest(body);
  const content = decodeBase64(request.contentBase64);
  const id = randomUUID();
  const objectKey = `assets/${user.id}/${id}`;
  const sha256 = createHash("sha256").update(content).digest("hex");

  await objectStore.put(objectKey, content);

  const result = await pool.query<AssetRow>(
    `
      INSERT INTO assets (
        id,
        user_id,
        object_key,
        file_name,
        content_type,
        size_bytes,
        sha256
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, object_key, file_name, content_type, size_bytes, sha256, created_at
    `,
    [
      id,
      user.id,
      objectKey,
      request.fileName,
      request.contentType,
      content.length,
      sha256,
    ],
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Asset insert did not return a row.");
  }

  return publicAsset(row);
}

export async function getAsset(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await pool.query<AssetRow>(
    `
      SELECT id, object_key, file_name, content_type, size_bytes, sha256, created_at
      FROM assets
      WHERE id = $1
        AND user_id = $2
    `,
    [id, user.id],
  );
  const row = result.rows[0];

  if (!row) {
    throw new HttpError(404, "asset_not_found", "Asset not found.");
  }

  const content = await objectStore.get(row.object_key);

  return {
    ...publicAsset(row),
    contentBase64: content.toString("base64"),
  };
}
