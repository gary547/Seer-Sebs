import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { loadStageOutput, storeStageOutput, STAGE_OUTPUT_CHUNK_BYTES } from "../src/stage-output.js";

function database() {
  const chunks: Array<{ run: string; stage: string; field: string; chunk_index: number; item_count: number; payload: string; sha256: string }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const [run, stage, field, index, count, payload, sha256] = params;
    if (sql.startsWith("DELETE")) {
      for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i]!.run === run && chunks[i]!.stage === stage) chunks.splice(i, 1);
    } else if (sql.startsWith("INSERT")) {
      chunks.push({ run: String(run), stage: String(stage), field: String(field), chunk_index: Number(index), item_count: Number(count), payload: String(payload), sha256: String(sha256) });
    } else if (sql.startsWith("SELECT")) {
      return { rows: chunks.filter(row => row.run === run && row.stage === stage && row.field === field && row.chunk_index >= Number(index)).sort((a, b) => a.chunk_index - b.chunk_index).slice(0, 2) };
    }
    return { rows: [], rowCount: 1 };
  });
  return { chunks, query, client: { query } as unknown as Pick<PoolClient, "query"> };
}

describe("bounded stage output", () => {
  it("retains legacy and small outputs without chunk reads", async () => {
    const db = database();
    const value = { modelVersion: "unchanged", keywords: [{ score: 0, target: null, label: "é 🧪", nested: [true, false] }] };
    expect(await storeStageOutput(db.client, "run", "stage", value)).toEqual(value);
    expect(await loadStageOutput(db.client, "run", "stage", value)).toBe(value);
    expect(await loadStageOutput(db.client, "run", "stage", null)).toBeNull();
    expect(db.chunks).toHaveLength(0);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("round trips bounded pages in order, retaining zeros, nulls and Unicode", async () => {
    const db = database();
    const value = { modelVersion: "unchanged", keywords: Array.from({ length: 40 }, (_, id) => ({ id, zero: 0, target: null, text: "🧪".repeat(80_000) })), secondary: Array.from({ length: 1200 }, (_, id) => ({ id, text: "x".repeat(100) })) };
    const stored = await storeStageOutput(db.client, "run", "har-v2", value);
    expect(JSON.stringify(stored).length).toBeLessThan(2048);
    expect(stored).not.toHaveProperty("keywords");
    expect(db.chunks.length).toBeGreaterThan(2);
    expect(db.chunks.every(chunk => Buffer.byteLength(chunk.payload) <= STAGE_OUTPUT_CHUNK_BYTES)).toBe(true);
    expect(await loadStageOutput(db.client, "run", "har-v2", stored)).toEqual(value);
    await storeStageOutput(db.client, "other", "har-v2", { keywords: ["unrelated"] });
    expect(await loadStageOutput(db.client, "run", "har-v2", stored)).toEqual(value);
    await storeStageOutput(db.client, "run", "har-v2", value);
    expect(await loadStageOutput(db.client, "run", "har-v2", stored)).toEqual(value);
    await expect(loadStageOutput(db.client, "other", "har-v2", stored)).rejects.toMatchObject({ code: "pipeline_output_storage_failed" });
  });

  for (const corruption of ["missing", "hash", "order", "count", "extra", "content"]) {
    it(`rejects ${corruption} chunk corruption instead of partial outputs`, async () => {
      const db = database();
      const stored = await storeStageOutput(db.client, "run", "stage", { keywords: Array.from({ length: 100 }, (_, id) => ({ id, text: "x".repeat(1000) })) });
      const chunk = db.chunks[0]!;
      if (corruption === "missing") db.chunks.splice(0);
      if (corruption === "hash") chunk.sha256 = "0".repeat(64);
      if (corruption === "order") chunk.chunk_index = 1;
      if (corruption === "count") chunk.item_count++;
      if (corruption === "extra") db.chunks.push({ ...chunk, chunk_index: 1 });
      if (corruption === "content") { chunk.payload = chunk.payload.replace('"id":0', '"id":9'); chunk.sha256 = createHash("sha256").update(chunk.payload).digest("hex"); }
      await expect(loadStageOutput(db.client, "run", "stage", stored)).rejects.toMatchObject({ statusCode: 422 });
    });
  }

  it("rejects unsupported manifests and oversized individual records", async () => {
    const db = database();
    await expect(loadStageOutput(db.client, "run", "stage", { stageOutputStorage: { version: 2, arrays: [] } })).rejects.toMatchObject({ statusCode: 422 });
    await expect(storeStageOutput(db.client, "run", "stage", { keywords: ["x".repeat(STAGE_OUTPUT_CHUNK_BYTES)] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(storeStageOutput(db.client, "run", "stage", { stageOutputStorage: {} })).rejects.toMatchObject({ statusCode: 422 });
  });
});
