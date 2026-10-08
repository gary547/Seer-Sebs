import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { OpenRouterPipelineClient, OPENROUTER_MODEL } from "../src/openrouter.js";
import { DataForSeoAuthorityClient, DataForSeoClient } from "../src/live-providers.js";
import { withProviderRun } from "../src/run-control.js";
import { executeStageTask, failPipelineRun } from "../src/processor.js";

describe("cooperative provider stopping", () => {
  it("drains successful AI requests, stops subsequent batches and resumes only missing work", async () => {
    let status = "running";
    let generation = 0;
    let calls = 0;
    const saved = new Map<string, unknown>();
    const pool = { query: async () => ({ rows: [{ status, generation }] }) } as unknown as DatabasePool;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const call = ++calls;
      const items = JSON.parse(JSON.parse(String(init!.body)).messages[1].content).items as Array<{ index: number }>;
      await new Promise(resolve => setTimeout(resolve, call === 1 ? 5 : 20));
      if (call === 1) status = "failed";
      return Response.json({ model: OPENROUTER_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        items: items.map(({ index }) => ({ index, relevancyScore: 75, contentStatus: "green", tacticalStatus: "no_action_needed" })),
      }) } }] });
    });
    const ai = new OpenRouterPipelineClient("test-only", fetcher as typeof fetch, async () => {}, 2);
    const rows = Array.from({ length: 61 }, (_, i) => ({ keyword: `query ${i}`, rankingUrl: "https://example.test/" }));
    const cache = { get: async (key: string) => saved.get(key), set: async (key: string, result: unknown) => { saved.set(key, result); } };
    await expect(withProviderRun(pool, "run", 0, () => ai.score(rows, { cache }))).rejects.toMatchObject({ code: "pipeline_stopped", statusCode: 422 });
    expect(calls).toBe(2);
    expect(saved.size).toBe(2);
    status = "running"; generation = 1;
    const results = await withProviderRun(pool, "run", 1, () => ai.score(rows, { cache }));
    expect(results.size).toBe(61);
    expect(calls).toBe(4);
    expect(saved.size).toBe(4);
  });

  it("does not retry a provider transport failure after stop", async () => {
    let status = "running";
    const pool = { query: async () => ({ rows: [{ status, generation: 0 }] }) } as unknown as DatabasePool;
    const fetcher = vi.fn(async () => { status = "failed"; return new Response("Unavailable", { status: 503 }); });
    const authority = new DataForSeoAuthorityClient("test-only", fetcher, async () => {});
    await expect(withProviderRun(pool, "run", 0, () => authority.metrics([{ mode: "domain", url: "example.test" }]))).rejects.toMatchObject({ code: "pipeline_stopped" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects stale deliveries and ignores stale failure callbacks after resume", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : sql.includes("SELECT status") ? [{ status: "running", generation: 1 }] : [] }));
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as DatabasePool;
    const provider = { hydrate: vi.fn() };
    await expect(executeStageTask(pool, { runId: "run", stageId: "detox", taskId: "old", generation: 0 }, { providerHydrator: provider }))
      .rejects.toMatchObject({ statusCode: 422, code: "pipeline_stopped" });
    expect(provider.hydrate).not.toHaveBeenCalled();
    expect(await failPipelineRun(pool, { runId: "run", stageId: "detox", reason: "old failure", generation: 0 })).toMatchObject({ status: "running", idempotent: true });
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith("UPDATE"))).toBe(false);
  });
});

describe("DataForSEO terminal search outcomes", () => {
  it("records 40102 as no results while retaining normal pending and successful outcomes", async () => {
    const fetcher = vi.fn(async (url: unknown) => Response.json({ status_code: 20000, tasks: [{
      status_code: String(url).endsWith("empty") ? 40102 : String(url).endsWith("pending") ? 40602 : 20000,
      result: [{ items: [{ type: "organic", rank_absolute: 1, url: "https://example.test/page", domain: "example.test" }] }],
    }] }));
    const client = new DataForSeoClient("test-only", fetcher);
    expect(await client.serpTaskSnapshot("empty")).toEqual({ outcome: "no_results", statusCode: 40102, features: [], results: [] });
    expect(await client.serpTaskSnapshot("pending")).toBe("pending");
    expect(await client.serpTaskSnapshot("found")).toMatchObject({ results: [{ rankAbsolute: 1 }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
