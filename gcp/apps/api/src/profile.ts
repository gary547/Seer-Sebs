import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";

export type AppRole = "super_admin" | "admin" | "user" | "view_only";
export type ApprovalStatus = "pending" | "approved" | "rejected";

interface ProfileRow {
  approval_status: ApprovalStatus;
  created_at: Date;
  email: string;
  full_name: string | null;
  identity_email_verified: boolean;
  notify_url_monitor: boolean;
  rejection_reason: string | null;
  role: AppRole | null;
  theme_preference: "dark" | "light";
  user_id: string;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

export async function getCurrentProfile(
  pool: DatabasePool,
  user: AuthenticatedUser,
): Promise<Record<string, unknown>> {
  const result = await pool.query<ProfileRow>(
    `
      SELECT
        profile.user_id,
        profile.email,
        profile.full_name,
        profile.approval_status,
        profile.rejection_reason,
        profile.theme_preference,
        profile.notify_url_monitor,
        profile.identity_email_verified,
        profile.created_at,
        role.role
      FROM profiles AS profile
      LEFT JOIN LATERAL (
        SELECT user_role.role
        FROM user_roles AS user_role
        WHERE user_role.user_id = profile.user_id
        ORDER BY CASE user_role.role
          WHEN 'super_admin' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'user' THEN 3
          WHEN 'view_only' THEN 4
        END
        LIMIT 1
      ) AS role ON true
      WHERE profile.user_id = $1
    `,
    [user.id],
  );
  const profile = result.rows[0];
  if (!profile) {
    throw new HttpError(404, "profile_not_found", "The user profile was not found.");
  }

  return {
    approvalStatus: profile.approval_status,
    createdAt: profile.created_at.toISOString(),
    email: profile.email,
    emailVerified: profile.identity_email_verified,
    fullName: profile.full_name,
    id: profile.user_id,
    notifyUrlMonitor: profile.notify_url_monitor,
    rejectionReason: profile.rejection_reason,
    role: profile.role,
    themePreference: profile.theme_preference,
  };
}

export async function assertApprovedUser(
  pool: DatabasePool,
  user: AuthenticatedUser,
): Promise<void> {
  const result = await pool.query<{ approval_status: ApprovalStatus }>(
    `
      SELECT approval_status
      FROM profiles
      WHERE user_id = $1
    `,
    [user.id],
  );
  const profile = result.rows[0];
  if (!profile) {
    throw new HttpError(403, "profile_required", "A user profile is required.");
  }
  if (profile.approval_status !== "approved") {
    throw new HttpError(
      403,
      profile.approval_status === "rejected"
        ? "account_rejected"
        : "account_pending_approval",
      profile.approval_status === "rejected"
        ? "This account request was rejected."
        : "This account is awaiting approval.",
    );
  }
}

export async function updateCurrentProfile(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const updates: string[] = [];
  const values: unknown[] = [user.id];

  if ("fullName" in record) {
    const fullName =
      record.fullName === null || record.fullName === ""
        ? null
        : requireString(record.fullName, "fullName", 200);
    values.push(fullName);
    updates.push(`full_name = $${values.length}`);
  }
  if ("themePreference" in record) {
    if (record.themePreference !== "light" && record.themePreference !== "dark") {
      throw new HttpError(400, "invalid_request", "themePreference is invalid.");
    }
    values.push(record.themePreference);
    updates.push(`theme_preference = $${values.length}`);
  }
  if ("notifyUrlMonitor" in record) {
    if (typeof record.notifyUrlMonitor !== "boolean") {
      throw new HttpError(400, "invalid_request", "notifyUrlMonitor is invalid.");
    }
    values.push(record.notifyUrlMonitor);
    updates.push(`notify_url_monitor = $${values.length}`);
  }
  if (updates.length === 0) {
    throw new HttpError(400, "invalid_request", "No supported profile fields were supplied.");
  }

  const result = await pool.query(
    `
      UPDATE profiles
      SET ${updates.join(", ")}
      WHERE user_id = $1
      RETURNING user_id
    `,
    values,
  );
  if (result.rowCount !== 1) {
    throw new HttpError(404, "profile_not_found", "The user profile was not found.");
  }
  return getCurrentProfile(pool, user);
}
