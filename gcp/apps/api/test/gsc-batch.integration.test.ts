import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const projectId = "00000000-0000-4000-8000-000000000003";
const file = (query: string) => ({
  filename: `${query}.csv`, format: "csv_text", device: "all",
  dateRangeStart: "2025-04-28", dateRangeEnd: "2026-09-07",
  csvText: `Query,Page,Clicks,Impressions,CTR,Position\n${query},https://example.com/${query},10,100,10%,8`,
});

describe("GSC multi-file HTTP import", () => {
  let server: ReturnType<typeof createApiServer>;
  let url: string;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let allowed: boolean;
  let failInsert: boolean;
  beforeEach(async () => {
    queries = []; allowed = true; failInsert = false;
    const query = vi.fn(async (statement: string, values: unknown[] = []) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      queries.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("SELECT approval_status")) rows = [{ approval_status: "approved" }];
      else if (sql.includes("SELECT client_id FROM navigator_projects")) rows = allowed ? [{ client_id: projectId }] : [];
      else if (sql.includes("FROM user_roles AS user_role")) rows = [{ role: "admin" }];
      else if (sql.includes("INSERT INTO gsc_upload_keywords") && failInsert) throw new Error("test persistence failure");
      return { rows, rowCount: rows.length };
    });
    const client = { query, release: vi.fn() };
    server = createApiServer({
      pool: { query, connect: async () => client } as unknown as DatabasePool,
      authenticateRequest: async () => ({ id: projectId, email: "batch@example.dev" }),
      objectStore: { assertReady: async () => undefined, delete: async () => undefined, get: async () => Buffer.alloc(0), put: async () => undefined },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/${projectId}/gsc-workbook`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (url: string, files: unknown[]) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }),
  });

  it("persists all categories in a single upload and transaction", async () => {
    const response = await post(url, [file("tv"), file("oven"), file("fridge")]);
    expect(response.status).toBe(201);
    const result = await response.json() as { upload_id: string; source_files: unknown[] };
    expect(result).toMatchObject({ row_count: 3, source: "gsc_batch_v1" });
    expect(result.source_files).toHaveLength(3);
    const uploads = queries.filter(({ sql }) => sql.startsWith("INSERT INTO gsc_uploads"));
    expect(uploads).toHaveLength(1);
    expect(JSON.parse(String(uploads[0]?.values[8]))).toHaveLength(3);
    const insert = queries.find(({ sql }) => sql.startsWith("INSERT INTO gsc_upload_keywords"));
    expect(insert?.values[0]).toBe(result.upload_id);
    expect(JSON.parse(String(insert?.values[1])).map((row: { query: string }) => row.query).sort()).toEqual(["fridge", "oven", "tv"]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });
  it("validates every file before starting a transaction", async () => {
    expect((await post(url, [file("tv"), { ...file("oven"), dateRangeStart: "2026-01-01" }])).status).toBe(400);
    expect(queries.some(({ sql }) => sql === "BEGIN")).toBe(false);
    expect(queries.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("preserves page-sheet metrics and device identity in the bulk persistence contract", async () => {
    const response = await fetch(url.replace("gsc-workbook", "gsc-imports"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceName: "gsc_workbook_v1", rows: [], pages: [
        { pageUrl: "https://example.com/tv", device: "tablet", clicks: 2, impressions: 20, ctr: 0.1, position: 3 },
        { pageUrl: "https://example.com/oven", device: "mobile", clicks: 5, impressions: 50, ctr: 0.1, position: 7 },
      ] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ pages_inserted: 2 });
    const batch = queries.find(({ sql }) => sql.startsWith("INSERT INTO gsc_upload_pages"));
    expect(batch?.sql).toContain('page."pageUrl"');
    expect(JSON.parse(String(batch?.values[1]))).toMatchObject([
      { pageUrl: "https://example.com/tv", device: "tablet", clicks: 2, impressions: 20 },
      { pageUrl: "https://example.com/oven", device: "mobile", clicks: 5, impressions: 50 },
    ]);
  });
  it("rejects inaccessible projects before any write", async () => {
    allowed = false;
    expect((await post(url, [file("tv"), file("oven")])).status).toBe(404);
    expect(queries.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("rolls back the upload when persistence fails", async () => {
    failInsert = true;
    expect((await post(url, [file("tv"), file("oven")])).status).toBe(500);
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(queries.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });
  it("bounds bulk inserts and accepts more than 50,000 page observations", async () => {
    const rows = Array.from({ length: 25_001 }, (_, i) => `keyword ${i},https://example.com/a,1,10,10%,2`).join("\n");
    const secondRows = rows.replaceAll("example.com/a", "example.com/b");
    const response = await post(url, [
      { ...file("first"), csvText: `Query,Page,Clicks,Impressions,CTR,Position\n${rows}` },
      { ...file("second"), csvText: `Query,Page,Clicks,Impressions,CTR,Position\n${secondRows}` },
    ]);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ row_count: 50_002 });
    const batches = queries.filter(({ sql }) => sql.startsWith("INSERT INTO gsc_upload_keywords"));
    expect(batches).toHaveLength(51);
    expect(batches.every(({ values }) => JSON.parse(String(values[1])).length <= 1_000)).toBe(true);
  }, 30_000);
});
