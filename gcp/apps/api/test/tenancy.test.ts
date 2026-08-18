import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  createClient,
  createProject,
  listProjects,
  markProjectDirty,
  updateClientBrandTerms,
  updateProject,
} from "../src/tenancy.js";

const user = {
  email: "user@example.com",
  id: "00000000-0000-4000-8000-000000000001",
};
const clientId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";

describe("tenancy validation and authorization", () => {
  it("blocks view-only users from creating clients", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ role: "view_only" }],
      })),
    } as unknown as DatabasePool;

    await expect(
      createClient(pool, user, {
        companyName: "Forbidden",
        domain: "forbidden.example",
      }),
    ).rejects.toMatchObject({
      code: "write_access_required",
      statusCode: 403,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed project filters before issuing SQL", async () => {
    const pool = {
      query: vi.fn(),
    } as unknown as DatabasePool;

    await expect(listProjects(pool, user, "invalid")).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects reversed and impossible project seasonality", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as DatabasePool;

    await expect(
      createProject(pool, user, clientId, {
        projectName: "Invalid range",
        seasonalityEnd: "2026-02-01",
        seasonalityStart: "2026-03-01",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    await expect(
      updateProject(pool, user, projectId, {
        aov: null,
        categoryFocus: null,
        conversionRate: null,
        projectName: "Invalid date",
        seasonalityEnd: null,
        seasonalityStart: "2026-02-30",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("requires project conversion rates to use decimal storage", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as DatabasePool;

    await expect(
      createProject(pool, user, clientId, {
        conversionRate: 2.5,
        projectName: "Invalid conversion rate",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    await expect(
      updateProject(pool, user, projectId, {
        aov: null,
        categoryFocus: null,
        conversionRate: 2.5,
        projectName: "Invalid conversion rate",
        seasonalityEnd: null,
        seasonalityStart: null,
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("only accepts known dirty-state domains", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as DatabasePool;

    await expect(
      markProjectDirty(pool, user, projectId, {
        domains: ["keywords", "unknown"],
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("marks every live project dirty when client brand terms change", async () => {
    const transactionSql: string[] = [];
    const client = {
      query: vi.fn(async (sqlValue: string) => {
        const sql = sqlValue.replace(/\s+/g, " ").trim();
        transactionSql.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rowCount: 0, rows: [] };
        }
        if (sql.startsWith("UPDATE clients")) {
          return { rowCount: 1, rows: [{ id: clientId }] };
        }
        if (sql.startsWith("UPDATE navigator_projects")) {
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sqlValue: string) => {
        const sql = sqlValue.replace(/\s+/g, " ").trim();
        if (sql.includes("FROM user_roles AS user_role")) {
          return { rowCount: 1, rows: [{ role: "super_admin" }] };
        }
        if (sql.includes("FROM clients") && sql.includes("WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [{
              analytics_connected: false,
              archive_reason: null,
              archived_at: null,
              archived_by: null,
              brand_terms: ["PillTime", "Pill Time"],
              brand_type: null,
              campaign_type: null,
              company_name: "PillTime",
              created_at: new Date("2026-08-18T10:00:00Z"),
              domain: "pilltime.co.uk",
              domain_normalized: "pilltime.co.uk",
              gsc_connected: true,
              id: clientId,
              industry: "Pharmacy",
              logo_url: null,
              team_members: null,
              updated_at: new Date("2026-08-18T10:00:00Z"),
            }],
          };
        }
        if (sql.includes("FROM competitors")) return { rowCount: 0, rows: [] };
        if (sql.includes("FROM keyword_rules")) return { rowCount: 0, rows: [] };
        throw new Error(`Unexpected pool SQL: ${sql}`);
      }),
    } as unknown as DatabasePool;

    await expect(
      updateClientBrandTerms(pool, user, clientId, {
        brandTerms: ["PillTime", "Pill Time"],
      }),
    ).resolves.toMatchObject({
      brand_terms: ["PillTime", "Pill Time"],
      id: clientId,
    });
    expect(
      transactionSql.some((sql) =>
        sql.startsWith("UPDATE navigator_projects") &&
        sql.includes("inputs_dirty = true"),
      ),
    ).toBe(true);
  });
});
