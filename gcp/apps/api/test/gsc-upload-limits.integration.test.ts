import { connect, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_GSC_OBSERVATIONS, MAXIMUM_GSC_REQUEST_BYTES, MAXIMUM_GSC_UPLOAD_BYTES } from "../../../packages/contracts/src/gsc-import-limits.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import { createApiHealthServer, createHttp2ApiServer, type ApiServerConfig } from "../src/server.js";

const projectId = "00000000-0000-4000-8000-000000000003";
const header = "Query,Page,Clicks,Impressions,CTR,Position";
const file = (csvText: string, filename = "export.csv") => ({
  format: "csv_text", filename, csvText, device: "all",
  dateRangeStart: "2025-09-01", dateRangeEnd: "2026-08-31",
});

describe("large GSC uploads over h2c", () => {
  let server: Http2Server;
  let origin: string;
  let config: ApiServerConfig;
  let statements: string[];
  let batchSizes: number[];
  let uploadedSources: Array<{ filename: string; rowCount: number; sha256: string }>;

  beforeEach(async () => {
    statements = []; batchSizes = []; uploadedSources = [];
    const query = vi.fn(async (statement: string, values: unknown[] = []) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("SELECT approval_status")) rows = [{ approval_status: "approved" }];
      else if (sql.includes("SELECT client_id FROM navigator_projects")) rows = [{ client_id: projectId }];
      else if (sql.includes("FROM user_roles AS user_role")) rows = [{ role: "admin" }];
      else if (sql.startsWith("INSERT INTO gsc_uploads")) uploadedSources = JSON.parse(String(values[8]));
      else if (sql.startsWith("INSERT INTO gsc_upload_keywords")) batchSizes.push(JSON.parse(String(values[1])).length);
      return { rows, rowCount: rows.length };
    });
    config = {
      pool: { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as DatabasePool,
      authenticateRequest: async (_pool, request) => {
        if (request.headers.authorization !== "Bearer test-admin") throw new HttpError(401, "authentication_required", "A bearer token is required.");
        return { id: projectId, email: "gsc-test@example.dev" };
      },
      allowedOrigins: ["https://seer.example.dev"],
      objectStore: { assertReady: async () => undefined, delete: async () => undefined, get: async () => Buffer.alloc(0), put: async () => undefined },
    };
    server = createHttp2ApiServer(config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function request(body?: unknown, path = `/v1/projects/${projectId}/gsc-workbook`, extraHeaders: Record<string, string> = {}) {
    const session = connect(origin);
    try {
      return await new Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>((resolve, reject) => {
        const stream = session.request({
          ":method": body === undefined ? "GET" : "POST", ":path": path,
          "content-type": "application/json", authorization: "Bearer test-admin", ...extraHeaders,
        });
        let status = 0;
        let headers = {};
        const chunks: Buffer[] = [];
        stream.on("response", (value) => { status = Number(value[":status"]); headers = value; });
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        session.on("error", reject);
        stream.on("end", () => resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), headers }));
        stream.end(body === undefined ? undefined : JSON.stringify(body));
      });
    } finally {
      session.destroy();
    }
  }

  it("imports a CSV at the full 50 MiB ceiling over HTTP/2", async () => {
    const prefix = `${header},Notes\nlarge export,https://example.com/landing,10,100,10%,8,`;
    const csvText = prefix + "x".repeat(MAXIMUM_GSC_UPLOAD_BYTES - Buffer.byteLength(prefix));
    expect(Buffer.byteLength(csvText)).toBe(MAXIMUM_GSC_UPLOAD_BYTES);
    const response = await request(file(csvText));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ row_count: 1, date_range_start: "2025-09-01", date_range_end: "2026-08-31", upload_device: "all" });
    expect(uploadedSources).toMatchObject([{ filename: "export.csv", rowCount: 1 }]);
    expect(uploadedSources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(batchSizes).toEqual([1]);
    expect(statements.at(-1)).toBe("COMMIT");
  }, 30_000);

  it("rejects a single CSV one byte over 50 MiB before opening a transaction", async () => {
    const response = await request(file("x".repeat(MAXIMUM_GSC_UPLOAD_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "gsc_upload_too_large", message: expect.stringContaining("52,428,801 bytes") } });
    expect(statements).not.toContain("BEGIN");
    expect(uploadedSources).toEqual([]);
  }, 30_000);

  it("checks the combined byte size of multiple files", async () => {
    const response = await request({ files: [file("x".repeat(26 * 1024 * 1024), "first.csv"), file("x".repeat(25 * 1024 * 1024), "second.csv")] });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "gsc_upload_too_large", message: expect.stringContaining("51.00 MB") } });
    expect(statements).not.toContain("BEGIN");
  }, 30_000);

  it("returns a readable 413 when the encoded request exceeds the transport bound", async () => {
    const response = await request(file("x".repeat(MAXIMUM_GSC_REQUEST_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "gsc_upload_too_large", message: expect.stringContaining("at most 50 MB") } });
    expect(statements).not.toContain("BEGIN");
  }, 30_000);

  it("imports exactly 250,000 observations and keeps persistence batches bounded", async () => {
    const csvText = `${header}\n` + Array.from({ length: MAXIMUM_GSC_OBSERVATIONS }, (_, i) => `keyword ${i},https://example.com/landing,1,10,10%,8`).join("\n");
    const response = await request(file(csvText));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ row_count: MAXIMUM_GSC_OBSERVATIONS });
    expect(batchSizes.reduce((sum, count) => sum + count, 0)).toBe(MAXIMUM_GSC_OBSERVATIONS);
    expect(batchSizes.every((count) => count <= 1_000)).toBe(true);
    expect(uploadedSources[0]?.rowCount).toBe(MAXIMUM_GSC_OBSERVATIONS);
    expect(statements.at(-1)).toBe("COMMIT");
  }, 30_000);

  it("reports the actual count and ceiling for an oversized single-file dataset", async () => {
    const csvText = `${header}\n` + Array.from({ length: MAXIMUM_GSC_OBSERVATIONS + 1 }, (_, i) => `keyword ${i},https://example.com/landing,1,10,10%,8`).join("\n");
    const response = await request(file(csvText));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "gsc_batch_too_large", message: expect.stringContaining("250,001") } });
    expect(String((response.body.error as { message: string }).message)).toContain("maximum is 250,000");
    expect(statements).not.toContain("BEGIN");
  }, 30_000);

  it.each(["rows", "pages"])("applies the same observation error to raw %s imports", async (field) => {
    const response = await request({ sourceName: "gsc_csv_v2", rows: [], [field]: Array(MAXIMUM_GSC_OBSERVATIONS + 1).fill(null) }, `/v1/projects/${projectId}/gsc-imports`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "gsc_batch_too_large", message: expect.stringContaining("250,001") } });
    expect(statements).not.toContain("BEGIN");
  });

  it("preserves authentication and CORS on HTTP/2", async () => {
    const unauthorized = await request(file(`${header}\nquery,,1,10,10%,8`), undefined, { authorization: "" });
    expect(unauthorized.status).toBe(401);
    const preflight = await request(undefined, `/v1/projects/${projectId}/gsc-workbook`, { ":method": "OPTIONS", origin: "https://seer.example.dev" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://seer.example.dev");
    expect((await request(undefined, "/readyz")).body).toMatchObject({ status: "ready" });
  });

  it("bounds concurrent imports and releases capacity after completion", async () => {
    let release: () => void = () => undefined;
    let bothStarted: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let writes = 0;
    const originalQuery = config.pool!.query.bind(config.pool);
    const heldQuery = async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO gsc_uploads")) {
        if (++writes === 2) bothStarted();
        await waiting;
      }
      return originalQuery(sql, values);
    };
    Object.assign(config.pool!, { connect: async () => ({ query: heldQuery, release: vi.fn() }) });
    const first = request(file(`${header}\nfirst,,1,10,10%,8`));
    const second = request(file(`${header}\nsecond,,1,10,10%,8`));
    try {
      await started;
      const busy = await request(file(`${header}\nthird,,1,10,10%,8`));
      expect(busy.status).toBe(429);
      expect(busy.body).toMatchObject({ error: { code: "gsc_upload_busy", message: expect.stringContaining("then retry") } });
    } finally {
      release();
      expect((await first).status).toBe(201);
      expect((await second).status).toBe(201);
    }
    expect((await request(file(`${header}\nretry,,1,10,10%,8`))).status).toBe(201);
  });

  it("keeps HTTP/1 health probes available without exposing application routes", async () => {
    const health = createApiHealthServer(config);
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const healthOrigin = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${healthOrigin}/readyz`)).json()).toMatchObject({ status: "ready" });
      expect((await fetch(`${healthOrigin}/healthz`)).status).toBe(200);
      expect((await fetch(`${healthOrigin}/v1/me`)).status).toBe(404);
    } finally {
      health.closeAllConnections();
      await new Promise<void>((resolve) => health.close(() => resolve()));
    }
  });
});
