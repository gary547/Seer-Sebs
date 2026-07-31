import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  MetadataAccessTokenProvider,
  type AccessTokenProvider,
} from "../../../packages/runtime/src/google-auth.js";

export interface PipelineEvent {
  aggregateId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}

export interface EventPublisher {
  publish(event: PipelineEvent): Promise<void>;
}

export class DatabaseEventPublisher implements EventPublisher {
  constructor(private readonly pool: DatabasePool) {}

  async publish(event: PipelineEvent): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO event_deliveries (
          event_id,
          event_type,
          aggregate_id,
          payload
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [
        event.eventId,
        event.eventType,
        event.aggregateId,
        JSON.stringify(event.payload),
      ],
    );
  }
}

export class PubSubEventPublisher implements EventPublisher {
  constructor(
    private readonly projectId: string,
    private readonly topicId: string,
    private readonly tokenProvider: AccessTokenProvider = new MetadataAccessTokenProvider(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
      throw new Error("Pub/Sub project ID is invalid.");
    }
    if (!/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(topicId)) {
      throw new Error("Pub/Sub topic ID is invalid.");
    }
  }

  async publish(event: PipelineEvent): Promise<void> {
    const encodedData = Buffer.from(
      JSON.stringify({
        aggregateId: event.aggregateId,
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
      }),
    ).toString("base64");
    const response = await this.fetchImplementation(
      `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/topics/${encodeURIComponent(this.topicId)}:publish`,
      {
        body: JSON.stringify({
          messages: [
            {
              attributes: {
                aggregate_id: event.aggregateId,
                event_id: event.eventId,
                event_type: event.eventType,
              },
              data: encodedData,
            },
          ],
        }),
        headers: {
          authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1_000);
      throw new Error(
        `Pub/Sub publish failed with status ${response.status}: ${body}`,
      );
    }

    const result = (await response.json()) as { messageIds?: unknown };
    if (
      !Array.isArray(result.messageIds) ||
      typeof result.messageIds[0] !== "string" ||
      !result.messageIds[0]
    ) {
      throw new Error("Pub/Sub publish returned no message ID.");
    }
  }
}
