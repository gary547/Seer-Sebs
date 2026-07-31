import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  createClient,
  createProject,
  listProjects,
  markProjectDirty,
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
});
