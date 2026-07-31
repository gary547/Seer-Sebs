import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";

import { API_SERVICE_NAME, createApiServer } from "../src/server.js";

const server = createApiServer();
let baseUrl = "";

beforeEach(async () => {
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
});

describe("seer-api integration", () => {
  it("returns a non-cacheable liveness response", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      environment: "local",
      revision: "local",
      service: API_SERVICE_NAME,
      status: "ok",
    });
  });

  it("rejects unsupported methods", async () => {
    const response = await fetch(`${baseUrl}/healthz`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "method_not_allowed",
        message: "Only GET is allowed for this endpoint.",
      },
    });
  });

  it("returns a structured not-found response", async () => {
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    });
  });

  it("allows configured browser origins and rejects unknown origins", async () => {
    const corsServer = createApiServer({
      allowedOrigins: ["https://seer.example.com"],
    });
    await new Promise<void>((resolve) => {
      corsServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = corsServer.address() as AddressInfo;
      const target = `http://127.0.0.1:${address.port}/v1/me`;
      const allowed = await fetch(target, {
        headers: {
          origin: "https://seer.example.com",
        },
        method: "OPTIONS",
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "https://seer.example.com",
      );

      const rejected = await fetch(target, {
        headers: {
          origin: "https://untrusted.example.com",
        },
        method: "OPTIONS",
      });
      expect(rejected.status).toBe(403);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: "origin_not_allowed" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        corsServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("allows the local frontend development and preview origins", async () => {
    for (const origin of [
      "http://127.0.0.1:4173",
      "http://127.0.0.1:8080",
      "http://localhost:4173",
      "http://localhost:8080",
    ]) {
      const response = await fetch(`${baseUrl}/v1/me`, {
        headers: { origin },
        method: "OPTIONS",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("does not expose local-only routes outside the local environment", async () => {
    const productionServer = createApiServer({ environment: "production" });
    await new Promise<void>((resolve) => {
      productionServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = productionServer.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/projects/00000000-0000-4000-8000-000000000001/local-provider-inputs`,
        { method: "PUT" },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "not_found",
          message: "Route not found.",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        productionServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("protects and dispatches scheduled URL monitor maintenance", async () => {
    const urlMonitorTick = vi.fn(async () => ({ checked: 2 }));
    const maintenanceServer = createApiServer({
      internalToken: "maintenance-token",
      pool: {} as DatabasePool,
      urlMonitorTick,
    });
    await new Promise<void>((resolve) => {
      maintenanceServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = maintenanceServer.address() as AddressInfo;
      const target =
        `http://127.0.0.1:${address.port}/internal/maintenance/url-monitor`;
      const rejected = await fetch(target, {
        body: JSON.stringify({ operation: "tick" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(target, {
        body: JSON.stringify({ operation: "tick" }),
        headers: {
          "content-type": "application/json",
          "x-seer-internal-token": "maintenance-token",
        },
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ checked: 2 });
      expect(urlMonitorTick).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        maintenanceServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
