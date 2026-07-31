import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { runDispatcher } from "../src/dispatcher.js";

describe("dispatcher loop recovery", () => {
  it("continues after a transient database error", async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("WITH candidate")) {
          controller.abort();
        }

        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("database restarting"))
        .mockResolvedValue({ rowCount: 0, rows: [] }),
    } as unknown as DatabasePool;

    await runDispatcher(
      {
        internalToken: "integration-token",
        onLoopError: (error) => errors.push(error),
        pollMilliseconds: 1,
        pool,
        workerUrl: "http://127.0.0.1:9",
      },
      controller.signal,
    );

    expect(errors).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(2);
  });
});
