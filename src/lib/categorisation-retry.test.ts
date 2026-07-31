import { describe, expect, it } from "vitest";
import {
  categorisationRetryDisposition,
  emptyCategorisationClaimDisposition,
} from "../../supabase/functions/_shared/categorisation-retry";

describe("categorisation retry disposition", () => {
  it("does not consume an attempt for rate-limited or worker-budget work", () => {
    expect(categorisationRetryDisposition(4, false)).toBe("retry_unconsumed");
  });

  it("retries an actual AI failure below the fallback threshold", () => {
    expect(categorisationRetryDisposition(3, true)).toBe("retry_consumed");
  });

  it("terminates an exhausted AI item through the explicit fallback path", () => {
    expect(categorisationRetryDisposition(4, true)).toBe("fallback");
    expect(categorisationRetryDisposition(5, true)).toBe("fallback");
  });
});

describe("empty categorisation claims", () => {
  it("completes only when no work remains", () => {
    expect(emptyCategorisationClaimDisposition(0, 0)).toBe("done");
  });

  it("waits when another worker owns the remaining rows", () => {
    expect(emptyCategorisationClaimDisposition(2, 2)).toBe("waiting");
  });

  it("fails terminally when unresolved rows are no longer claimable", () => {
    expect(emptyCategorisationClaimDisposition(2, 0)).toBe("error");
  });
});
