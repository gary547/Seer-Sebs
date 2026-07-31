import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import {
  assertApprovedUser,
  getCurrentProfile,
  updateCurrentProfile,
} from "../src/profile.js";

const user = {
  email: "user@example.com",
  id: "00000000-0000-4000-8000-000000000001",
};

describe("application identity profile", () => {
  it("returns the highest role and application preferences", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            approval_status: "approved",
            created_at: new Date("2026-07-30T08:00:00.000Z"),
            email: user.email,
            full_name: "Test User",
            identity_email_verified: true,
            notify_url_monitor: true,
            rejection_reason: null,
            role: "admin",
            theme_preference: "dark",
            user_id: user.id,
          },
        ],
      })),
    } as unknown as DatabasePool;

    await expect(getCurrentProfile(pool, user)).resolves.toMatchObject({
      approvalStatus: "approved",
      emailVerified: true,
      fullName: "Test User",
      id: user.id,
      role: "admin",
      themePreference: "dark",
    });
  });

  it("blocks pending users from application routes", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ approval_status: "pending" }],
      })),
    } as unknown as DatabasePool;

    await expect(assertApprovedUser(pool, user)).rejects.toMatchObject({
      code: "account_pending_approval",
      statusCode: 403,
    });
  });

  it("only accepts supported self-service profile fields", async () => {
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as unknown as DatabasePool;

    await expect(
      updateCurrentProfile(pool, user, { approvalStatus: "approved" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      statusCode: 400,
    });
  });
});
