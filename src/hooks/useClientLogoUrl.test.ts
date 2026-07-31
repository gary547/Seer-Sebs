import { afterEach, describe, expect, it, vi } from "vitest";

import { validateClientLogoUrl } from "./useClientLogoUrl";

class TestImage {
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;

  set src(value: string) {
    queueMicrotask(() => {
      if (value.endsWith("/good.png")) this.onload?.();
      else this.onerror?.();
    });
  }
}

describe("validateClientLogoUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps renderable logo URLs", async () => {
    vi.stubGlobal("Image", TestImage);

    await expect(validateClientLogoUrl("https://example.dev/good.png")).resolves.toBe(
      "https://example.dev/good.png",
    );
  });

  it("returns null for broken logo payloads", async () => {
    vi.stubGlobal("Image", TestImage);

    await expect(validateClientLogoUrl("data:image/png;base64,broken")).resolves.toBeNull();
  });
});
