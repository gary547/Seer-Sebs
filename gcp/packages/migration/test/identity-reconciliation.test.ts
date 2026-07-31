import { describe, expect, it } from "vitest";

import { reconcileIdentityUsers } from "../src/identity-reconciliation.js";

describe("identity migration reconciliation", () => {
  it("passes only when UID, email and verification state match", () => {
    expect(
      reconcileIdentityUsers(
        [
          {
            disabled: false,
            email: "owner@example.test",
            emailVerified: true,
            localId: "owner",
          },
        ],
        [
          {
            disabled: false,
            email: "OWNER@example.test",
            emailVerified: true,
            localId: "owner",
          },
        ],
      ),
    ).toMatchObject({
      matchedUsers: 1,
      passed: true,
      sourceUsers: 1,
      targetUsers: 1,
    });
  });

  it("reports missing, extra and mismatched users without exposing email values", () => {
    const result = reconcileIdentityUsers(
      [
        {
          disabled: true,
          email: "owner@example.test",
          emailVerified: true,
          localId: "owner",
        },
        {
          email: "missing@example.test",
          emailVerified: false,
          localId: "missing",
        },
      ],
      [
        {
          disabled: false,
          email: "different@example.test",
          emailVerified: false,
          localId: "owner",
        },
        {
          email: "extra@example.test",
          emailVerified: true,
          localId: "extra",
        },
      ],
    );

    expect(result).toMatchObject({
      disabledMismatches: ["owner"],
      emailMismatches: ["owner"],
      emailVerifiedMismatches: ["owner"],
      extraTargetUids: ["extra"],
      missingTargetUids: ["missing"],
      passed: false,
    });
    expect(JSON.stringify(result)).not.toContain("example.test");
  });
});
