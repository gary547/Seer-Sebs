import type { AccessTokenProvider } from "../../runtime/src/google-auth.js";

function bucketName(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(value)) {
    throw new Error("Migration evidence bucket name is invalid.");
  }
  return value;
}

function objectName(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").includes("..") ||
    value.length > 1_024
  ) {
    throw new Error("Migration evidence object name is invalid.");
  }
  return value;
}

export class GcsMigrationEvidenceStore {
  private readonly bucket: string;

  constructor(
    bucket: string,
    private readonly tokenProvider: AccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.bucket = bucketName(bucket);
  }

  private async authorization(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName(key))}?alt=media`,
      {
        headers: await this.authorization(),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Migration evidence read failed with status ${response.status}.`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async put(key: string, body: Buffer): Promise<void> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName(key))}`,
      {
        body: new Uint8Array(body),
        headers: {
          ...(await this.authorization()),
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Migration evidence write failed with status ${response.status}.`,
      );
    }
  }

  async acquireLock(key: string, execution: string): Promise<string> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(objectName(key))}`,
      {
        body: JSON.stringify({
          acquiredAt: new Date().toISOString(),
          execution,
          version: 1,
        }),
        headers: {
          ...(await this.authorization()),
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 412) {
      throw new Error("Another database transfer execution holds the lock.");
    }
    if (!response.ok) {
      throw new Error(
        `Migration lock acquisition failed with status ${response.status}.`,
      );
    }
    const metadata = (await response.json()) as { generation?: unknown };
    if (
      typeof metadata.generation !== "string" ||
      !/^\d+$/.test(metadata.generation)
    ) {
      throw new Error("Migration lock response contains no valid generation.");
    }
    return metadata.generation;
  }

  async releaseLock(key: string, generation: string): Promise<void> {
    if (!/^\d+$/.test(generation)) {
      throw new Error("Migration lock generation is invalid.");
    }
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName(key))}?ifGenerationMatch=${generation}`,
      {
        headers: await this.authorization(),
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Migration lock release failed with status ${response.status}.`,
      );
    }
  }
}
