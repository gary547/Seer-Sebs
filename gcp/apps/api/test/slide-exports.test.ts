import { describe, expect, it, vi } from "vitest";

import {
  GcsExportImageStore,
  GoogleSlidesClient,
  WorkspaceOauthTokenProvider,
} from "../src/slide-exports.js";

describe("Google Slides export adapters", () => {
  it("refreshes and caches Workspace OAuth tokens", async () => {
    let now = 1_000_000;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "workspace-token",
          expires_in: 3_600,
        }),
        { status: 200 },
      ),
    );
    const provider = new WorkspaceOauthTokenProvider(
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      fetchImplementation,
      () => now,
    );

    await expect(provider.getAccessToken()).resolves.toBe("workspace-token");
    now += 30_000;
    await expect(provider.getAccessToken()).resolves.toBe("workspace-token");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(request?.body)).toContain("grant_type=refresh_token");
  });

  it("copies the template and inserts the export image through direct APIs", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? "GET",
          url,
        });
        if (url.includes("/drive/v3/files/")) {
          return new Response(JSON.stringify({ id: "deck-id" }), {
            status: 200,
          });
        }
        if (url.endsWith("/presentations/deck-id")) {
          return new Response(
            JSON.stringify({
              pageSize: {
                height: { magnitude: 5_143_500 },
                width: { magnitude: 9_144_000 },
              },
              slides: [{ objectId: "first-slide", pageElements: [] }],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    const client = new GoogleSlidesClient(
      "template-id",
      { getAccessToken: vi.fn(async () => "workspace-token") },
      fetchImplementation,
    );

    await expect(
      client.createDeck({
        imageHeight: 900,
        imageUrl: "https://storage.googleapis.com/export.png",
        imageWidth: 1_600,
        name: "Performance export",
      }),
    ).resolves.toEqual({
      id: "deck-id",
      name: "Performance export",
      url: "https://docs.google.com/presentation/d/deck-id/edit",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
    expect(requests[2]?.body).toMatchObject({
      requests: [
        {
          createImage: {
            elementProperties: { pageObjectId: "first-slide" },
            url: "https://storage.googleapis.com/export.png",
          },
        },
      ],
    });
  });

  it("uploads, signs and deletes temporary export images", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.includes(":signBlob")) {
          return new Response(
            JSON.stringify({
              signedBlob: Buffer.from("signature").toString("base64"),
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    const store = new GcsExportImageStore(
      "seer-exports",
      "api@project.iam.gserviceaccount.com",
      { getAccessToken: vi.fn(async () => "metadata-token") },
      fetchImplementation,
      () => new Date("2026-07-30T10:20:30.000Z"),
    );

    const signedUrl = await store.put(
      "slide-exports/project/export.png",
      Buffer.from("png"),
    );
    await store.delete("slide-exports/project/export.png");

    expect(signedUrl).toContain("X-Goog-Algorithm=GOOG4-RSA-SHA256");
    expect(signedUrl).toContain(
      "api%40project.iam.gserviceaccount.com%2F20260730%2Fauto%2Fstorage%2Fgoog4_request",
    );
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "DELETE",
    ]);
  });
});
