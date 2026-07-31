import { describe, it, expect } from "vitest";
import { normalizeDomain } from "@/lib/domain";

describe("normalizeDomain", () => {
  it("returns null for empty / nullish input", () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("lowercases and trims", () => {
    expect(normalizeDomain("  PillTime.CO.UK  ")).toBe("pilltime.co.uk");
  });

  it("strips scheme, www, path, query, and hash", () => {
    expect(normalizeDomain("https://pilltime.co.uk/")).toBe("pilltime.co.uk");
    expect(normalizeDomain("http://www.pilltime.co.uk")).toBe("pilltime.co.uk");
    expect(normalizeDomain("www.pilltime.co.uk/foo/bar")).toBe("pilltime.co.uk");
    expect(normalizeDomain("pilltime.co.uk?utm=1")).toBe("pilltime.co.uk");
    expect(normalizeDomain("pilltime.co.uk#anchor")).toBe("pilltime.co.uk");
  });

  it("collapses whitespace inside the host", () => {
    expect(normalizeDomain("pilltime .co.uk")).toBe("pilltime.co.uk");
  });

  it("passes through IDN / non-ascii hostnames unchanged apart from casing", () => {
    expect(normalizeDomain("https://münchen.de/pfad")).toBe("münchen.de");
  });
});
