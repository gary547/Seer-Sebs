import { describe, expect, it, vi } from "vitest";

import {
  assertPublicMonitorUrl,
  fetchUrlSnapshot,
} from "../src/url-monitor.js";

const publicResolver = vi.fn(async () => [
  { address: "93.184.216.34", family: 4 },
]);

describe("URL monitor", () => {
  it("captures status, title and canonical metadata from a public page", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        '<html><head><title>Example page</title><link rel="canonical" href="/canonical"></head></html>',
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const snapshot = await fetchUrlSnapshot(
      "https://public.example/page",
      fetchImplementation,
      publicResolver,
    );

    expect(snapshot).toMatchObject({
      canonicalUrl: "https://public.example/canonical",
      errorMessage: null,
      finalUrl: "https://public.example/page",
      httpStatus: 200,
      pageTitle: "Example page",
      redirectChain: [
        { status: 200, url: "https://public.example/page" },
      ],
    });
  });

  it("blocks direct and redirected requests to private networks", async () => {
    await expect(
      assertPublicMonitorUrl("http://127.0.0.1/internal", publicResolver),
    ).rejects.toMatchObject({ code: "private_network_url" });

    const fetchImplementation = vi.fn(async () =>
      new Response(null, {
        headers: { location: "http://127.0.0.1/internal" },
        status: 302,
      }),
    ) as unknown as typeof fetch;
    const snapshot = await fetchUrlSnapshot(
      "https://public.example/redirect",
      fetchImplementation,
      publicResolver,
    );

    expect(snapshot.errorMessage).toContain("private or reserved networks");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
