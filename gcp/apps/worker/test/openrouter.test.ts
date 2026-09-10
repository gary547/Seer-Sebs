import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { LEGACY_PIPELINE_AI_MODEL } from "../../../packages/pipeline/src/ai-model.js";
import { OpenRouterPipelineClient, OPENROUTER_MODEL, OPENROUTER_MAX_ATTEMPTS, OPENROUTER_RETRY_WAIT_MS, resolveOpenRouterConcurrency, type AiProgress } from "../src/openrouter.js";

const source = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
const score = { index: 0, relevancyScore: 75, contentStatus: "green", tacticalStatus: "no_action_needed" };
const rows = [{ keyword: "buy television", rankingUrl: "https://example.test/tvs" }];

function response(items: unknown[], model: string = OPENROUTER_MODEL, finishReason = "stop"): Response {
  return Response.json({ model, choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ items }) } }] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function batchInput(count: number) {
  return Array.from({ length: count * 20 }, (_, index) => ({ keyword: `query ${index}`, rankingUrl: "https://example.test/" }));
}

function scoreResponse(init?: RequestInit) {
  const items = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).items as Array<{ index: number; keyword: string }>;
  return response(items.map((item) => ({ ...score, index: item.index, relevancyScore: Number(item.keyword.split(" ")[1]) % 101 })).reverse());
}

describe("OpenRouter DeepSeek V4.1 Flash pipeline client", () => {
  it("defaults to eight parallel batches and validates configuration", () => {
    expect(resolveOpenRouterConcurrency()).toBe(8);
    expect(resolveOpenRouterConcurrency("16")).toBe(16);
    for (const value of ["", "0", "-1", "1.5", "33", "Infinity", "invalid"]) {
      expect(() => resolveOpenRouterConcurrency(value)).toThrow("between 1 and 32");
    }
  });

  it("bounds concurrency, preserves input ordering and serializes completed-count updates", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    let calls = 0;
    let progressWrites = 0;
    const snapshots: AiProgress[] = [];
    const cache = new Map<string, unknown>();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const index = calls++;
      peak = Math.max(peak, ++active);
      await gates[index]!.promise;
      active -= 1;
      return scoreResponse(init);
    });
    const output = new OpenRouterPipelineClient("test-key", fetcher, undefined, 3).score(batchInput(5), {
      cache: { get: async (key) => cache.get(key), set: async (key, value) => { cache.set(key, value); } },
      progress: async (progress) => {
        expect(++progressWrites).toBe(1);
        await Promise.resolve();
        snapshots.push(progress);
        progressWrites -= 1;
      },
    });
    await vi.waitFor(() => expect(calls).toBe(3));
    gates[2]!.resolve();
    await vi.waitFor(() => expect(calls).toBe(4));
    expect(snapshots.some((snapshot) => snapshot.batch === 3 && snapshot.completedBatches === 1)).toBe(true);
    gates[3]!.resolve();
    await vi.waitFor(() => expect(calls).toBe(5));
    gates[4]!.resolve();
    gates[1]!.resolve();
    gates[0]!.resolve();
    const result = await output;
    expect(peak).toBe(3);
    expect([...result.keys()]).toEqual(batchInput(5).map((row) => row.keyword));
    for (let index = 0; index < 100; index++) expect(result.get(`query ${index}`)?.relevancyScore).toBe(index);
    expect(snapshots.map((snapshot) => snapshot.completedBatches)).toEqual(snapshots.map((snapshot) => snapshot.completedBatches).sort((a, b) => a - b));
    expect(snapshots.at(-1)).toMatchObject({ completedBatches: 5, activeBatches: 0 });
    const cachedProgress = vi.fn();
    await new OpenRouterPipelineClient("test-key", fetcher, undefined, 8).score(batchInput(5), {
      cache: { get: async (key) => cache.get(key), set: async () => undefined }, progress: cachedProgress,
    });
    expect(calls).toBe(5);
    expect(cachedProgress).toHaveBeenLastCalledWith(expect.objectContaining({ completedBatches: 5, activeBatches: 0 }));
  });

  it("drains concurrent work at a checkpoint and resumes only missing batches at a different concurrency", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const gates = [deferred<void>(), deferred<void>()];
    const cache = new Map<string, unknown>();
    const options = { cache: { get: async (key: string) => cache.get(key), set: async (key: string, value: unknown) => { cache.set(key, value); } } };
    let calls = 0;
    let settled = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const gate = gates[calls++];
      if (gate) await gate.promise;
      return scoreResponse(init);
    });
    try {
      const outcome = new OpenRouterPipelineClient("test-key", fetcher, undefined, 2).score(batchInput(5), { ...options, deadline: 10 })
        .then(() => null, (error: unknown) => error).finally(() => { settled = true; });
      await vi.waitFor(() => expect(calls).toBe(2));
      clock.mockReturnValue(11);
      gates[1]!.resolve();
      await vi.waitFor(() => expect(cache.size).toBe(1));
      expect(settled).toBe(false);
      expect(calls).toBe(2);
      gates[0]!.resolve();
      expect(await outcome).toMatchObject({ code: "stage_continuation" });
      expect(cache.size).toBe(2);
      expect((await new OpenRouterPipelineClient("test-key", fetcher, undefined, 3).score(batchInput(5), options)).size).toBe(100);
      expect(calls).toBe(5);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops scheduling on permanent failure but waits for and saves successful siblings", async () => {
    const gate = deferred<void>();
    const cache = new Map<string, unknown>();
    let settled = false;
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (++calls === 1) {
        await gate.promise;
        return scoreResponse(init);
      }
      return new Response("rejected", { status: 403 });
    });
    const outcome = new OpenRouterPipelineClient("test-key", fetcher, undefined, 2).score(batchInput(5), {
      cache: { get: async () => undefined, set: async (key, value) => { cache.set(key, value); } },
    }).then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(settled).toBe(false);
    gate.resolve();
    expect(await outcome).toMatchObject({ code: "openrouter_access_rejected" });
    expect(cache.size).toBe(1);
    expect(calls).toBe(2);
  });

  it("retries a rate-limited batch independently while other batches keep progressing", async () => {
    const retry = deferred<void>();
    const cache = new Map<string, unknown>();
    const attempts = new Map<string, number>();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const keyword = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).items[0].keyword as string;
      const attempt = (attempts.get(keyword) ?? 0) + 1;
      attempts.set(keyword, attempt);
      return keyword === "query 0" && attempt === 1 ? new Response("limited", { status: 429 }) : scoreResponse(init);
    });
    const wait = vi.fn(() => retry.promise);
    const output = new OpenRouterPipelineClient("test-key", fetcher, wait, 2).score(batchInput(4), {
      cache: { get: async () => undefined, set: async (key, value) => { cache.set(key, value); } },
    });
    await vi.waitFor(() => expect(cache.size).toBe(3));
    expect(wait).toHaveBeenCalledWith(2000);
    retry.resolve();
    expect((await output).size).toBe(80);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect([...attempts.values()].sort()).toEqual([1, 1, 1, 2]);
  });

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
      const client = new OpenRouterPipelineClient("test-key", fetcher, undefined, 1);
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

  it("pins every request to DeepSeek V4.1 Flash with no model fallback", async () => {
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
    expect(String(init?.body)).not.toMatch(/claude|anthropic|glm/i);
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
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ attempt: 30, model: OPENROUTER_MODEL, batch: 1, batchCount: 1, phase: "retrying" }));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completedBatches: 1, activeBatches: 0, phase: "completed" }));
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

  it.each([LEGACY_PIPELINE_AI_MODEL, "unapproved-model"])("rejects returned model %s without falling back", async (model) => {
    const fetcher = vi.fn<typeof fetch>(async () => response([score], model));
    await expect(new OpenRouterPipelineClient("test-key", fetcher).score(rows)).rejects.toMatchObject({ code: "openrouter_model_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses exact historical GLM batches with their provenance but sends every new request to DeepSeek", async () => {
    const cache = new Map<string, unknown>();
    await new OpenRouterPipelineClient("test-key", async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const legacyKey = createHash("sha256").update(JSON.stringify({ ...body, model: LEGACY_PIPELINE_AI_MODEL })).digest("hex");
      const result = scoreResponse(init);
      const payload = await result.clone().json() as { choices: Array<{ message: { content: string } }> };
      cache.set(legacyKey, JSON.parse(payload.choices[0]!.message.content));
      return result;
    }).score(batchInput(1));
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => scoreResponse(init));
    const progress = vi.fn();
    const result = await new OpenRouterPipelineClient("test-key", fetcher).score(batchInput(3), {
      cache: { get: async (key) => cache.get(key), set: async (key, value) => { cache.set(key, value); } }, progress,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.get("query 0")?.model).toBe(LEGACY_PIPELINE_AI_MODEL);
    expect(result.get("query 20")?.model).toBe(OPENROUTER_MODEL);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completedBatches: 3,
      completedBatchesByModel: { [LEGACY_PIPELINE_AI_MODEL]: 1, [OPENROUTER_MODEL]: 2 } }));
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(String(init?.body)).model).toBe("deepseek/deepseek-v4.1-flash");
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
