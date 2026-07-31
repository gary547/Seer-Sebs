import { describe, expect, it } from "vitest";

import { projectIdFromInput } from "../src/project-data.js";

describe("project-backed pipeline input", () => {
  const projectId = "32000000-0000-4000-8000-000000000001";

  it("accepts the versioned project contract", () => {
    expect(
      projectIdFromInput({
        inputVersion: "project-v1",
        projectId,
      }),
    ).toBe(projectId);
  });

  it("ignores structural and representative fixture inputs", () => {
    expect(projectIdFromInput({ purpose: "structural" })).toBeNull();
    expect(projectIdFromInput({ fixture: {} })).toBeNull();
  });

  it("rejects malformed identifiers for the project contract", () => {
    expect(() =>
      projectIdFromInput({
        inputVersion: "project-v1",
        projectId: "not-a-project",
      }),
    ).toThrow("invalid projectId");
  });
});
