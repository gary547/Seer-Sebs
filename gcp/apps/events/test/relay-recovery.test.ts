import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import type { EventPublisher } from "../src/publisher.js";
import { relayNextEvent, runEventRelay } from "../src/relay.js";

describe("event relay loop recovery", () => {
  it("continues after a transient database error", async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("FROM outbox_events")) {
          controller.abort();
        }

        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error("database restarting"))
        .mockResolvedValue(client),
    } as unknown as DatabasePool;

    await runEventRelay(
      pool,
      1,
      controller.signal,
      (error) => errors.push(error),
    );

    expect(errors).toHaveLength(1);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("releases a claimed event with backoff when publication fails", async () => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("UPDATE outbox_events AS event")) {
          return {
            rowCount: 1,
            rows: [
              {
                aggregate_id: "aggregate",
                event_id: "event",
                event_type: "pipeline.stage.succeeded",
                id: "42",
                payload: { stageId: "intake" },
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as unknown as DatabasePool;
    const publisher = {
      publish: vi.fn(async () => {
        throw new Error("pubsub unavailable");
      }),
    } satisfies EventPublisher;

    await expect(relayNextEvent(pool, publisher)).rejects.toThrow(
      "pubsub unavailable",
    );

    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(String(vi.mocked(pool.query).mock.calls[0]?.[0])).toContain(
      "next_attempt_at",
    );
  });
});
