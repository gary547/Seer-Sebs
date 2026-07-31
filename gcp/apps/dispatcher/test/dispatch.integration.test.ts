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
