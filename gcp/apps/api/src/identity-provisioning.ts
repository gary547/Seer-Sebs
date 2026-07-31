import { randomUUID } from "node:crypto";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import type { AccessTokenProvider } from "../../../packages/runtime/src/google-auth.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";

interface IdentityErrorBody {
  error?: {
    message?: string;
  };
}

interface IdentityAccountResponse {
  email?: string;
  localId?: string;
}

export interface IdentityAccountAdmin {
  createAccount(input: {
    displayName: string;
    email: string;
    localId: string;
    password?: string;
  }): Promise<void>;
  deleteAccount(localId: string): Promise<void>;
  sendPasswordResetEmail(email: string, continueUrl: string): Promise<void>;
  sendVerificationEmail(email: string, continueUrl: string): Promise<void>;
}

export class IdentityPlatformAdminClient implements IdentityAccountAdmin {
  constructor(
    private readonly projectId: string,
    private readonly apiKey: string,
    private readonly accessTokens: AccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!projectId || !apiKey) {
      throw new Error("Identity Platform project ID and API key are required.");
    }
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.accessTokens.getAccessToken();
    const response = await this.fetchImplementation(
      `https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(this.apiKey)}`,
      {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const responseBody = (await response.json().catch(() => ({}))) as IdentityErrorBody;
    if (!response.ok) {
      const providerCode = responseBody.error?.message ?? `HTTP_${response.status}`;
      if (
        providerCode.includes("EMAIL_EXISTS") ||
        providerCode.includes("DUPLICATE_LOCAL_ID")
      ) {
        throw new HttpError(409, "email_exists", "An account already exists for this email.");
      }
      throw new Error(`Identity Platform request failed: ${providerCode}`);
    }
    return responseBody;
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    localId: string;
    password?: string;
  }): Promise<void> {
    const result = (await this.request(`projects/${this.projectId}/accounts`, {
      disabled: false,
      displayName: input.displayName,
      email: input.email,
      emailVerified: false,
      localId: input.localId,
      ...(input.password ? { password: input.password } : {}),
    })) as IdentityAccountResponse;
    if (result.localId !== input.localId || result.email?.toLowerCase() !== input.email) {
      throw new Error("Identity Platform created an unexpected account.");
    }
  }

  async deleteAccount(localId: string): Promise<void> {
    await this.request(`projects/${this.projectId}/accounts:delete`, { localId });
  }

  async sendVerificationEmail(email: string, continueUrl: string): Promise<void> {
    await this.request("accounts:sendOobCode", {
      continueUrl,
      email,
      requestType: "VERIFY_EMAIL",
      targetProjectId: this.projectId,
    });
  }

  async sendPasswordResetEmail(email: string, continueUrl: string): Promise<void> {
    await this.request("accounts:sendOobCode", {
      continueUrl,
      email,
      requestType: "PASSWORD_RESET",
      targetProjectId: this.projectId,
    });
  }
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

export async function registerIdentityUser(
  pool: DatabasePool,
  identity: IdentityAccountAdmin,
  body: unknown,
  continueUrl: string,
): Promise<Record<string, unknown>> {
  const record = recordBody(body);
  const email = requireString(record.email, "email", 254).toLowerCase();
  const password = requireString(record.password, "password", 256);
  const fullName = requireString(record.fullName, "fullName", 200);
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

  const localId = randomUUID();
  await identity.createAccount({ displayName: fullName, email, localId, password });

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
            approval_status
          )
          VALUES ($1, $2, $3, 'identity-platform', false, 'pending')
        `,
        [localId, email, fullName],
      );
      await client.query(
        `
          INSERT INTO user_roles (user_id, role)
          VALUES ($1, $2)
        `,
        [localId, email.endsWith("@nobraineragency.com") ? "user" : "view_only"],
      );
    });
  } catch (error) {
    await identity.deleteAccount(localId).catch(() => undefined);
    throw error;
  }

  try {
    await identity.sendVerificationEmail(email, continueUrl);
  } catch (error) {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM profiles WHERE user_id = $1", [localId]);
    }).catch(() => undefined);
    await identity.deleteAccount(localId).catch(() => undefined);
    throw error;
  }

  return {
    approvalStatus: "pending",
    emailVerificationRequired: true,
  };
}
