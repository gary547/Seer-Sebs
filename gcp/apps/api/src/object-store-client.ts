import { HttpError } from "../../../packages/runtime/src/http.js";

export interface ObjectStore {
  assertReady(): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer): Promise<void>;
}

export class ObjectStoreClient implements ObjectStore {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
  ) {}

  async assertReady(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/readyz`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`Object store readiness failed with status ${response.status}.`);
    }
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/objects/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
      {
        headers: {
          authorization: `Bearer ${this.internalToken}`,
        },
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Object store delete failed with status ${response.status}.`);
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/objects/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
      {
        body,
        headers: {
          authorization: `Bearer ${this.internalToken}`,
          "content-type": "application/octet-stream",
        },
        method: "PUT",
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Object store write failed with status ${response.status}.`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/objects/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
      {
        headers: {
          authorization: `Bearer ${this.internalToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (response.status === 404) {
      throw new HttpError(404, "asset_content_not_found", "Asset content not found.");
    }

    if (!response.ok) {
      throw new Error(`Object store read failed with status ${response.status}.`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
