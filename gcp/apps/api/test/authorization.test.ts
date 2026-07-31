import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  assertClientAccess,
  assertProjectAccessByRole,
} from "../src/authorization.js";

const userId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";

describe("tenant authorization", () => {
  it("does not reveal a client to a view-only user without explicit access", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "view_only" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const pool = { query } as unknown as DatabasePool;

    await expect(
      assertClientAccess(pool, userId, clientId, true),
    ).rejects.toMatchObject({
      code: "client_not_found",
      statusCode: 404,
    });
  });

  it("returns a project-scoped not-found response when client access is absent", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ client_id: clientId }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "view_only" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const pool = { query } as unknown as DatabasePool;

    await expect(
      assertProjectAccessByRole(pool, userId, projectId),
    ).rejects.toMatchObject({
      code: "project_not_found",
      statusCode: 404,
    });
  });

  it("keeps explicit view-only client access read-only", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "view_only" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] });
    const pool = { query } as unknown as DatabasePool;

    await expect(
      assertClientAccess(pool, userId, clientId, true),
    ).rejects.toMatchObject({
      code: "write_access_required",
      statusCode: 403,
    });
  });
});
