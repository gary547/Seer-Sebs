import { describe, expect, it, vi } from "vitest";

import {
  AhrefsClient,
  AnthropicSiteArchitectureClient,
  DataForSeoClient,
} from "../src/live-providers.js";

function dataForSeoResponse(items: unknown[]): Response {
  return new Response(
    JSON.stringify({
      tasks: [
        {
          result: [{ items }],
          status_code: 20000,
        },
      ],
    }),
    { status: 200 },
  );
}

function dataForSeoFailure(code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      tasks: [{ status_code: code, status_message: message }],
    }),
    { status: 200 },
  );
}

describe("managed pipeline providers", () => {
  it("merges live keyword volume, difficulty, intent and monthly history", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("historical_search_volume/live")) {
          return dataForSeoResponse([
            {
              keyword: "buy television",
              keyword_info: {
                monthly_searches: [
                  { month: 5, search_volume: 80, year: 2026 },
                  { month: 6, search_volume: 90, year: 2026 },
                ],
                search_volume: 120,
              },
              keyword_properties: { core_keyword: "buy tv" },
            },
          ]);
        }
        if (url.includes("search_volume/live")) {
          return dataForSeoResponse([
            {
              keyword: "buy television",
              monthly_searches: [
                { month: 6, search_volume: 90, year: 2026 },
              ],
              search_volume: 120,
            },
          ]);
        }
        if (url.includes("bulk_keyword_difficulty/live")) {
          return dataForSeoResponse([
            { keyword: "buy television", keyword_difficulty: 44 },
          ]);
        }
        return dataForSeoResponse([
          {
            keyword: "buy television",
            keyword_intent: { label: "transactional" },
          },
        ]);
      },
    );
    const client = new DataForSeoClient(
      "login:password",
      fetchImplementation,
    );

    await expect(
      client.enrichKeywords(["buy television"], "GB", "en"),
    ).resolves.toEqual([
      {
        avgMonthlyVolume: 120,
        coreKeyword: "buy tv",
        intent: "transactional",
        keyword: "buy television",
        keywordDifficulty: 44,
        monthlyVolumes: [
          { month: "2026-05-01", volume: 80 },
          { month: "2026-06-01", volume: 90 },
        ],
      },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("login:password").toString("base64")}`,
    );
  });

  it("defaults a missing project language to English", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      dataForSeoResponse([]),
    );
    const client = new DataForSeoClient("login:password", fetchImplementation);

    await expect(
      client.enrichKeywords(["buy television"], "GB", null),
    ).resolves.toHaveLength(1);

    for (const [, request] of fetchImplementation.mock.calls) {
      const task = JSON.parse(String(request?.body))[0] as {
        language_code: string;
      };
      expect(task.language_code).toBe("en");
    }
  });

  it("continues with standard volume when optional Labs endpoints are unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImplementation = vi.fn<typeof fetch>(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/keywords_data/google_ads/search_volume/live")) {
          return dataForSeoResponse([
            {
              keyword: "buy television",
              keyword_properties: { core_keyword: "buy tv" },
              monthly_searches: [
                { month: 6, search_volume: 90, year: 2026 },
              ],
              search_volume: 120,
            },
          ]);
        }
        return dataForSeoFailure(40201, "Access denied");
      },
    );
    const client = new DataForSeoClient("login:password", fetchImplementation);

    await expect(
      client.enrichKeywords(["buy television"], "GB", "en"),
    ).resolves.toEqual([
      {
        avgMonthlyVolume: 120,
        coreKeyword: "buy tv",
        intent: null,
        keyword: "buy television",
        keywordDifficulty: null,
        monthlyVolumes: [{ month: "2026-06-01", volume: 90 }],
      },
    ]);
    expect(warning).toHaveBeenCalledTimes(3);
    warning.mockRestore();
  });

  it("surfaces the DataForSEO status when SERP task submission is rejected", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      dataForSeoFailure(40201, "Access denied"),
    );
    const client = new DataForSeoClient("login:password", fetchImplementation);

    await expect(
      client.submitSerpTasks(
        [{ itemKey: "buy television", keyword: "buy television" }],
        "GB",
        "en",
      ),
    ).rejects.toThrow(
      "DataForSEO SERP task submission failed (40201): Access denied.",
    );
  });

  it("parses ranked URLs and Ahrefs authority metrics", async () => {
    const dataForSeoFetch = vi.fn<typeof fetch>().mockResolvedValue(
      dataForSeoResponse([
        {
          keyword_data: { keyword: "buy television" },
          ranked_serp_element: {
            serp_item: {
              rank_group: 3,
              url: "https://example.test/televisions",
            },
          },
        },
      ]),
    );
    const dataForSeo = new DataForSeoClient("encoded", dataForSeoFetch);
    await expect(
      dataForSeo.rankingUrls(
        "example.test",
        ["buy television"],
        "GB",
        "en",
      ),
    ).resolves.toEqual([
      {
        keyword: "buy television",
        rank: 3,
        url: "https://example.test/televisions",
      },
    ]);

    const ahrefsFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          targets: [
            {
              ahrefs_rank: 12,
              backlinks: 250,
              domain_rating: 61,
              refdomains: 80,
              url: "example.test",
              url_rating: 42,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const ahrefs = new AhrefsClient("ahrefs-key", ahrefsFetch);
    await expect(
      ahrefs.metrics([{ mode: "domain", url: "example.test" }]),
    ).resolves.toEqual(
      new Map([
        [
          "example.test",
          {
            ahrefsRank: 12,
            backlinks: 250,
            domainRating: 61,
            referringDomains: 80,
            urlRating: 42,
          },
        ],
      ]),
    );
  });

  it("uses direct Anthropic responses for site-architecture scoring", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              text: JSON.stringify([
                {
                  contentStatus: "green",
                  index: 0,
                  relevancyScore: 91,
                  tacticalStatus: "no_action_needed",
                },
              ]),
              type: "text",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new AnthropicSiteArchitectureClient(
      "anthropic-key",
      fetchImplementation,
    );

    await expect(
      client.score([
        {
          keyword: "buy television",
          rankingUrl: "https://example.test/televisions",
        },
      ]),
    ).resolves.toEqual(
      new Map([
        [
          "buy television",
          {
            contentStatus: "green",
            relevancyScore: 91,
            tacticalStatus: "no_action_needed",
          },
        ],
      ]),
    );
    const request = fetchImplementation.mock.calls[0]?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get("x-api-key")).toBe("anthropic-key");
    expect(headers.has("authorization")).toBe(false);
  });
});
