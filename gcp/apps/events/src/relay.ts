import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import {
  DatabaseEventPublisher,
  type EventPublisher,
  type PipelineEvent,
} from "./publisher.js";

interface EventRow {
  aggregate_id: string;
  event_id: string;
  event_type: string;
  id: string;
  payload: unknown;
}

async function claimNextEvent(pool: DatabasePool): Promise<(PipelineEvent & { id: string }) | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<EventRow>(
      `
        WITH candidate AS (
          SELECT id
          FROM outbox_events
          WHERE (
              state = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            )
            OR (
              state = 'processing'
              AND processing_started_at < now() - interval '5 minutes'
            )
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events AS event
        SET state = 'processing',
            attempts = event.attempts + 1,
            processing_started_at = now(),
            next_attempt_at = NULL,
            last_error = NULL
        FROM candidate
        WHERE event.id = candidate.id
        RETURNING
          event.id::text,
          event.event_id,
          event.event_type,
          event.aggregate_id,
          event.payload
      `,
    );
    const event = result.rows[0];

    if (!event) {
      return null;
    }

    return {
      aggregateId: event.aggregate_id,
      eventId: event.event_id,
      eventType: event.event_type,
      id: event.id,
      payload: event.payload,
    };
  });
}

async function markDelivered(pool: DatabasePool, eventId: string): Promise<void> {
  await pool.query(
    `
      UPDATE outbox_events
      SET state = 'delivered',
          delivered_at = now(),
          processing_started_at = NULL,
          next_attempt_at = NULL,
          last_error = NULL
      WHERE id = $1
        AND state = 'processing'
    `,
    [eventId],
  );
}

async function releaseFailed(
  pool: DatabasePool,
  eventId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `
      UPDATE outbox_events
      SET state = 'pending',
          processing_started_at = NULL,
          next_attempt_at =
            now() + least(interval '5 minutes', interval '1 second' * power(2, least(attempts, 8))),
          last_error = left($2, 2000)
      WHERE id = $1
        AND state = 'processing'
    `,
    [eventId, message],
  );
}

export async function relayNextEvent(
  pool: DatabasePool,
  publisher: EventPublisher = new DatabaseEventPublisher(pool),
): Promise<boolean> {
  const event = await claimNextEvent(pool);
  if (!event) {
    return false;
  }

  try {
    await publisher.publish(event);
    await markDelivered(pool, event.id);
    return true;
  } catch (error) {
    try {
      await releaseFailed(pool, event.id, error);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Event publication and retry release both failed.",
      );
    }
    throw error;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runEventRelay(
  pool: DatabasePool,
  pollMilliseconds: number,
  signal: AbortSignal,
  onLoopError: (error: unknown) => void = console.error,
  publisher: EventPublisher = new DatabaseEventPublisher(pool),
): Promise<void> {
  while (!signal.aborted) {
    try {
      const delivered = await relayNextEvent(pool, publisher);

      if (delivered) {
        continue;
      }
    } catch (error) {
      onLoopError(error);
    }

    await wait(pollMilliseconds, signal);
  }
}
