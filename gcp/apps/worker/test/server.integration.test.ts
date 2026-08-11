import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkerServer } from "../src/server.js";

const processTask = vi.fn(async (): Promise<Record<string, unknown>> => ({
  status: "succeeded",
}));
const failRun = vi.fn(async () => ({
  status: "failed",
}));
const server = createWorkerServer({
  failRun,
  internalToken: "integration-token",
  processTask,
});
let baseUrl = "";

beforeEach(async () => {
  processTask.mockClear();
  failRun.mockClear();
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

describe("seer-worker integration", () => {
  it("rejects unauthenticated task delivery", async () => {
    const response = await fetch(`${baseUrl}/internal/tasks`, {
      body: JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
        stageId: "intake",
        taskId: "1",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(processTask).not.toHaveBeenCalled();
  });

  it("validates and dispatches an authenticated task", async () => {
    const response = await fetch(`${baseUrl}/internal/tasks`, {
      body: JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
        stageId: "intake",
        taskId: "1",
      }),
      headers: {
        authorization: "Bearer integration-token",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(processTask).toHaveBeenCalledWith({
      runId: "00000000-0000-4000-8000-000000000001",
      stageId: "intake",
      taskId: "1",
    });
  });

  it("returns a bounded acknowledgement instead of persisted stage output", async () => {
    processTask.mockResolvedValueOnce({
      output: {
        keywords: Array.from({ length: 10_000 }, (_, index) => ({
          keyword: `keyword-${index}`,
        })),
      },
      status: "succeeded",
    });

    const response = await fetch(`${baseUrl}/internal/tasks`, {
      body: JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
        stageId: "gsc-promotion",
        taskId: "1",
      }),
      headers: {
        authorization: "Bearer integration-token",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: "00000000-0000-4000-8000-000000000001",
      stageId: "gsc-promotion",
      status: "succeeded",
    });
    expect(Number(response.headers.get("content-length"))).toBeLessThan(256);
  });

  it("accepts a private Cloud Run delivery with the internal service header", async () => {
    const response = await fetch(`${baseUrl}/internal/tasks`, {
      body: JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
        stageId: "intake",
        taskId: "1",
      }),
      headers: {
        authorization: "Bearer cloud-run-identity-token",
        "content-type": "application/json",
        "x-seer-internal-token": "integration-token",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(processTask).toHaveBeenCalledOnce();
  });

  it("records a terminal workflow failure through the authenticated control route", async () => {
    const response = await fetch(`${baseUrl}/internal/failures`, {
      body: JSON.stringify({
        reason: "Provider delivery exhausted.",
        runId: "00000000-0000-4000-8000-000000000001",
        stageId: "serp-collection",
      }),
      headers: {
        authorization: "Bearer integration-token",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(failRun).toHaveBeenCalledWith({
      reason: "Provider delivery exhausted.",
      runId: "00000000-0000-4000-8000-000000000001",
      stageId: "serp-collection",
    });
  });
});
