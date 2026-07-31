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
  idToken?: string;
  localId?: string;
}

interface CreatedIdentityAccount {
  idToken?: string;
  localId: string;
}

export interface IdentityAccountAdmin {
  createAccount(input: {
    displayName: string;
    email: string;
    localId: string;
    password?: string;
  }): Promise<CreatedIdentityAccount>;
  deleteAccount(localId: string): Promise<void>;
  sendPasswordResetEmail(email: string, continueUrl: string): Promise<void>;
  sendVerificationEmail(email: string, continueUrl: string, idToken: string): Promise<void>;
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

  private async request(
    path: string,
    body: Record<string, unknown>,
    admin = true,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (admin) {
      headers.authorization = `Bearer ${await this.accessTokens.getAccessToken()}`;
    }
    const response = await this.fetchImplementation(
      `https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(this.apiKey)}`,
      {
        body: JSON.stringify(body),
        headers,
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
  }): Promise<CreatedIdentityAccount> {
    const result = (await this.request(`projects/${this.projectId}/accounts`, {
      disabled: false,
      displayName: input.displayName,
      email: input.email,
      emailVerified: false,
      localId: input.localId,
      ...(input.password ? { password: input.password } : {}),
    })) as IdentityAccountResponse;
    if (
      !result.localId ||
      result.localId !== input.localId ||
      result.email?.toLowerCase() !== input.email
    ) {
      throw new Error("Identity Platform created an unexpected account.");
    }
    if (!input.password) return { localId: result.localId };

    try {
      const signIn = (await this.request(
        "accounts:signInWithPassword",
        {
          email: input.email,
          password: input.password,
          returnSecureToken: true,
        },
        false,
      )) as IdentityAccountResponse;
      if (signIn.localId !== result.localId || !signIn.idToken) {
        throw new Error("Identity Platform returned an unexpected registration session.");
      }
      return { idToken: signIn.idToken, localId: result.localId };
    } catch (error) {
      await this.deleteAccount(result.localId).catch(() => undefined);
      throw error;
    }
  }

  async deleteAccount(localId: string): Promise<void> {
    await this.request(`projects/${this.projectId}/accounts:delete`, { localId });
  }

  async sendVerificationEmail(
    email: string,
    continueUrl: string,
    idToken: string,
  ): Promise<void> {
    await this.request(
      "accounts:sendOobCode",
      {
        continueUrl,
        email,
        idToken,
        requestType: "VERIFY_EMAIL",
      },
      false,
    );
  }

  async sendPasswordResetEmail(email: string, continueUrl: string): Promise<void> {
    await this.request(
      "accounts:sendOobCode",
      {
        continueUrl,
        email,
        requestType: "PASSWORD_RESET",
      },
      false,
    );
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

  const account = await identity.createAccount({
    displayName: fullName,
    email,
    localId: randomUUID(),
    password,
  });
  if (!account.idToken) {
    await identity.deleteAccount(account.localId).catch(() => undefined);
    throw new Error("Identity Platform did not return a registration token.");
  }

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
        [account.localId, email, fullName],
      );
      await client.query(
        `
          INSERT INTO user_roles (user_id, role)
          VALUES ($1, $2)
        `,
        [account.localId, email.endsWith("@nobraineragency.com") ? "user" : "view_only"],
      );
    });
  } catch (error) {
    await identity.deleteAccount(account.localId).catch(() => undefined);
    throw error;
  }

  try {
    await identity.sendVerificationEmail(email, continueUrl, account.idToken);
  } catch (error) {
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM profiles WHERE user_id = $1", [account.localId]);
    }).catch(() => undefined);
    await identity.deleteAccount(account.localId).catch(() => undefined);
    throw error;
  }

  return {
    approvalStatus: "pending",
    emailVerificationRequired: true,
  };
}
