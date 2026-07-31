import { describe, expect, it, vi } from "vitest";

import {
  GcsObjectStore,
  MetadataAccessTokenProvider,
} from "../src/gcs-object-store.js";

describe("Google Cloud Storage adapter", () => {
  it("checks, writes and reads a private object with metadata credentials", async () => {
    const calls: Array<{ authorization: string; method: string; url: string }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({
        authorization: headers.get("authorization") ?? "",
        method: init?.method ?? "GET",
        url,
      });
      if (url.includes("alt=media")) {
        return new Response("stored-content", { status: 200 });
      }
      return new Response("{}", {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as unknown as typeof fetch;
    const tokenProvider = {
      getAccessToken: vi.fn(async () => "metadata-token"),
    };
    const store = new GcsObjectStore(
      "example-seer-assets",
      tokenProvider,
      fetchImplementation,
    );

    await store.assertReady();
    await store.put("assets/user/object", Buffer.from("stored-content"));
    await expect(store.get("assets/user/object")).resolves.toEqual(
      Buffer.from("stored-content"),
    );

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.authorization === "Bearer metadata-token")).toBe(
      true,
    );
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("name=assets%2Fuser%2Fobject"),
    });
    expect(calls[2]?.url).toContain("assets%2Fuser%2Fobject?alt=media");
  });

  it("caches metadata access tokens before expiry", async () => {
    let now = 1_000_000;
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "metadata-token",
            expires_in: 3600,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    ) as unknown as typeof fetch;
    const provider = new MetadataAccessTokenProvider(
      fetchImplementation,
      () => now,
    );

    await expect(provider.getAccessToken()).resolves.toBe("metadata-token");
    now += 30_000;
    await expect(provider.getAccessToken()).resolves.toBe("metadata-token");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
