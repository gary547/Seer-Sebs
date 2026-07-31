import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  decideUserApproval,
  replaceUserClientAccess,
  setUserRole,
} from "../src/user-administration.js";

const caller = {
  email: "admin@example.com",
  id: "00000000-0000-4000-8000-000000000001",
};
const targetUserId = "00000000-0000-4000-8000-000000000002";

function poolWithRole(
  callerRole: "admin" | "super_admin",
  clientQuery: ReturnType<typeof vi.fn>,
): DatabasePool {
  return {
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({
      rows: [{ approval_status: "approved", role: callerRole }],
    })),
  } as unknown as DatabasePool;
}

describe("user administration", () => {
  it("allows a super administrator to replace a user's single role", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT role")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO user_roles")) {
        return { rowCount: 1, rows: [{ user_id: targetUserId }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(
      setUserRole(
        poolWithRole("super_admin", clientQuery),
        caller,
        targetUserId,
        { role: "admin" },
      ),
    ).resolves.toEqual({ id: targetUserId, role: "admin" });

    expect(
      clientQuery.mock.calls.some((call) =>
        String(call[0]).includes("DELETE FROM user_roles"),
      ),
    ).toBe(true);
  });

  it("prevents an administrator from assigning elevated roles", async () => {
    const pool = poolWithRole("admin", vi.fn());

    await expect(
      decideUserApproval(pool, caller, targetUserId, {
        decision: "approve",
        role: "admin",
      }),
    ).rejects.toMatchObject({
      code: "super_administrator_required",
      statusCode: 403,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("does not remove the final super administrator", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT role")) {
        return { rowCount: 1, rows: [{ role: "super_admin" }] };
      }
      if (sql.includes("SELECT count")) {
        return { rowCount: 1, rows: [{ count: "1" }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(
      setUserRole(
        poolWithRole("super_admin", clientQuery),
        caller,
        targetUserId,
        { role: "user" },
      ),
    ).rejects.toMatchObject({
      code: "last_super_administrator",
      statusCode: 409,
    });
  });

  it("replaces client access atomically for an existing user", async () => {
    const clientId = "00000000-0000-4000-8000-000000000003";
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM profiles")) {
        return { rowCount: 1, rows: [{ "?column?": 1 }] };
      }
      if (sql.includes("INSERT INTO user_client_access")) {
        return { rowCount: 1, rows: [{ client_id: clientId }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(
      replaceUserClientAccess(
        poolWithRole("admin", clientQuery),
        caller,
        targetUserId,
        { clientIds: [clientId, clientId] },
      ),
    ).resolves.toEqual({
      clientIds: [clientId],
      id: targetUserId,
    });

    expect(
      clientQuery.mock.calls.some((call) =>
        String(call[0]).includes("DELETE FROM user_client_access"),
      ),
    ).toBe(true);
  });
});
