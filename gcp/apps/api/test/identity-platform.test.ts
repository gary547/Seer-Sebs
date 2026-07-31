import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { IdentityPlatformVerifier } from "../src/identity-platform.js";

const projectId = "seer-staging-test";
const now = Date.UTC(2026, 6, 30, 8, 0, 0);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "test-key",
  use: "sig",
};

function token(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      aud: projectId,
      email: "User@Example.com",
      email_verified: true,
      exp: Math.floor(now / 1_000) + 3600,
      iat: Math.floor(now / 1_000) - 10,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: "00000000-0000-4000-8000-000000000001",
      ...overrides,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function keyFetch() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "application/json",
        },
        status: 200,
      }),
  ) as unknown as typeof fetch;
}

describe("Identity Platform token verifier", () => {
  it("verifies signature, issuer, audience, expiry and identity fields", async () => {
    const fetchImplementation = keyFetch();
    const verifier = new IdentityPlatformVerifier(
      projectId,
      fetchImplementation,
      () => now,
    );

    await expect(verifier.verify(token())).resolves.toEqual({
      email: "user@example.com",
      emailVerified: true,
      uid: "00000000-0000-4000-8000-000000000001",
    });
    await expect(verifier.verify(token())).resolves.toBeDefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects tokens for another audience or after expiry", async () => {
    const verifier = new IdentityPlatformVerifier(
      projectId,
      keyFetch(),
      () => now,
    );

    await expect(verifier.verify(token({ aud: "another-project" }))).rejects.toMatchObject({
      code: "invalid_token",
      statusCode: 401,
    });
    await expect(
      verifier.verify(token({ exp: Math.floor(now / 1_000) - 1 })),
    ).rejects.toMatchObject({
      code: "invalid_token",
      statusCode: 401,
    });
  });
});
