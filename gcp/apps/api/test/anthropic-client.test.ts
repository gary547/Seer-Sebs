import { describe, expect, it, vi } from "vitest";

import { AnthropicClient } from "../src/anthropic-client.js";

describe("AnthropicClient", () => {
  it("sends an authenticated message request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ text: "Generated brief", type: "text" }],
        }),
        { status: 200 },
      ),
    );
    const client = new AnthropicClient("test-key", fetchImplementation);

    await expect(
      client.generate({
        messages: [{ content: "Build a brief", role: "user" }],
        system: "Return JSON.",
      }),
    ).resolves.toMatchObject({
      content: [{ text: "Generated brief" }],
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get("x-api-key")).toBe("test-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      messages: [{ content: "Build a brief", role: "user" }],
      model: "claude-sonnet-4-6",
      system: "Return JSON.",
    });
  });

  it("fails closed without exposing the API key", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("provider unavailable", { status: 503 }),
    );
    const client = new AnthropicClient("secret-value", fetchImplementation);

    await expect(
      client.generate({
        messages: [{ content: "Build a brief", role: "user" }],
      }),
    ).rejects.not.toThrow("secret-value");
  });
});
