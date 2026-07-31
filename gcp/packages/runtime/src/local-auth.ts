import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { PoolClient } from "pg";

import type { DatabasePool } from "./database.js";
import { withTransaction } from "./database.js";
import { bearerToken, HttpError, requireString } from "./http.js";

const SESSION_DURATION_MILLISECONDS = 8 * 60 * 60 * 1_000;
const PASSWORD_HASH_BYTES = 64;

interface LocalUserRow {
  email: string;
  id: string;
  password_hash: string;
  password_salt: string;
}

interface SessionUserRow {
  email: string;
  user_id: string;
}

export interface AuthenticatedUser {
  email: string;
  id: string;
}

export interface LocalAuthResult {
  expiresAt: string;
  token: string;
  user: AuthenticatedUser;
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }

  return value as Record<string, unknown>;
}

function normalizedCredentials(body: unknown): {
  email: string;
  fullName: string | null;
  password: string;
  role: "admin" | "super_admin" | "user" | "view_only";
} {
  const record = recordBody(body);
  const email = requireString(record.email, "email", 254).toLowerCase();
  const password = requireString(record.password, "password", 256);
  const fullName =
    record.fullName === undefined
      ? null
      : requireString(record.fullName, "fullName", 200);
  const role =
    record.role === undefined
      ? "user"
      : requireString(record.role, "role", 32);
  if (
    role !== "admin" &&
    role !== "super_admin" &&
    role !== "user" &&
    role !== "view_only"
  ) {
    throw new HttpError(400, "invalid_request", "role is invalid.");
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "invalid_email", "email is invalid.");
  }

  if (password.length < 10) {
    throw new HttpError(
      400,
      "weak_password",
      "password must contain at least 10 characters.",
    );
  }

  return { email, fullName, password, role };
}

function passwordHash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, PASSWORD_HASH_BYTES);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(
  client: PoolClient,
  user: AuthenticatedUser,
): Promise<LocalAuthResult> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MILLISECONDS);

  await client.query(
    `
      INSERT INTO local_auth_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)
    `,
    [tokenHash(token), user.id, expiresAt],
  );

  return {
    expiresAt: expiresAt.toISOString(),
    token,
    user,
  };
}

export async function registerLocalUser(
  pool: DatabasePool,
  body: unknown,
): Promise<LocalAuthResult> {
  const { email, fullName, password, role } = normalizedCredentials(body);
  const id = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const hash = passwordHash(password, salt).toString("hex");

  try {
    return await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO local_users (id, email, password_hash, password_salt)
          VALUES ($1, $2, $3, $4)
        `,
        [id, email, hash, salt],
      );
      await client.query(
        `
          INSERT INTO profiles (
            user_id,
            email,
            full_name,
            approval_status,
            approved_at
          )
          VALUES ($1, $2, $3, 'approved', now())
        `,
        [id, email, fullName],
      );
      await client.query(
        `
          INSERT INTO user_roles (user_id, role)
          VALUES ($1, $2)
        `,
        [id, role],
      );

      return createSession(client, { email, id });
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HttpError(409, "email_exists", "An account already exists for this email.");
    }

    throw error;
  }
}

export async function loginLocalUser(
  pool: DatabasePool,
  body: unknown,
): Promise<LocalAuthResult> {
  const { email, password } = normalizedCredentials(body);

  return withTransaction(pool, async (client) => {
    const result = await client.query<LocalUserRow>(
      `
        SELECT id, email, password_hash, password_salt
        FROM local_users
        WHERE email = $1
      `,
      [email],
    );
    const user = result.rows[0];

    if (!user) {
      throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
    }

    const expected = Buffer.from(user.password_hash, "hex");
    const actual = passwordHash(password, user.password_salt);

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
    }

    return createSession(client, { email: user.email, id: user.id });
  });
}

export async function authenticateLocalRequest(
  pool: DatabasePool,
  request: IncomingMessage,
): Promise<AuthenticatedUser> {
  const token = bearerToken(request);

  if (!token) {
    throw new HttpError(401, "authentication_required", "A bearer token is required.");
  }

  const result = await pool.query<SessionUserRow>(
    `
      SELECT sessions.user_id, users.email
      FROM local_auth_sessions AS sessions
      JOIN local_users AS users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.expires_at > now()
    `,
    [tokenHash(token)],
  );
  const row = result.rows[0];

  if (!row) {
    throw new HttpError(401, "invalid_token", "The bearer token is invalid or expired.");
  }

  return {
    email: row.email,
    id: row.user_id,
  };
}
