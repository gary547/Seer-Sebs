import { HttpError } from "../../../packages/runtime/src/http.js";
import {
  MetadataAccessTokenProvider,
  type AccessTokenProvider,
} from "../../../packages/runtime/src/google-auth.js";
import type { ObjectStore } from "./object-store-client.js";

export { MetadataAccessTokenProvider };

export class GcsObjectStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly tokenProvider: AccessTokenProvider = new MetadataAccessTokenProvider(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
      throw new Error("GCS bucket name is invalid.");
    }
  }

  private async authorization(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
    };
  }

  async assertReady(): Promise<void> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}?fields=name`,
      {
        headers: await this.authorization(),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Cloud Storage readiness failed with status ${response.status}.`);
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`,
      {
        body: new Uint8Array(body),
        headers: {
          ...(await this.authorization()),
          "content-type": "application/octet-stream",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Cloud Storage write failed with status ${response.status}.`);
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      {
        headers: await this.authorization(),
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Cloud Storage delete failed with status ${response.status}.`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.fetchImplementation(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?alt=media`,
      {
        headers: await this.authorization(),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      throw new HttpError(404, "asset_content_not_found", "Asset content not found.");
    }
    if (!response.ok) {
      throw new Error(`Cloud Storage read failed with status ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
