import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AppRole } from "./profile.js";

interface RoleRow {
  role: AppRole | null;
}

export async function getUserRole(
  database: DatabasePool | PoolClient,
  userId: string,
): Promise<AppRole | null> {
  const result = await database.query<RoleRow>(
    `
      SELECT user_role.role
      FROM user_roles AS user_role
      WHERE user_role.user_id = $1
      ORDER BY CASE user_role.role
        WHEN 'super_admin' THEN 1
        WHEN 'admin' THEN 2
        WHEN 'user' THEN 3
        WHEN 'view_only' THEN 4
      END
      LIMIT 1
    `,
    [userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function assertClientAccess(
  database: DatabasePool | PoolClient,
  userId: string,
  clientId: string,
  write = false,
): Promise<void> {
  const role = await getUserRole(database, userId);
  if (role === "super_admin" || role === "admin" || role === "user") return;
  const result = await database.query(
    `
      SELECT 1
      FROM user_client_access
      WHERE user_id = $1
        AND client_id = $2
    `,
    [userId, clientId],
  );
  if (result.rowCount !== 1) {
    throw new HttpError(404, "client_not_found", "Client not found.");
  }
  if (write) {
    throw new HttpError(403, "write_access_required", "Write access is required.");
  }
}

export async function assertProjectAccessByRole(
  database: DatabasePool | PoolClient,
  userId: string,
  projectId: string,
  write = false,
): Promise<{ client_id: string }> {
  const result = await database.query<{ client_id: string }>(
    `
      SELECT client_id
      FROM navigator_projects
      WHERE id = $1
        AND archived_at IS NULL
    `,
    [projectId],
  );
  const project = result.rows[0];
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  try {
    await assertClientAccess(database, userId, project.client_id, write);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.statusCode === 404 &&
      error.code === "client_not_found"
    ) {
      throw new HttpError(404, "project_not_found", "Project not found.");
    }
    throw error;
  }
  return project;
}

export async function assertAdministrator(
  database: DatabasePool | PoolClient,
  userId: string,
): Promise<AppRole> {
  const role = await getUserRole(database, userId);
  if (role !== "admin" && role !== "super_admin") {
    throw new HttpError(403, "administrator_required", "Administrator access is required.");
  }
  return role;
}

export async function assertWriteAccess(
  database: DatabasePool | PoolClient,
  userId: string,
): Promise<AppRole> {
  const role = await getUserRole(database, userId);
  if (role !== "user" && role !== "admin" && role !== "super_admin") {
    throw new HttpError(403, "write_access_required", "Write access is required.");
  }
  return role;
}
