import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { OpenRouterPipelineClient, OPENROUTER_MODEL, OPENROUTER_MAX_ATTEMPTS, OPENROUTER_RETRY_WAIT_MS } from "../src/openrouter.js";

const source = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
const score = { index: 0, relevancyScore: 75, contentStatus: "green", tacticalStatus: "no_action_needed" };
const rows = [{ keyword: "buy television", rankingUrl: "https://example.test/tvs" }];

function response(items: unknown[], model: string = OPENROUTER_MODEL, finishReason = "stop"): Response {
  return Response.json({ model, choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ items }) } }] });
}

describe("OpenRouter GLM 5.3 Flash pipeline client", () => {
  it("checkpoints a long stage before the delivery deadline and resumes only missing batches", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const results = new Map<string, unknown>();
    const cache = { get: async (key: string) => results.get(key), set: async (key: string, value: unknown) => { results.set(key, value); } };
    const input = Array.from({ length: 16_743 }, (_, index) => ({ keyword: `housing query ${index}`, rankingUrl: "https://example.test/housing" }));
    let requests = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      requests += 1;
      clock.mockReturnValue(requests * 1000);
      const items = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).items;
      return response(items.map((item: { index: number }) => ({ ...score, index: item.index })));
    });
    try {
      const client = new OpenRouterPipelineClient("test-key", fetcher);
      const checkpoint = await client.score(input, { cache, deadline: 2500 }).then(() => null, (error: unknown) => error);
      expect(checkpoint).toMatchObject({ code: "stage_continuation" });
      expect(requests).toBe(3);
      expect(results.size).toBe(3);
      const output = await client.score(input, { cache });
      expect(output.size).toBe(16_743);
      expect(requests).toBe(Math.ceil(16_743 / 20));
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the 30-attempt cap across checkpointed deliveries", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    let count = 0;
    const cache = { get: async () => undefined, set: async () => undefined,
      startAttempt: async () => ++count };
    const fetcher = vi.fn<typeof fetch>(async () => {
      clock.mockReturnValue(count * 1000);
      return new Response("unavailable", { status: 503 });
    });
    const wait = vi.fn(async () => undefined);
    const client = new OpenRouterPipelineClient("test-key", fetcher, wait);
    try {
      await expect(client.score(rows, { cache, deadline: 2500 })).rejects.toMatchObject({ code: "stage_continuation" });
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(client.score(rows, { cache })).rejects.toMatchObject({ code: "openrouter_retry_exhausted" });
      expect(fetcher).toHaveBeenCalledTimes(30);
      expect(wait).toHaveBeenCalledTimes(29);
    } finally {
      clock.mockRestore();
    }
  });

  it("pins every request to GLM 5.3 Flash with no model fallback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([score]));
    const result = await new OpenRouterPipelineClient("test-key", fetcher).score(rows);
    expect(result.get("buy television")).toMatchObject({ relevancyScore: 75 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(OPENROUTER_MODEL);
    expect(body.models).toBeUndefined();
    expect(body.route).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(String(init?.body)).not.toMatch(/claude|anthropic/i);
  });

  it("uses the same model for detox, categorisation and content fit", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ index: 0, decision: "keep", reason: "Relevant to the client offering" }]))
      .mockResolvedValueOnce(response([{ index: 0, category: "Televisions", intent: "transactional", tags: ["Televisions"] }]))
      .mockResolvedValueOnce(response([score]));
    const client = new OpenRouterPipelineClient("test-key", fetcher);
    expect((await client.detox(rows, source)).get("buy television")?.decision).toBe("keep");
    expect((await client.categorise(rows, source)).get("buy television")?.intent).toBe("transactional");
    await client.score(rows);
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(String(init?.body)).model).toBe(OPENROUTER_MODEL);
  });

  it("retries transient failures up to 30 times with a fixed two-second wait", async () => {
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>(async () => ++attempt < 30 ? new Response("unavailable", { status: 503 }) : response([score]));
    const wait = vi.fn(async (_milliseconds: number) => undefined);
    const progress = vi.fn(async () => undefined);
    const result = await new OpenRouterPipelineClient("test-key", fetcher, wait).score(rows, { progress });
    expect(result.size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(OPENROUTER_MAX_ATTEMPTS);
    expect(wait).toHaveBeenCalledTimes(29);
    expect(wait.mock.calls.every(([milliseconds]) => milliseconds === OPENROUTER_RETRY_WAIT_MS)).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 30, model: OPENROUTER_MODEL, batch: 1, batchCount: 1 }));
  });

  it.each([[], [{ ...score, index: 0.5 }], [{ ...score, relevancyScore: null }], [{ ...score, relevancyScore: "75" }]].map((invalid) => ({ invalid })))("retries incomplete or malformed rows: $invalid", async ({ invalid }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response([score]));
    const wait = vi.fn(async () => undefined);
    await new OpenRouterPipelineClient("test-key", fetcher, wait).score(rows);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2000);
  });

  it("rejects duplicate indexes and truncated content", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([score, score]))
      .mockResolvedValueOnce(response([score, { ...score, index: 1 }], OPENROUTER_MODEL, "length"))
      .mockResolvedValueOnce(response([score, { ...score, index: 1 }]));
    const wait = vi.fn(async () => undefined);
    const result = await new OpenRouterPipelineClient("test-key", fetcher, wait).score([...rows, { keyword: "buy oled television", rankingUrl: rows[0]!.rankingUrl }]);
    expect(result.size).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 402, 403, 404])("does not retry permanent rejection %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("rejected", { status }));
    const wait = vi.fn(async () => undefined);
    await expect(new OpenRouterPipelineClient("test-key", fetcher, wait).score(rows)).rejects.toMatchObject({ code: "openrouter_access_rejected", statusCode: 424 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects a different returned model without trying Claude", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([score], "unapproved-model"));
    await expect(new OpenRouterPipelineClient("test-key", fetcher).score(rows)).rejects.toMatchObject({ code: "openrouter_model_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses validated completed batches and invalidates the cache when inputs change", async () => {
    const results = new Map<string, unknown>();
    const cache = { get: async (key: string) => results.get(key), set: async (key: string, output: unknown) => { results.set(key, output); } };
    const fetcher = vi.fn<typeof fetch>(async () => response([score]));
    const client = new OpenRouterPipelineClient("test-key", fetcher);
    await client.score(rows, { cache });
    await client.score(rows, { cache });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.score([{ ...rows[0]!, rankingUrl: "https://example.test/changed" }], { cache });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("exhausts unusable responses with a curated terminal error", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([]));
    const wait = vi.fn(async () => undefined);
    await expect(new OpenRouterPipelineClient("test-key", fetcher, wait).score(rows)).rejects.toMatchObject({ code: "openrouter_retry_exhausted", statusCode: 424 });
    expect(fetcher).toHaveBeenCalledTimes(30);
    expect(wait).toHaveBeenCalledTimes(29);
  });
});
