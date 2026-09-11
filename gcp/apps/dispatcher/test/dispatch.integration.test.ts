import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { dispatchTask } from "../src/dispatcher.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
});

describe("Cloud Run dispatcher delivery", () => {
  it("continues checkpointed work without completing the task or exhausting delivery retries", async () => {
    const server = createServer((_request, response) => {
      response.end(JSON.stringify({ status: "continuing", runId: "run", stageId: "detox" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rowCount: 1, rows: [] }));
    await dispatchTask({
      internalToken: "internal-service-token", pollMilliseconds: 100,
      pool: { query } as unknown as DatabasePool,
      workerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }, { attempt_count: 5, id: "task", run_id: "run", stage_id: "detox" });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0]).toContain("SET state = 'ready'");
    expect(query.mock.calls[0]![0]).toContain("attempt_count = 0");
    expect(query.mock.calls[0]![0]).not.toContain("completed_at");
    expect(query.mock.calls[0]![1]).toEqual(["task"]);
  });

  it.each([400, 401, 403, 424])("does not multiply provider attempts after a terminal %i response", async (status) => {
    const server = createServer((_request, response) => {
      response.statusCode = status;
      response.end(JSON.stringify({ error: { message: "GLM 5.3 Flash did not return complete, valid results after 30 attempts." } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rowCount: 1, rows: [] }));
    const client = { query, release: vi.fn() };
    await dispatchTask({
      internalToken: "internal-service-token", pollMilliseconds: 100,
      pool: { query, connect: async () => client } as unknown as DatabasePool,
      workerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }, { attempt_count: 1, id: "task", run_id: "run", stage_id: "site-architecture" });
    expect(query.mock.calls.some(([sql]) => sql.includes("SET state = 'ready'"))).toBe(false);
    const stageFailure = query.mock.calls.find(([sql]) => sql.includes("UPDATE pipeline_stage_runs"));
    expect(stageFailure?.[0]).toContain("'message', CASE WHEN stage_id = $2 THEN $3::text");
    expect(stageFailure?.[0]).toContain("pipeline_blocked");
    expect(stageFailure?.[1]?.[2]).toContain("after 30 attempts");
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE pipeline_runs"))).toBe(true);
  });

  it("uses a platform identity token and a separate internal service token", async () => {
    let authorization = "";
    let internalToken = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      internalToken = String(request.headers["x-seer-internal-token"] ?? "");
      response.statusCode = 200;
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const identityToken = vi.fn(async () => "cloud-run-identity-token");

    await dispatchTask(
      {
        identityToken,
        internalToken: "internal-service-token",
        pollMilliseconds: 100,
        pool: { query } as unknown as DatabasePool,
        workerAudience: "https://seer-worker.example",
        workerUrl: `http://127.0.0.1:${address.port}`,
      },
      {
        attempt_count: 1,
        id: "1",
        run_id: "00000000-0000-4000-8000-000000000001",
        stage_id: "intake",
      },
    );

    expect(identityToken).toHaveBeenCalledWith("https://seer-worker.example");
    expect(authorization).toBe("Bearer cloud-run-identity-token");
    expect(internalToken).toBe("internal-service-token");
    expect(query).toHaveBeenCalledOnce();
  });
});
