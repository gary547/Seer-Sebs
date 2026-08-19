import { describe, expect, it, vi } from "vitest";

import {
  AhrefsClient,
  AnthropicSiteArchitectureClient,
  DataForSeoClient,
  isGoogleAdsKeywordEligible,
  LivePipelineProviderHydrator,
} from "../src/live-providers.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";

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

  it("skips Google Ads keywords that exceed DataForSEO limits", async () => {
    const tooLong =
      "0 coming soon meaco cirro® 12000 btu super quiet smart portable air conditioner - cooling only";
    expect(isGoogleAdsKeywordEligible(tooLong)).toBe(false);
    expect(isGoogleAdsKeywordEligible("0% finance ipad")).toBe(false);
    expect(isGoogleAdsKeywordEligible("ao tv deals")).toBe(true);

    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      dataForSeoResponse([
        {
          keyword: "ao tv deals",
          search_volume: 90,
        },
      ]),
    );
    const client = new DataForSeoClient("login:password", fetchImplementation);

    await expect(
      client.enrichKeywords([tooLong, "ao tv deals"], "GB", "en"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          avgMonthlyVolume: null,
          keyword: tooLong,
        }),
        expect.objectContaining({
          avgMonthlyVolume: 90,
          keyword: "ao tv deals",
        }),
      ]),
    );
    const sent = fetchImplementation.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body))[0].keywords,
    );
    expect(sent.every((keywords: string[]) => !keywords.includes(tooLong))).toBe(
      true,
    );
  });

  it("retries a batch after dropping a keyword rejected by DataForSEO", async () => {
    const rejected =
      "0 coming soon meaco cirro 12000 btu super quiet";
    let searchVolumeCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("search_volume/live")) {
        searchVolumeCalls += 1;
        const keywords = JSON.parse(String(init?.body))[0].keywords as string[];
        if (keywords.includes(rejected)) {
          return dataForSeoFailure(
            40501,
            `Invalid Field: 'keywords'. Keyword text has invalid characters or symbols: '${rejected}'.`,
          );
        }
        return dataForSeoResponse(
          keywords.map((keyword) => ({ keyword, search_volume: 40 })),
        );
      }
      return dataForSeoResponse([]);
    });
    const client = new DataForSeoClient("login:password", fetchImplementation);

    const values = await client.enrichKeywords(
      [rejected, "ao tv deals"],
      "GB",
      "en",
    );
    expect(searchVolumeCalls).toBeGreaterThanOrEqual(2);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ avgMonthlyVolume: null, keyword: rejected }),
        expect.objectContaining({ avgMonthlyVolume: 40, keyword: "ao tv deals" }),
      ]),
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
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_input, request) => {
        const task = JSON.parse(String(request?.body))[0] as Record<
          string,
          unknown
        >;
        expect(task.location_code).toBe(2826);
        expect(task).not.toHaveProperty("location_name");
        return dataForSeoFailure(40201, "Access denied");
      },
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

  it("hydrates missing client authority before preflight", async () => {
    const ahrefs = {
      metrics: vi.fn(async () =>
        new Map([
          [
            "pilltime.co.uk",
            {
              ahrefsRank: 120,
              backlinks: 450,
              domainRating: 38,
              referringDomains: 90,
              urlRating: null,
            },
          ],
        ]),
      ),
    };
    const query = vi.fn(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT input->>'mode' AS mode")) {
        return { rowCount: 1, rows: [{ mode: "full" }] };
      }
      if (sql.includes("authority_domain_rating::text AS domain_rating")) {
        return {
          rowCount: 1,
          rows: [{ backlinks: "0", domain_rating: "0", referring_domains: 0 }],
        };
      }
      if (sql.includes("SELECT project.country, project.language, client.domain")) {
        return {
          rowCount: 1,
          rows: [{ country: "GB", domain: "pilltime.co.uk", language: "en" }],
        };
      }
      if (sql.includes("FROM authority_domain_cache")) {
        return { rowCount: 0, rows: [] };
      }
      if (
        sql.startsWith("UPDATE navigator_projects") ||
        sql.startsWith("INSERT INTO authority_domain_cache")
      ) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected authority hydration SQL: ${sql}`);
    });
    const hydrator = new LivePipelineProviderHydrator(
      {} as DataForSeoClient,
      ahrefs as unknown as AhrefsClient,
      {} as AnthropicSiteArchitectureClient,
    );

    await hydrator.hydrate(
      { query } as unknown as DatabasePool,
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "preflight",
    );

    expect(ahrefs.metrics).toHaveBeenCalledWith([
      { mode: "domain", url: "pilltime.co.uk" },
    ]);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO authority_domain_cache"),
      ),
    ).toBe(true);
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

  it("persists keyword enrichment batches and retries remaining work", async () => {
    let now = 0;
    const enrichKeywords = vi.fn(async (keywords: readonly string[]) => {
      now += 1;
      return keywords.map((keyword) => ({
        avgMonthlyVolume: 100,
        coreKeyword: keyword,
        intent: "commercial",
        keyword,
        keywordDifficulty: 20,
        monthlyVolumes: [{ month: "2026-06-01", volume: 90 }],
      }));
    });
    const clientQuery = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (
        sql.includes("INSERT INTO local_provider_keyword_inputs") ||
        sql.includes("INSERT INTO local_provider_keyword_monthly_volumes")
      ) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected persist SQL: ${sql}`);
    });
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT input->>'mode' AS mode")) {
        return { rowCount: 1, rows: [{ mode: "full" }] };
      }
      if (sql.includes("SELECT project.country, project.language, client.domain")) {
        return {
          rowCount: 1,
          rows: [{ country: "GB", domain: "ao.com", language: "en" }],
        };
      }
      if (sql.includes("FROM keywords AS keyword")) {
        return {
          rowCount: 2,
          rows: [
            {
              avg_monthly_volume: null,
              id: "00000000-0000-4000-8000-000000000011",
              keyword: "ao tv",
              normalised_keyword: "ao tv",
              provider_fetched_at: null,
              ranking_lookup_checked_at: null,
              ranking_url: null,
            },
            {
              avg_monthly_volume: null,
              id: "00000000-0000-4000-8000-000000000012",
              keyword: "ao washing machine",
              normalised_keyword: "ao washing machine",
              provider_fetched_at: null,
              ranking_lookup_checked_at: null,
              ranking_url: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected hydration SQL: ${sql}`);
    });
    const hydrator = new LivePipelineProviderHydrator(
      { enrichKeywords } as unknown as DataForSeoClient,
      {} as AhrefsClient,
      {} as AnthropicSiteArchitectureClient,
      async () => undefined,
      () => now,
      780_000,
      1,
      1,
    );
    const pool = {
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
      query,
    } as unknown as DatabasePool;

    await expect(
      hydrator.hydrate(
        pool,
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000004",
        "keyword-enrichment",
      ),
    ).rejects.toMatchObject({
      code: "provider_hydration_incomplete",
      statusCode: 503,
    });
    expect(enrichKeywords).toHaveBeenCalledTimes(1);
    expect(enrichKeywords).toHaveBeenCalledWith(["ao tv"], "GB", "en");
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO local_provider_keyword_inputs"),
      ),
    ).toBe(true);
  });

  it("collects SERP results in chunks and resumes remaining work", async () => {
    let now = 0;
    const work = [
      { item_key: "ao tv", provider_task_id: "t1", state: "submitted" },
      { item_key: "oled tv", provider_task_id: "t2", state: "submitted" },
    ];
    const dataForSeo = {
      readySerpTaskIds: vi.fn(async () => new Set(["t1"])),
      serpTaskResult: vi.fn(async () => {
        now += 10;
        return { features: [], results: [] };
      }),
      submitSerpTasks: vi.fn(),
    };
    const clientQuery = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (
        sql.includes("INSERT INTO local_provider_serp_keywords") ||
        sql.includes("DELETE FROM local_provider_serp_results") ||
        sql.includes("DELETE FROM project_serp_features") ||
        sql.includes("UPDATE provider_work_items")
      ) {
        if (sql.includes("state = 'succeeded'")) {
          work[0] = { ...work[0]!, state: "succeeded" };
        }
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SERP persist SQL: ${sql}`);
    });
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue).replace(/\s+/g, " ").trim();
      if (sql.includes("SELECT input->>'mode' AS mode")) {
        return { rowCount: 1, rows: [{ mode: "full" }] };
      }
      if (sql.includes("SELECT project.country, project.language, client.domain")) {
        return {
          rowCount: 1,
          rows: [{ country: "GB", domain: "ao.com", language: "en" }],
        };
      }
      if (sql.includes("FROM keyword_clusters")) {
        return {
          rowCount: 2,
          rows: [
            {
              avg_monthly_volume: 100,
              id: "00000000-0000-4000-8000-000000000021",
              keyword: "ao tv",
              normalised_keyword: "ao tv",
              provider_fetched_at: null,
              ranking_lookup_checked_at: null,
              ranking_url: null,
            },
            {
              avg_monthly_volume: 80,
              id: "00000000-0000-4000-8000-000000000022",
              keyword: "oled tv",
              normalised_keyword: "oled tv",
              provider_fetched_at: null,
              ranking_lookup_checked_at: null,
              ranking_url: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO provider_work_items")) {
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("FROM provider_work_items")) {
        return { rowCount: work.length, rows: work };
      }
      throw new Error(`Unexpected SERP hydration SQL: ${sql}`);
    });
    const hydrator = new LivePipelineProviderHydrator(
      dataForSeo as unknown as DataForSeoClient,
      {} as AhrefsClient,
      {} as AnthropicSiteArchitectureClient,
      async () => undefined,
      () => now,
      780_000,
      720_000,
      200,
      5,
      100,
    );
    const pool = {
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
      query,
    } as unknown as DatabasePool;

    await expect(
      hydrator.hydrate(
        pool,
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000004",
        "serp-collection",
      ),
    ).rejects.toMatchObject({
      code: "provider_hydration_incomplete",
      statusCode: 503,
    });
    expect(dataForSeo.serpTaskResult).toHaveBeenCalledTimes(1);
    expect(dataForSeo.submitSerpTasks).not.toHaveBeenCalled();
  });
});
