import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createObjectStoreServer } from "../src/server.js";

let baseUrl = "";
let dataDirectory = "";
let server: ReturnType<typeof createObjectStoreServer>;

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "seer-object-store-"));
  server = createObjectStoreServer({
    dataDirectory,
    internalToken: "integration-token",
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  await rm(dataDirectory, { force: true, recursive: true });
});

describe("seer-object-store integration", () => {
  it("persists and retrieves authenticated objects", async () => {
    const content = Buffer.from("durable object content");
    const putResponse = await fetch(`${baseUrl}/objects/assets/example.png`, {
      body: content,
      headers: {
        authorization: "Bearer integration-token",
      },
      method: "PUT",
    });

    expect(putResponse.status).toBe(201);
    await expect(readFile(join(dataDirectory, "assets/example.png"))).resolves.toEqual(content);

    const getResponse = await fetch(`${baseUrl}/objects/assets/example.png`, {
      headers: {
        authorization: "Bearer integration-token",
      },
    });

    expect(getResponse.status).toBe(200);
    expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(content);

    const deleteResponse = await fetch(`${baseUrl}/objects/assets/example.png`, {
      headers: {
        authorization: "Bearer integration-token",
      },
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const deletedResponse = await fetch(`${baseUrl}/objects/assets/example.png`, {
      headers: {
        authorization: "Bearer integration-token",
      },
    });
    expect(deletedResponse.status).toBe(404);
  });

  it("rejects path traversal and missing credentials", async () => {
    const unauthorized = await fetch(`${baseUrl}/objects/assets/example`);
    const traversal = await fetch(`${baseUrl}/objects/%2e%2e%2fescape`, {
      headers: {
        authorization: "Bearer integration-token",
      },
    });

    expect(unauthorized.status).toBe(401);
    expect(traversal.status).toBe(400);
  });
});
