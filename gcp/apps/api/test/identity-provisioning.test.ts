import { describe, expect, it, vi } from "vitest";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import type { AccessTokenProvider } from "../../../packages/runtime/src/google-auth.js";
import {
  IdentityPlatformAdminClient,
  registerIdentityUser,
  type IdentityAccountAdmin,
} from "../src/identity-provisioning.js";

function fakePool(query: ReturnType<typeof vi.fn>): DatabasePool {
  return {
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  } as unknown as DatabasePool;
}

describe("Identity Platform account provisioning", () => {
  it("uses OAuth administration with the configured project and API key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("accounts:sendOobCode")) {
        return new Response(JSON.stringify({ email: "user@example.com" }), {
          status: 200,
        });
      }
      if (url.includes("accounts:delete")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("accounts:signInWithPassword")) {
        return new Response(
          JSON.stringify({
            email: "user@example.com",
            idToken: "identity-id-token",
            localId: "00000000-0000-4000-8000-000000000001",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          email: "user@example.com",
          localId: "00000000-0000-4000-8000-000000000001",
        }),
        { status: 200 },
      );
    });
    const fetchImplementation = fetchMock as unknown as typeof fetch;
    const accessTokens: AccessTokenProvider = {
      getAccessToken: vi.fn(async () => "oauth-access-token"),
    };
    const client = new IdentityPlatformAdminClient(
      "seer-staging",
      "web-api-key",
      accessTokens,
      fetchImplementation,
    );

    const account = await client.createAccount({
      displayName: "Test User",
      email: "user@example.com",
      localId: "00000000-0000-4000-8000-000000000001",
      password: "long-enough-password",
    });
    await client.sendVerificationEmail(
      "user@example.com",
      "https://seer.example.com/auth",
      account.idToken!,
    );
    await client.deleteAccount("00000000-0000-4000-8000-000000000001");

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v1/projects/seer-staging/accounts",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer oauth-access-token",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/v1/accounts:signInWithPassword",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/v1/accounts:sendOobCode");
    expect(fetchMock.mock.calls[2]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("key=web-api-key");
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      authorization: "Bearer oauth-access-token",
    });
  });

  it("creates the database profile and safe default role before sending verification", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rowCount: 1,
      rows: [],
    }));
    const identity: IdentityAccountAdmin = {
      createAccount: vi.fn(async () => ({
        idToken: "identity-id-token",
        localId: "00000000-0000-4000-8000-000000000001",
      })),
      deleteAccount: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => undefined),
      sendVerificationEmail: vi.fn(async () => undefined),
    };

    await expect(
      registerIdentityUser(
        fakePool(query),
        identity,
        {
          email: "external@example.com",
          fullName: "External User",
          password: "long-enough-password",
        },
        "https://seer.example.com/auth",
      ),
    ).resolves.toEqual({
      approvalStatus: "pending",
      emailVerificationRequired: true,
    });

    expect(identity.createAccount).toHaveBeenCalledOnce();
    expect(identity.sendVerificationEmail).toHaveBeenCalledWith(
      "external@example.com",
      "https://seer.example.com/auth",
      "identity-id-token",
    );
    expect(query.mock.calls.some((call) => call[0].includes("INSERT INTO profiles"))).toBe(true);
    expect(
      query.mock.calls.some(
        (call) =>
          call[0].includes("INSERT INTO user_roles") &&
          call[1]?.[1] === "view_only",
      ),
    ).toBe(true);
  });

  it("deletes the external identity when database provisioning fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO profiles")) throw new Error("database unavailable");
      return { rowCount: 1, rows: [] };
    });
    const identity: IdentityAccountAdmin = {
      createAccount: vi.fn(async () => ({
        idToken: "identity-id-token",
        localId: "00000000-0000-4000-8000-000000000001",
      })),
      deleteAccount: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => undefined),
      sendVerificationEmail: vi.fn(async () => undefined),
    };

    await expect(
      registerIdentityUser(
        fakePool(query),
        identity,
        {
          email: "user@nobraineragency.com",
          fullName: "Internal User",
          password: "long-enough-password",
        },
        "https://seer.example.com/auth",
      ),
    ).rejects.toThrow("database unavailable");

    expect(identity.deleteAccount).toHaveBeenCalledOnce();
    expect(identity.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
