import { describe, expect, it } from "vitest";

import { shouldInjectLocalFailure } from "../src/processor.js";

describe("local worker failure injection", () => {
  const input = {
    localValidation: {
      failAttempts: 2,
      failStage: "categorisation",
    },
  };

  it("is disabled unless the worker explicitly enables local injection", () => {
    expect(shouldInjectLocalFailure(input, "categorisation", 1, false)).toBe(false);
  });

  it("fails only the configured stage and attempt window", () => {
    expect(shouldInjectLocalFailure(input, "categorisation", 1, true)).toBe(true);
    expect(shouldInjectLocalFailure(input, "categorisation", 2, true)).toBe(true);
    expect(shouldInjectLocalFailure(input, "categorisation", 3, true)).toBe(false);
    expect(shouldInjectLocalFailure(input, "detox", 1, true)).toBe(false);
  });

  it("rejects malformed local validation contracts", () => {
    expect(() =>
      shouldInjectLocalFailure(
        { localValidation: { failAttempts: 10, failStage: "unknown" } },
        "categorisation",
        1,
        true,
      ),
    ).toThrow("Invalid local failure-injection contract");
  });
});
