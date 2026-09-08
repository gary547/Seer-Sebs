import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const projectId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const keywordId = "00000000-0000-4000-8000-000000000005";
let dirty = false;
let active = false;
let complete = true;
let allowed = true;
let latestRun = true;
let executed: Array<{ sql: string; values: unknown[] }>;

describe("complete calculation export API", () => {
  let server: ReturnType<typeof createApiServer>;
  let url: string;
  beforeEach(async () => {
    dirty = false; active = false; complete = true; allowed = true; latestRun = true; executed = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      sql = sql.replace(/\s+/g, " ").trim();
      executed.push({ sql, values });
      let rows: unknown[];
      if (sql.includes("SELECT approval_status")) rows = [{ approval_status: "approved" }];
      else if (sql.includes("SELECT client_id FROM navigator_projects")) rows = [{ client_id: projectId }];
      else if (sql.includes("FROM user_roles AS user_role")) rows = [{ role: allowed ? "admin" : "view_only" }];
      else if (sql.includes("FROM user_client_access")) rows = [];
      else if (sql.includes("SELECT run.id")) rows = latestRun ? [{ id: runId, completed_at: new Date("2026-09-08T09:00:00Z"), currency: "GBP", dirty, active }] : [];
      else if (sql.includes("WITH export_keywords")) rows = ["conservative", "realistic", "stretch"].map((scenario) => ({
        keyword_id: keywordId, keyword: 'keyword, with "quotes"', scenario, category: "Pharmacy", search_intent: "commercial",
        har_model_version: "har-v2", revenue_model_version: complete ? "revenue-v2" : null,
        link_power_score: "0", content_fit_scope: "domain_fallback", content_fit_source: "openrouter:z-ai/glm-5.3-flash", expected_incremental_annual: "125.25",
        har_explanation: { authorityProvider: "dataforseo" }, warnings: [],
      }));
      else throw new Error(`Unexpected query: ${sql}`);
      return { rows, rowCount: rows.length };
    });
    server = createApiServer({ pool: { query } as unknown as DatabasePool,
      authenticateRequest: async () => ({ id: "00000000-0000-4000-8000-000000000001", email: "export@example.dev" }),
      objectStore: { assertReady: async () => undefined, delete: async () => undefined, get: async () => Buffer.alloc(0), put: async () => undefined },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/${projectId}/calculation-export`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("exports all scenarios with numeric zero, provenance and bounded keyset pagination", async () => {
    const response = await fetch(`${url}?limit=1`);
    expect(response.status).toBe(200);
    const page = await response.json() as { rows: Array<Record<string, unknown>>; columns: string[] };
    expect(page).toMatchObject({ keywordCount: 1, nextAfter: keywordId, runId });
    expect(page.rows).toHaveLength(3);
    expect(page.rows[0]).toMatchObject({ link_power_score: 0, expected_incremental_annual: 125.25, content_fit_scope: "domain_fallback", content_fit_source: "openrouter:z-ai/glm-5.3-flash" });
    expect(page.columns).toContain("har_explanation");
    expect(executed.find(({ sql }) => sql.includes("WITH export_keywords"))?.values).toEqual([projectId, runId, null, 1]);
  });
  it.each(["limit=501", "limit=0", "after=bad", `after=${keywordId}`, "runId=bad"])("rejects invalid pagination: %s", async (query) => {
    expect((await fetch(`${url}?${query}`)).status).toBe(400);
  });
  it("rejects exports of missing or incomplete results", async () => {
    latestRun = false; expect((await fetch(url)).status).toBe(409);
    latestRun = true; complete = false; expect((await fetch(url)).status).toBe(409);
  });
  it("rejects changed inputs, active runs and a run switch between pages", async () => {
    dirty = true; expect((await fetch(url)).status).toBe(409);
    dirty = false; active = true; expect((await fetch(url)).status).toBe(409);
    active = false; expect((await fetch(`${url}?runId=${keywordId}`)).status).toBe(409);
  });
  it("enforces project access before exporting", async () => {
    allowed = false; expect((await fetch(url)).status).toBe(404);
    expect(executed.some(({ sql }) => sql.includes("WITH export_keywords"))).toBe(false);
  });
});
