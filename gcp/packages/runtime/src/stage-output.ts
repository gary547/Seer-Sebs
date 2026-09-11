import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { HttpError } from "./http.js";

export const STAGE_OUTPUT_INLINE_BYTES = 64 * 1024;
export const STAGE_OUTPUT_CHUNK_BYTES = 8 * 1024 * 1024;
const STORAGE_KEY = "stageOutputStorage";
const READ_PAGE_SIZE = 2;

interface ArrayManifest {
  field: string;
  items: number;
  chunks: number;
  sha256: string;
}

interface ChunkRow {
  chunk_index: number;
  item_count: number;
  payload: string;
  sha256: string;
}

function invalidOutput(): HttpError {
  return new HttpError(422, "pipeline_output_storage_failed",
    "Calculation output could not be saved or verified safely. Automatic retries stopped; previously completed stages are preserved.");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function storeStageOutput(
  client: Pick<PoolClient, "query">,
  runId: string,
  stageId: string,
  output: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Object.hasOwn(output, STORAGE_KEY)) throw invalidOutput();
  const summary = Object.fromEntries(Object.entries(output).filter(([, value]) => !Array.isArray(value)));
  let inlineBytes = Buffer.byteLength(JSON.stringify(summary));
  if (inlineBytes > STAGE_OUTPUT_INLINE_BYTES) throw invalidOutput();
  const arrays: ArrayManifest[] = [];
  await client.query("DELETE FROM pipeline_stage_output_chunks WHERE run_id = $1 AND stage_id = $2", [runId, stageId]);
  for (const [field, value] of Object.entries(output)) {
    if (!Array.isArray(value)) continue;
    if (field.length > 128) throw invalidOutput();
    let pending: string[] = [];
    let bytes = 2;
    let chunkIndex = 0;
    const hash = createHash("sha256");
    const flush = async () => {
      if (pending.length === 0) return;
      const payload = `[${pending.join(",")}]`;
      const sha256 = digest(payload);
      await client.query(
        `INSERT INTO pipeline_stage_output_chunks
          (run_id, stage_id, field_name, chunk_index, item_count, payload, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, stageId, field, chunkIndex, pending.length, payload, sha256],
      );
      hash.update(sha256);
      chunkIndex += 1;
      pending = [];
      bytes = 2;
    };
    for (const item of value) {
      const encoded = JSON.stringify(item) ?? "null";
      const size = Buffer.byteLength(encoded);
      if (size + 2 > STAGE_OUTPUT_CHUNK_BYTES) throw invalidOutput();
      if (bytes + size + (pending.length ? 1 : 0) > STAGE_OUTPUT_CHUNK_BYTES) await flush();
      bytes += size + (pending.length ? 1 : 0);
      pending.push(encoded);
    }
    const fieldBytes = Buffer.byteLength(JSON.stringify(field)) + 1;
    if (chunkIndex === 0 && inlineBytes + fieldBytes + bytes < STAGE_OUTPUT_INLINE_BYTES) {
      Object.defineProperty(summary, field, { value, enumerable: true, configurable: true, writable: true });
      inlineBytes += fieldBytes + bytes;
    } else {
      await flush();
      arrays.push({ field, items: value.length, chunks: chunkIndex, sha256: hash.digest("hex") });
    }
  }
  if (arrays.length) summary[STORAGE_KEY] = { version: 1, arrays };
  if (Buffer.byteLength(JSON.stringify(summary)) > STAGE_OUTPUT_INLINE_BYTES) throw invalidOutput();
  return summary;
}

export async function loadStageOutput(
  client: Pick<PoolClient, "query">,
  runId: string,
  stageId: string,
  output: unknown,
): Promise<unknown> {
  const stored = record(output);
  if (!stored || !Object.hasOwn(stored, STORAGE_KEY)) return output;
  const manifest = record(stored[STORAGE_KEY]);
  if (manifest?.version !== 1 || !Array.isArray(manifest.arrays) || manifest.arrays.length === 0) throw invalidOutput();
  const restored = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== STORAGE_KEY));
  const fields = new Set<string>();
  for (const entry of manifest.arrays) {
    const array = record(entry);
    if (!array || typeof array.field !== "string" || array.field === STORAGE_KEY || array.field.length === 0 || array.field.length > 128 ||
      fields.has(array.field) || Object.hasOwn(restored, array.field) ||
      typeof array.items !== "number" || !Number.isSafeInteger(array.items) || array.items < 0 ||
      typeof array.chunks !== "number" || !Number.isSafeInteger(array.chunks) || array.chunks < 0 ||
      typeof array.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(array.sha256)) throw invalidOutput();
    fields.add(array.field);
    const values: unknown[] = [];
    const hash = createHash("sha256");
    let next = 0;
    for (;;) {
      const page = await client.query<ChunkRow>(
        `SELECT chunk_index, item_count, payload, sha256 FROM pipeline_stage_output_chunks
         WHERE run_id = $1 AND stage_id = $2 AND field_name = $3 AND chunk_index >= $4
         ORDER BY chunk_index LIMIT ${READ_PAGE_SIZE}`,
        [runId, stageId, array.field, next],
      );
      if (page.rows.length === 0) break;
      for (const chunk of page.rows) {
        if (chunk.chunk_index !== next || next >= array.chunks ||
          Buffer.byteLength(chunk.payload) > STAGE_OUTPUT_CHUNK_BYTES || digest(chunk.payload) !== chunk.sha256) throw invalidOutput();
        let items: unknown;
        try { items = JSON.parse(chunk.payload); } catch { throw invalidOutput(); }
        if (!Array.isArray(items) || items.length !== chunk.item_count || items.length === 0 ||
          values.length + items.length > array.items) throw invalidOutput();
        for (const item of items) values.push(item);
        hash.update(chunk.sha256);
        next += 1;
      }
    }
    if (next !== array.chunks || values.length !== array.items || hash.digest("hex") !== array.sha256) throw invalidOutput();
    Object.defineProperty(restored, array.field, { value: values, enumerable: true, configurable: true, writable: true });
  }
  return restored;
}
