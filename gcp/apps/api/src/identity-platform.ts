import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { bearerToken, HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";

interface IdentityHeader {
  alg: string;
  kid: string;
}

interface IdentityClaims {
  aud: string;
  email: string;
  email_verified?: boolean;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
}

interface IdentityJwk extends JsonWebKey {
  alg?: string;
  kid?: string;
  use?: string;
}

interface JwkSet {
  keys: IdentityJwk[];
}

export interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
  uid: string;
}

function decodeSegment<T>(segment: string, name: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new HttpError(401, "invalid_token", `Identity token ${name} is invalid.`);
  }
}

function cacheDuration(response: Response): number {
  const match = response.headers.get("cache-control")?.match(/max-age=(\d+)/i);
  return match ? Number(match[1]) * 1_000 : 60 * 60_000;
}

export class IdentityPlatformVerifier {
  private keys: { expiresAt: number; values: Map<string, IdentityJwk> } | null =
    null;

  constructor(
    private readonly projectId: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!projectId) {
      throw new Error("Identity Platform project ID is required.");
    }
  }

  private async key(kid: string): Promise<IdentityJwk> {
    if (!this.keys || this.keys.expiresAt <= this.now()) {
      const response = await this.fetchImplementation(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Identity key endpoint returned ${response.status}.`);
      }
      const body = (await response.json()) as Partial<JwkSet>;
      if (!Array.isArray(body.keys)) {
        throw new Error("Identity key endpoint returned an invalid response.");
      }
      this.keys = {
        expiresAt: this.now() + cacheDuration(response),
        values: new Map(
          body.keys.flatMap((key) =>
            typeof key.kid === "string" ? [[key.kid, key]] : [],
          ),
        ),
      };
    }

    const key = this.keys.values.get(kid);
    if (!key) {
      throw new HttpError(401, "invalid_token", "Identity token signing key is unknown.");
    }
    return key;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new HttpError(401, "invalid_token", "Identity token is malformed.");
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = decodeSegment<IdentityHeader>(encodedHeader, "header");
    const claims = decodeSegment<IdentityClaims>(encodedClaims, "payload");

    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !header.kid
    ) {
      throw new HttpError(401, "invalid_token", "Identity token algorithm is invalid.");
    }

    const validSignature = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({
        format: "jwk",
        key: await this.key(header.kid),
      }),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature) {
      throw new HttpError(401, "invalid_token", "Identity token signature is invalid.");
    }

    const nowSeconds = Math.floor(this.now() / 1_000);
    const expectedIssuer = `https://securetoken.google.com/${this.projectId}`;
    const audience = Buffer.from(String(claims.aud ?? ""));
    const expectedAudience = Buffer.from(this.projectId);
    if (
      claims.iss !== expectedIssuer ||
      audience.length !== expectedAudience.length ||
      !timingSafeEqual(audience, expectedAudience) ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= nowSeconds ||
      !Number.isInteger(claims.iat) ||
      claims.iat > nowSeconds + 60 ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 128 ||
      typeof claims.email !== "string" ||
      !claims.email
    ) {
      throw new HttpError(401, "invalid_token", "Identity token claims are invalid.");
    }

    return {
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === true,
      uid: claims.sub,
    };
  }
}

export async function authenticateIdentityPlatformRequest(
  pool: DatabasePool,
  request: IncomingMessage,
  verifier: IdentityPlatformVerifier,
): Promise<AuthenticatedUser> {
  const token = bearerToken(request);
  if (!token) {
    throw new HttpError(401, "authentication_required", "A bearer token is required.");
  }
  const identity = await verifier.verify(token);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      identity.uid,
    )
  ) {
    throw new HttpError(
      401,
      "unsupported_identity_uid",
      "The identity UID is not compatible with the migrated account contract.",
    );
  }

  await pool.query(
    `
      INSERT INTO profiles (
        user_id,
        email,
        identity_provider,
        identity_email_verified,
        last_authenticated_at
      )
      VALUES ($1, $2, 'identity-platform', $3, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        identity_provider = EXCLUDED.identity_provider,
        identity_email_verified = EXCLUDED.identity_email_verified,
        last_authenticated_at = now()
    `,
    [identity.uid, identity.email, identity.emailVerified],
  );

  return {
    email: identity.email,
    id: identity.uid,
  };
}
