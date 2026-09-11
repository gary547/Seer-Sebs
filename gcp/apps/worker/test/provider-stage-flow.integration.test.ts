import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { executeDataDrivenStage, type CategorisationStageData, type DetoxStageData, type KeywordEnrichmentStageData, type PreflightStageData } from "../../../packages/pipeline/src/stage-handlers.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { DataForSeoClient, DataForSeoAuthorityClient, LivePipelineProviderHydrator } from "../src/live-providers.js";
import { OPENROUTER_MODEL, OpenRouterPipelineClient, type AiProgress } from "../src/openrouter.js";

describe("provider-backed keyword stage integration", () => {
  it("persists DeepSeek batch results, honors project rules, resumes without duplicate calls and propagates intent to calculations", async () => {
    const fixture = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
    const requests: Array<Record<string, unknown>> = [];
    let activeRequests = 0;
    let peakRequests = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      peakRequests = Math.max(peakRequests, ++activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const input = JSON.parse(body.messages[1].content).items as Array<{ index: number }>;
      const detox = String(body.messages[0].content).includes("decision (keep/remove/review)");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ model: OPENROUTER_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        items: input.map(({ index }) => detox
          ? { index, decision: "keep", reason: "Relevant to the configured client" }
          : { index, category: "Model assigned category", intent: "informational", tags: ["Model assigned category"] }),
      }) } }] }));
      activeRequests -= 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cache = new Map<string, unknown>();
      const classifications = new Map<string, unknown>();
      const attempts = new Map<string, number>();
      const messages: string[] = [];
      const progressUpdates: AiProgress[] = [];
      const query = vi.fn(async (sql: string, values: unknown[] = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM keyword_intent_cache")) {
          const wanted = Array.isArray(values[2]) ? values[2] : null;
          const prefix = `${values[0]}:${values[1]}:`;
          const rows = [...classifications].filter(([key]) => key.startsWith(prefix))
            .map(([key, result]) => ({ normalised_keyword: key.slice(prefix.length), result }))
            .filter(row => !wanted || wanted.includes(row.normalised_keyword));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("INSERT INTO keyword_intent_cache")) {
          for (const row of JSON.parse(String(values[4]))) {
            const key = `${values[0]}:${values[1]}:${row.normalised_keyword}`;
            if (!classifications.has(key)) classifications.set(key, row.result);
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("input->>'mode'")) return { rows: [{ mode: "full" }], rowCount: 1 };
        if (sql.includes("RETURNING attempt_count")) {
          const key = `${values[2]}:${values[3]}`;
          const count = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, count);
          return { rows: [{ attempt_count: count }], rowCount: 1 };
        }
        if (sql.includes("SELECT result, item_key FROM provider_work_items")) {
          const rows = [...cache.entries()].filter(([key]) => key.startsWith(`${values[1]}:`))
            .map(([key, result]) => ({ item_key: key.slice(String(values[1]).length + 1), result }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("INSERT INTO provider_work_items")) cache.set(`${values[2]}:${values[3]}`, JSON.parse(String(values[4])));
        else if (sql.includes("UPDATE pipeline_stage_runs")) {
          messages.push(String(values[2]));
          progressUpdates.push(JSON.parse(String(values[4])) as AiProgress);
        }
        else throw new Error("Unexpected persistence operation in integration test.");
        return { rows: [], rowCount: 1 };
      });
      const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as DatabasePool;
      const ai = new OpenRouterPipelineClient("integration-key", (_input, init) => fetch(url, init), undefined, 3);
      const hydrator = new LivePipelineProviderHydrator({} as DataForSeoClient, {} as DataForSeoAuthorityClient, ai);
      const intake = executeDataDrivenStage("intake", fixture, {});
      const promotion = executeDataDrivenStage("gsc-promotion", fixture, { intake });
      const rules = executeDataDrivenStage("detox", fixture, { "gsc-promotion": promotion }) as DetoxStageData;
      const detox = await hydrator.refineStage(pool, fixture.project.id, "test-run", fixture, rules) as DetoxStageData;
      expect(requests.length).toBeGreaterThan(0);
      const hardDecisions = rules.keywords.filter((keyword) => ["whitelist", "blacklist", "numeric", "pre-curated", "competitor"].includes(keyword.detox.rule));
      for (const original of hardDecisions) expect(detox.keywords.find((keyword) => keyword.id === original.id)?.detox).toEqual(original.detox);
      expect(detox.keywords.some((keyword) => keyword.detox.rule === `openrouter:${OPENROUTER_MODEL}`)).toBe(true);
      const firstRequestCount = requests.length;
      expect(await hydrator.refineStage(pool, fixture.project.id, "test-run", fixture, rules)).toEqual(detox);
      expect(requests).toHaveLength(firstRequestCount);
      const baseCategories = executeDataDrivenStage("categorisation", fixture, { detox }) as CategorisationStageData;
      const categorisation = await hydrator.refineStage(pool, fixture.project.id, "test-run", fixture, baseCategories) as CategorisationStageData;
      expect(categorisation.keywords.filter((keyword) => !keyword.preCurated).every((keyword) => keyword.categorisation.source === "openrouter")).toBe(true);
      const manyCategories = { ...baseCategories, keywords: Array.from({ length: 61 }, (_, index) => ({
        ...baseCategories.keywords[0]!, id: `keyword-${index}`, text: `housing query ${index}`,
        normalisedText: `housing query ${index}`, preCurated: false,
      })) };
      await hydrator.refineStage(pool, fixture.project.id, "test-run", fixture, manyCategories);
      expect(peakRequests).toBe(3);
      expect(progressUpdates.at(-1)).toMatchObject({ completedBatches: 4, activeBatches: 0, batchCount: 4, concurrency: 3 });
      expect(messages.some((message) => message.includes("3 in parallel"))).toBe(true);
      const requestsBeforeResume = requests.length;
      const cacheReadsBeforeResume = query.mock.calls.filter(([sql]) => sql.includes("SELECT result, item_key")).length;
      await hydrator.refineStage(pool, fixture.project.id, "test-run", fixture, manyCategories);
      expect(requests).toHaveLength(requestsBeforeResume);
      expect(query.mock.calls.filter(([sql]) => sql.includes("SELECT result, item_key"))).toHaveLength(cacheReadsBeforeResume);
      expect(classifications.size).toBeGreaterThanOrEqual(61);
      expect(categorisation.classificationContract).toBe("intent-v2");
      const preflight = executeDataDrivenStage("preflight", fixture, { detox, categorisation }) as PreflightStageData;
      const enrichment = executeDataDrivenStage("keyword-enrichment", fixture, { preflight }) as KeywordEnrichmentStageData;
      for (const keyword of enrichment.keywords) {
        expect(keyword.enrichment.intent).toBe("informational");
        expect(keyword.enrichment.intentSource).toBe("openrouter");
        expect(keyword.category).toBe("Model assigned category");
      }
      expect(requests.every((request) => request.model === OPENROUTER_MODEL && !("models" in request))).toBe(true);
      expect(messages.every((message) => message.includes("DeepSeek V4.1 Flash") && !/claude|anthropic|\b500\b/i.test(message))).toBe(true);
      expect(categorisation.keywords.filter((keyword) => !keyword.preCurated).every((keyword) => keyword.categorisation.model === OPENROUTER_MODEL)).toBe(true);
      expect(cache.size).toBeGreaterThanOrEqual(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
