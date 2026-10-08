import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const runId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const canonicalId = "00000000-0000-4000-8000-000000000004";
const memberId = "00000000-0000-4000-8000-000000000005";

describe("SERP resolution API", () => {
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  let role: string;
  let input: Record<string, unknown>;
  let idle: boolean;
  let active: boolean;
  let writes: number;
  let archived: boolean;
  let failedStage: string;
  let keptCount: string;

  beforeEach(async () => {
    role = "admin"; input = { projectId, mode: "full" }; idle = true; active = false; writes = 0; archived = false; failedStage = "serp-collection";
    keptCount = "3";
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      sql = sql.replace(/\s+/g, " ");
      let rows: unknown[] = [];
      if (sql.includes("SELECT approval_status")) rows = [{ approval_status: "approved" }];
      else if (sql.includes("FROM user_roles AS user_role")) rows = [{ role }];
      else if (sql.includes("SELECT client_id FROM navigator_projects")) rows = archived ? [] : [{ client_id: projectId }];
      else if (sql.includes("SELECT run.input, run.status")) rows = [{ input, status: "failed", state: "failed", failed_stage: failedStage, created_at: new Date("2026-10-08T12:00:00Z") }];
      else if (sql.includes("FROM provider_work_items AS work")) rows = [
        { id: canonicalId, text: "empty query", normalisedText: "empty query", sourceKeywordId: canonicalId, query: "empty query" },
        { id: memberId, text: "query variant", normalisedText: "query variant", sourceKeywordId: canonicalId, query: "empty query" },
      ];
      else if (sql.includes("SELECT count(*)::text AS count,")) rows = [{ count: "1", kept_count: keptCount }];
      else if (sql.includes("AS idle")) rows = [{ idle }];
      else if (sql.includes("SELECT 1 FROM pipeline_runs")) rows = active ? [{}] : [];
      else if (sql.includes("AS checkpoint")) rows = [{ checkpoint: { lastDirtyAt: null, latestUploadAt: null, clientChangedAt: null } }];
      else if (sql.includes("UPDATE pipeline_runs SET input")) { writes++; input = { ...input, forecastScope: JSON.parse(String(values[1])) }; rows = [{}]; }
      else if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim()) && !sql.includes("pg_advisory_xact_lock") && !sql.includes("FOR UPDATE")) throw new Error("Unexpected test database query.");
      return { rows, rowCount: rows.length };
    });
    const connection = { query, release: vi.fn() };
    server = createApiServer({ pool: { query, connect: vi.fn(async () => connection) } as unknown as DatabasePool,
      authenticateRequest: async () => ({ id: userId, email: "operator@example.test" }),
      objectStore: { assertReady: async () => undefined, delete: async () => undefined, get: async () => Buffer.alloc(0), put: async () => undefined },
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  const body = (ids: string[]) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keywordIds: ids }) });

  it("reviews inherited variants and records the exact operator-approved scope idempotently", async () => {
    const review = await fetch(`${base}/v1/pipeline-runs/${runId}/serp-resolution`);
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ runId, projectId, queryCount: 1, keywordCount: 2, approved: false });
    const approved = await fetch(`${base}/v1/pipeline-runs/${runId}/serp-resolution`, body([canonicalId, memberId]));
    expect(approved.status).toBe(200);
    const saved = structuredClone(input);
    expect(saved.forecastScope).toMatchObject({ reason: "dataforseo_no_results", approvedBy: userId, queries: ["empty query"] });
    const repeated = await fetch(`${base}/v1/pipeline-runs/${runId}/serp-resolution`, body([canonicalId, memberId]));
    expect(await repeated.json()).toMatchObject({ approved: true, idempotent: true });
    expect(input).toEqual(saved);
    expect(writes).toBe(1);
  });

  it.each(["user", "view_only"])("rejects %s operators before reading or changing affected queries", async normalRole => {
    role = normalRole;
    expect((await fetch(`${base}/v1/pipeline-runs/${runId}/serp-resolution`)).status).toBe(403);
    expect((await fetch(`${base}/v1/pipeline-runs/${runId}/serp-resolution`, body([canonicalId, memberId]))).status).toBe(403);
    expect(writes).toBe(0);
  });

  it("rejects partial, unrelated, active, archived and draining scopes without mutation", async () => {
    const route = `${base}/v1/pipeline-runs/${runId}/serp-resolution`;
    expect((await fetch(route, body([canonicalId]))).status).toBe(409);
    expect((await fetch(route, body([canonicalId, projectId]))).status).toBe(409);
    idle = false; expect((await fetch(route, body([canonicalId, memberId]))).status).toBe(409);
    idle = true; active = true; expect((await fetch(route, body([canonicalId, memberId]))).status).toBe(409);
    active = false; failedStage = "backlinks"; expect((await fetch(route)).status).toBe(409);
    failedStage = "serp-collection"; archived = true; expect((await fetch(route, body([canonicalId, memberId]))).status).toBe(404);
    archived = false; keptCount = "2"; expect((await fetch(route, body([canonicalId, memberId]))).status).toBe(409);
    expect(writes).toBe(0);
  });

  it("rejects externally supplied scope metadata at pipeline creation", async () => {
    const response = await fetch(`${base}/v1/pipeline-runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, mode: "full", forecastScope: {} }),
    });
    expect(response.status).toBe(400);
    expect(writes).toBe(0);
  });
});
