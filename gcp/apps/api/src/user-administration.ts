import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import type { IdentityAccountAdmin } from "./identity-provisioning.js";
import type { AppRole } from "./profile.js";

const VALID_ROLES = new Set<AppRole>([
  "super_admin",
  "admin",
  "user",
  "view_only",
]);

interface CallerAccessRow {
  approval_status: string;
  role: AppRole | null;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  const parsed = requireString(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return parsed;
}

function role(value: unknown): AppRole {
  const parsed = requireString(value, "role", 32) as AppRole;
  if (!VALID_ROLES.has(parsed)) {
    throw new HttpError(400, "invalid_request", "role is invalid.");
  }
  return parsed;
}

function clientIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new HttpError(400, "invalid_request", "clientIds is invalid.");
  }
  return [...new Set(value.map((entry, index) => uuid(entry, `clientIds[${index}]`)))];
}

async function callerRole(
  pool: DatabasePool | PoolClient,
  caller: AuthenticatedUser,
): Promise<AppRole> {
  const result = await pool.query<CallerAccessRow>(
    `
      SELECT
        profile.approval_status,
        (
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
        ) AS role
      FROM profiles AS profile
      WHERE profile.user_id = $1
    `,
    [caller.id],
  );
  const access = result.rows[0];
  if (
    access?.approval_status !== "approved" ||
    (access.role !== "admin" && access.role !== "super_admin")
  ) {
    throw new HttpError(403, "administrator_required", "Administrator access is required.");
  }
  return access.role;
}

function assertElevatedRoleAssignment(caller: AppRole, nextRole: AppRole): void {
  if (
    caller !== "super_admin" &&
    (nextRole === "admin" || nextRole === "super_admin")
  ) {
    throw new HttpError(
      403,
      "super_administrator_required",
      "Only a super administrator can assign an administrator role.",
    );
  }
}

async function protectLastSuperAdmin(
  client: PoolClient,
  targetUserId: string,
  nextRole: AppRole | null,
): Promise<void> {
  const target = await client.query<{ role: AppRole }>(
    `
      SELECT role
      FROM user_roles
      WHERE user_id = $1
        AND role = 'super_admin'
      FOR UPDATE
    `,
    [targetUserId],
  );
  if (target.rows.length === 0 || nextRole === "super_admin") return;
  const count = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM user_roles
      WHERE role = 'super_admin'
    `,
  );
  if (Number(count.rows[0]?.count ?? "0") <= 1) {
    throw new HttpError(
      409,
      "last_super_administrator",
      "The final super administrator cannot be removed.",
    );
  }
}

async function replaceRole(
  client: PoolClient,
  targetUserId: string,
  nextRole: AppRole,
): Promise<void> {
  await protectLastSuperAdmin(client, targetUserId, nextRole);
  await client.query("DELETE FROM user_roles WHERE user_id = $1", [targetUserId]);
  const result = await client.query(
    `
      INSERT INTO user_roles (user_id, role)
      SELECT user_id, $2
      FROM profiles
      WHERE user_id = $1
      RETURNING user_id
    `,
    [targetUserId, nextRole],
  );
  if (result.rowCount !== 1) {
    throw new HttpError(404, "user_not_found", "The user was not found.");
  }
}

async function grantClients(
  client: PoolClient,
  targetUserId: string,
  ids: readonly string[],
): Promise<void> {
  for (const clientId of ids) {
    const result = await client.query(
      `
        INSERT INTO user_client_access (user_id, client_id, access_role)
        SELECT $1, id, 'viewer'
        FROM clients
        WHERE id = $2
        ON CONFLICT (user_id, client_id)
        DO NOTHING
        RETURNING client_id
      `,
      [targetUserId, clientId],
    );
    if (result.rowCount !== 1) {
      const existing = await client.query(
        `
          SELECT 1
          FROM user_client_access
          WHERE user_id = $1
            AND client_id = $2
        `,
        [targetUserId, clientId],
      );
      if (existing.rowCount !== 1) {
        throw new HttpError(404, "client_not_found", "A selected client was not found.");
      }
    }
  }
}

export async function listUsers(
  pool: DatabasePool,
  caller: AuthenticatedUser,
): Promise<Record<string, unknown>> {
  await callerRole(pool, caller);
  const result = await pool.query(
    `
      SELECT
        profile.user_id AS id,
        profile.email,
        profile.full_name,
        profile.created_at,
        profile.last_authenticated_at AS last_sign_in_at,
        profile.approval_status,
        profile.approved_at,
        profile.approved_by,
        profile.rejection_reason,
        role.role,
        COALESCE(access.client_ids, ARRAY[]::uuid[]) AS client_ids
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
      LEFT JOIN LATERAL (
        SELECT array_agg(user_access.client_id ORDER BY user_access.client_id) AS client_ids
        FROM user_client_access AS user_access
        WHERE user_access.user_id = profile.user_id
      ) AS access ON true
      ORDER BY profile.created_at DESC, profile.user_id
    `,
  );
  return { users: result.rows };
}

export async function inviteUser(
  pool: DatabasePool,
  identity: IdentityAccountAdmin,
  caller: AuthenticatedUser,
  body: unknown,
  continueUrl: string,
): Promise<Record<string, unknown>> {
  const callerAppRole = await callerRole(pool, caller);
  const record = bodyRecord(body);
  const email = requireString(record.email, "email", 254).toLowerCase();
  const fullName = requireString(record.fullName, "fullName", 200);
  const nextRole = role(record.role ?? "view_only");
  const grants = clientIds(record.clientIds);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "invalid_email", "email is invalid.");
  }
  assertElevatedRoleAssignment(callerAppRole, nextRole);

  const targetUserId = randomUUID();
  await identity.createAccount({
    displayName: fullName,
    email,
    localId: targetUserId,
  });
  try {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO profiles (
            user_id,
            email,
            full_name,
            identity_provider,
            identity_email_verified,
            approval_status,
            approved_at,
            approved_by
          )
          VALUES ($1, $2, $3, 'identity-platform', false, 'approved', now(), $4)
        `,
        [targetUserId, email, fullName, caller.id],
      );
      await replaceRole(client, targetUserId, nextRole);
      await grantClients(client, targetUserId, grants);
    });
    await identity.sendPasswordResetEmail(email, continueUrl);
  } catch (error) {
    await pool.query("DELETE FROM profiles WHERE user_id = $1", [targetUserId]).catch(() => undefined);
    await identity.deleteAccount(targetUserId).catch(() => undefined);
    throw error;
  }
  return { email, id: targetUserId };
}

export async function setUserRole(
  pool: DatabasePool,
  caller: AuthenticatedUser,
  targetUserId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const callerAppRole = await callerRole(pool, caller);
  if (callerAppRole !== "super_admin") {
    throw new HttpError(
      403,
      "super_administrator_required",
      "Only a super administrator can change roles.",
    );
  }
  const nextRole = role(bodyRecord(body).role);
  await withTransaction(pool, (client) => replaceRole(client, targetUserId, nextRole));
  return { id: targetUserId, role: nextRole };
}

export async function decideUserApproval(
  pool: DatabasePool,
  caller: AuthenticatedUser,
  targetUserId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const callerAppRole = await callerRole(pool, caller);
  const record = bodyRecord(body);
  const decision = requireString(record.decision, "decision", 16);
  if (decision !== "approve" && decision !== "reject") {
    throw new HttpError(400, "invalid_request", "decision is invalid.");
  }
  const nextRole = record.role === undefined ? null : role(record.role);
  if (nextRole) assertElevatedRoleAssignment(callerAppRole, nextRole);
  const grants = clientIds(record.clientIds);
  const rejectionReason =
    record.rejectionReason === undefined || record.rejectionReason === null
      ? null
      : requireString(record.rejectionReason, "rejectionReason", 1_000);

  await withTransaction(pool, async (client) => {
    const result = await client.query(
      `
        UPDATE profiles
        SET
          approval_status = $2,
          approved_at = now(),
          approved_by = $3,
          rejection_reason = $4
        WHERE user_id = $1
        RETURNING user_id
      `,
      [
        targetUserId,
        decision === "approve" ? "approved" : "rejected",
        caller.id,
        decision === "reject" ? rejectionReason : null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new HttpError(404, "user_not_found", "The user was not found.");
    }
    if (decision === "approve" && nextRole) {
      await replaceRole(client, targetUserId, nextRole);
    }
    if (decision === "approve") {
      await grantClients(client, targetUserId, grants);
    }
  });

  return { decision, id: targetUserId };
}

export async function replaceUserClientAccess(
  pool: DatabasePool,
  caller: AuthenticatedUser,
  targetUserId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await callerRole(pool, caller);
  const grants = clientIds(bodyRecord(body).clientIds);
  await withTransaction(pool, async (client) => {
    const target = await client.query(
      "SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE",
      [targetUserId],
    );
    if (target.rowCount !== 1) {
      throw new HttpError(404, "user_not_found", "The user was not found.");
    }
    await client.query("DELETE FROM user_client_access WHERE user_id = $1", [
      targetUserId,
    ]);
    await grantClients(client, targetUserId, grants);
  });
  return { clientIds: grants, id: targetUserId };
}

export async function deleteUser(
  pool: DatabasePool,
  identity: IdentityAccountAdmin,
  caller: AuthenticatedUser,
  targetUserId: string,
): Promise<Record<string, unknown>> {
  if ((await callerRole(pool, caller)) !== "super_admin") {
    throw new HttpError(
      403,
      "super_administrator_required",
      "Only a super administrator can delete users.",
    );
  }
  if (caller.id === targetUserId) {
    throw new HttpError(400, "self_delete_forbidden", "You cannot delete your own account.");
  }
  await withTransaction(pool, (client) =>
    protectLastSuperAdmin(client, targetUserId, null),
  );
  await identity.deleteAccount(targetUserId);
  const result = await pool.query(
    "DELETE FROM profiles WHERE user_id = $1 RETURNING user_id",
    [targetUserId],
  );
  if (result.rowCount !== 1) {
    throw new HttpError(404, "user_not_found", "The user was not found.");
  }
  return { id: targetUserId };
}
