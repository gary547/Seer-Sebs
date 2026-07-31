import { describe, expect, it } from "vitest";

import {
  buildIdentityArtifacts,
  buildStorageManifest,
} from "../src/source-manifests.js";

describe("source migration manifests", () => {
  it("builds a Firebase BCRYPT import while preserving UIDs", () => {
    const artifacts = buildIdentityArtifacts(
      [
        {
          bannedUntil: null,
          createdAt: "2026-01-01T00:00:00Z",
          email: "owner@example.test",
          emailConfirmedAt: "2026-01-01T00:00:00Z",
          encryptedPassword:
            "$2b$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
          id: "a5ce93e6-a447-474d-8442-776570de27b4",
          lastSignInAt: "2026-02-01T00:00:00Z",
          rawUserMetadata: { full_name: "Project Owner" },
        },
      ],
      [
        {
          identityData: {
            email: "owner@example.test",
            full_name: "Project Owner",
            sub: "google-subject",
          },
          provider: "google",
          providerId: "google-subject",
          userId: "a5ce93e6-a447-474d-8442-776570de27b4",
        },
      ],
      Date.parse("2026-07-30T00:00:00Z"),
    );

    expect(artifacts.summary).toMatchObject({
      bcryptUsers: 1,
      emailVerifiedUsers: 1,
      oauthUsers: 1,
      totalUsers: 1,
    });
    expect(artifacts.firebaseImport.users[0]).toMatchObject({
      displayName: "Project Owner",
      email: "owner@example.test",
      emailVerified: true,
      localId: "a5ce93e6-a447-474d-8442-776570de27b4",
      providerUserInfo: [
        {
          providerId: "google.com",
          rawId: "google-subject",
        },
      ],
    });
    expect(
      Buffer.from(
        artifacts.firebaseImport.users[0]?.passwordHash ?? "",
        "base64",
      ).toString("utf8"),
    ).toMatch(/^\$2b\$10\$/);
    expect(artifacts.reconciliationCsv).toContain(
      "a5ce93e6-a447-474d-8442-776570de27b4,a5ce93e6-a447-474d-8442-776570de27b4",
    );
  });

  it("separates unsupported password hashes into the reset cohort", () => {
    const artifacts = buildIdentityArtifacts(
      [
        {
          bannedUntil: null,
          createdAt: null,
          email: "reset@example.test",
          emailConfirmedAt: null,
          encryptedPassword: "unsupported-hash",
          id: "reset-user",
          lastSignInAt: null,
          rawUserMetadata: null,
        },
      ],
      [],
    );

    expect(artifacts.resetRequiredUids).toEqual(["reset-user"]);
    expect(artifacts.firebaseImport.users[0]?.passwordHash).toBeUndefined();
  });

  it("imports a currently banned source user as disabled", () => {
    const artifacts = buildIdentityArtifacts(
      [
        {
          bannedUntil: "2026-08-01T00:00:00Z",
          createdAt: null,
          email: "disabled@example.test",
          emailConfirmedAt: null,
          encryptedPassword: null,
          id: "disabled-user",
          lastSignInAt: null,
          rawUserMetadata: null,
        },
      ],
      [],
      Date.parse("2026-07-30T00:00:00Z"),
    );

    expect(artifacts.summary.disabledUsers).toBe(1);
    expect(artifacts.firebaseImport.users[0]).toMatchObject({
      disabled: true,
      localId: "disabled-user",
    });
  });

  it("normalises the two approved storage buckets and recorded sizes", () => {
    const manifest = buildStorageManifest([
      {
        bucketId: "client-logos",
        createdAt: "2026-01-01T00:00:00Z",
        id: "object-1",
        metadata: { size: "128" },
        name: "client/logo.svg",
        owner: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        bucketId: "slide-exports",
        createdAt: "2026-01-01T00:00:00Z",
        id: "object-2",
        metadata: { size: 512 },
        name: "exports/slide.png",
        owner: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    expect(manifest.buckets).toEqual({
      "client-logos": { objectCount: 1, recordedBytes: 128 },
      "slide-exports": { objectCount: 1, recordedBytes: 512 },
    });
  });
});
