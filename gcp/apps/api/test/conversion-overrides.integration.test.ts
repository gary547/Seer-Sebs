import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { createApiServer } from "../src/server.js";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const otherProjectId = "00000000-0000-4000-8000-000000000003";
const clientId = "00000000-0000-4000-8000-000000000004";
const overrideId = "00000000-0000-4000-8000-000000000005";

function result(rows: unknown[]) {
  return { rowCount: rows.length, rows };
}

describe("project conversion categories", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;
  let insertedValues: unknown[][];
  let dirtiedProjects: unknown[][];
  let existingCategoryOverride: string | null;

  beforeEach(async () => {
    insertedValues = [];
    dirtiedProjects = [];
    existingCategoryOverride = null;
    const query = vi.fn(async (sqlValue: string, values: unknown[] = []) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return result([]);
      if (sql.includes("SELECT approval_status FROM profiles")) return result([{ approval_status: "approved" }]);
      if (sql.includes("FROM user_roles AS user_role")) return result([{ role: "admin" }]);
      if (sql.includes("SELECT client_id FROM navigator_projects")) {
        return result([projectId, otherProjectId].includes(String(values[0])) ? [{ client_id: clientId }] : []);
      }
      if (sql.includes("FROM project_conversion_overrides AS override")) {
        return result(values[0] === projectId ? [{ id: overrideId, project_id: projectId, scope_type: "category", scope_value: "Refrigeration" }] : []);
      }
      if (sql.includes("SELECT scope_value FROM project_conversion_overrides")) {
        return result(existingCategoryOverride ? [{ scope_value: existingCategoryOverride }] : []);
      }
      if (sql.includes("FROM keywords") && sql.includes("GROUP BY category")) {
        return result(values[0] === projectId ? [
          { category: "Refrigeration", keyword_count: 3 },
          { category: " refrigeration  ", keyword_count: 2 },
          { category: "Ovens", keyword_count: 4 },
        ] : [{ category: "Books", keyword_count: 7 }]);
      }
      if (sql.includes("INSERT INTO project_conversion_overrides")) {
        insertedValues.push(values);
        return result([{ id: values[0], project_id: values[1], scope_type: values[2], scope_value: values[3] }]);
      }
      if (sql.includes("UPDATE navigator_projects SET inputs_dirty")) {
        dirtiedProjects.push(values);
        return result([]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query } as unknown as DatabasePool;
    server = createApiServer({
      authenticateRequest: vi.fn(async () => ({ email: "admin@example.com", id: userId })),
      objectStore: {
        assertReady: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        get: vi.fn(async () => Buffer.alloc(0)),
        put: vi.fn(async () => undefined),
      },
      pool,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns kept-keyword category counts for the requested project only", async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/conversion-overrides`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      categories: [
        { category: "Ovens", keywordCount: 4 },
        { category: "Refrigeration", keywordCount: 5 },
      ],
      overrides: [{ id: overrideId, scope_value: "Refrigeration" }],
    });

    const other = await fetch(`${baseUrl}/v1/projects/${otherProjectId}/conversion-overrides`);
    expect(other.status).toBe(200);
    await expect(other.json()).resolves.toEqual({
      categories: [{ category: "Books", keywordCount: 7 }],
      overrides: [],
    });
  });

  it("saves the canonical category and rejects categories absent from kept keywords", async () => {
    const send = (scopeValue: string) => fetch(`${baseUrl}/v1/conversion-overrides`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        scope_type: "category",
        scope_value: scopeValue,
        conversion_rate: 0.025,
        average_order_value: 400,
        confidence: "high",
        note: "Client supplied",
      }),
    });

    const accepted = await send("  REFRIGERATION ");
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ scope_value: "Refrigeration" });
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.[3]).toBe("Refrigeration");
    expect(dirtiedProjects).toEqual([[projectId]]);

    existingCategoryOverride = " refrigeration  ";
    const duplicate = await send("Refrigeration");
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: "conversion_override_conflict" } });

    const rejected = await send("Laundry");
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "unknown_category" } });
    expect(insertedValues).toHaveLength(1);
    expect(dirtiedProjects).toHaveLength(1);
  });
});
