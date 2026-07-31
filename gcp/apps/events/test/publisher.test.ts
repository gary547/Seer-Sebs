import { describe, expect, it, vi } from "vitest";

import { PubSubEventPublisher } from "../src/publisher.js";

describe("Pub/Sub event publisher", () => {
  it("publishes a self-describing event with metadata credentials", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messageIds: ["message-1"] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    const fetchImplementation = fetchMock as unknown as typeof fetch;
    const tokenProvider = {
      getAccessToken: vi.fn(async () => "metadata-token"),
    };
    const publisher = new PubSubEventPublisher(
      "seer-staging-12345",
      "seer-pipeline-events",
      tokenProvider,
      fetchImplementation,
    );

    await publisher.publish({
      aggregateId: "5f3c3d03-c23f-49c8-a141-aabe62f250f7",
      eventId: "d74a5920-5720-4824-909c-a17bf68eebaa",
      eventType: "pipeline.stage.succeeded",
      payload: { stageId: "intake" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://pubsub.googleapis.com/v1/projects/seer-staging-12345/topics/seer-pipeline-events:publish",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer metadata-token",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].attributes).toEqual({
      aggregate_id: "5f3c3d03-c23f-49c8-a141-aabe62f250f7",
      event_id: "d74a5920-5720-4824-909c-a17bf68eebaa",
      event_type: "pipeline.stage.succeeded",
    });
    expect(
      JSON.parse(Buffer.from(body.messages[0].data, "base64").toString("utf8")),
    ).toEqual({
      aggregateId: "5f3c3d03-c23f-49c8-a141-aabe62f250f7",
      eventId: "d74a5920-5720-4824-909c-a17bf68eebaa",
      eventType: "pipeline.stage.succeeded",
      payload: { stageId: "intake" },
    });
  });

  it("fails closed when Pub/Sub does not acknowledge a message", async () => {
    const publisher = new PubSubEventPublisher(
      "seer-staging-12345",
      "seer-pipeline-events",
      { getAccessToken: vi.fn(async () => "metadata-token") },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ messageIds: [] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ) as unknown as typeof fetch,
    );

    await expect(
      publisher.publish({
        aggregateId: "aggregate",
        eventId: "event",
        eventType: "type",
        payload: {},
      }),
    ).rejects.toThrow("Pub/Sub publish returned no message ID");
  });
});
