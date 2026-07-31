import { randomUUID } from "node:crypto";

export interface StorageTargets {
  assets: string;
  exports: string;
}

export interface TransferObject {
  bucketId: string;
  contentType: string;
  name: string;
  sourceId: string;
}

export function sourceStorageHeaders(
  serviceRoleKey: string,
): { apikey: string; authorization: string } {
  const key = serviceRoleKey.trim();
  if (!key) throw new Error("Source storage service role key is required.");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
  };
}

function encodedPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function sourceObjectUrl(
  sourceUrl: string,
  bucketId: string,
  objectName: string,
): string {
  const origin = new URL(sourceUrl);
  if (origin.protocol !== "https:") {
    throw new Error("Source storage URL must use HTTPS.");
  }
  if (!bucketId || !objectName || objectName.startsWith("/")) {
    throw new Error("Source storage path is invalid.");
  }
  return `${origin.origin}/storage/v1/object/authenticated/${encodeURIComponent(bucketId)}/${encodedPath(objectName)}`;
}

export function targetBucket(
  sourceBucket: string,
  targets: StorageTargets,
): string {
  switch (sourceBucket) {
    case "client-logos":
      return targets.assets;
    case "slide-exports":
      return targets.exports;
    default:
      throw new Error(`Unexpected source storage bucket: ${sourceBucket}.`);
  }
}

export function buildGcsMultipartUpload(
  object: TransferObject,
  content: Buffer,
  sha256: string,
  boundary = `seer-${randomUUID()}`,
): { body: Buffer; contentType: string } {
  if (!/^[a-zA-Z0-9-]+$/.test(boundary)) {
    throw new Error("Multipart boundary is invalid.");
  }
  const metadata = JSON.stringify({
    contentType: object.contentType,
    metadata: {
      seer_source_bucket: object.bucketId,
      seer_source_id: object.sourceId,
      seer_source_sha256: sha256,
    },
    name: object.name,
  });
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: ${object.contentType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

export function targetObjectMatches(
  metadata: unknown,
  expectedSize: number,
  expectedSha256: string,
): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as {
    metadata?: Record<string, unknown>;
    size?: unknown;
  };
  return (
    String(record.size ?? "") === String(expectedSize) &&
    record.metadata?.seer_source_sha256 === expectedSha256
  );
}
