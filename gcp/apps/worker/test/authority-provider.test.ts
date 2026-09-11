import { describe, expect, it, vi } from "vitest";

import { DataForSeoAuthorityClient } from "../src/live-providers.js";
import { StageContinuation } from "../src/stage-continuation.js";

function response(result: unknown[], code = 20000): Response {
  return Response.json({ status_code: 20000, tasks: [{ status_code: code, result }] });
}

describe("DataForSEO authority adapter", () => {
  it("checkpoints completed pages before continuing at the delivery deadline", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_, init) => {
      const [{ targets }] = JSON.parse(String(init?.body)) as [{ targets: string[] }];
      return response([{ items: targets.map(url => ({ url, rank: 20, main_domain_rank: 30, backlinks: 1, referring_domains: 1 })) }]);
    });
    const saved: string[] = [];
    let budget = 1;
    await expect(new DataForSeoAuthorityClient("encoded", fetcher).metrics(
      Array.from({ length: 101 }, (_, i) => ({ mode: "exact" as const, url: `https://example.test/${i}` })), {
        checkBudget: () => { if (budget-- === 0) throw new StageContinuation(); },
        savePages: async values => { saved.push(...values.keys()); },
      },
    )).rejects.toMatchObject({ code: "stage_continuation" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(100);
  });

  it("saves usable pages from a partially completed batch when a domain fallback fails", async () => {
    const good = "https://example.test/good";
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes("bulk_pages")
      ? response([{ items: [{ url: good, rank: 0, main_domain_rank: 30, backlinks: 0, referring_domains: 0 }] }])
      : new Response("rejected", { status: 403 }));
    const saved: string[] = [];
    await expect(new DataForSeoAuthorityClient("encoded", fetcher).metrics([
      { mode: "exact", url: good }, { mode: "exact", url: "https://other.test/missing" },
    ], { savePages: async values => { saved.push(...values.keys()); } }))
      .rejects.toMatchObject({ code: "dataforseo_backlinks_access_rejected" });
    expect(saved).toEqual([good]);
  });
  it("maps domain summaries on the 0–100 scale without fabricating Ahrefs Rank", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([{ target: "example.test", rank: 61, backlinks: 250, referring_domains: 80 }]));
    const client = new DataForSeoAuthorityClient("login:password", fetcher);
    const result = await client.metrics([{ mode: "domain", url: "example.test" }]);
    expect(result.get("example.test")).toEqual({ domainRating: 61, urlRating: null, backlinks: 250, referringDomains: 80, ahrefsRank: null, source: "dataforseo", scope: "domain" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual([{ target: "example.test", include_subdomains: true, rank_scale: "one_hundred" }]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Basic ${Buffer.from("login:password").toString("base64")}`);
  });

  it("matches reordered page results by URL and preserves valid zero metrics", async () => {
    const first = "https://example.test/one";
    const second = "https://example.test/two";
    const fetcher = vi.fn<typeof fetch>(async () => response([{ items: [
      { url: second, rank: 20, main_domain_rank: 60, backlinks: 80, referring_domains: 50 },
      { url: first, rank: 0, main_domain_rank: 60, backlinks: 0, referring_domains: 0 },
    ] }]));
    const result = await new DataForSeoAuthorityClient("encoded", fetcher).metrics([{ mode: "exact", url: first }, { mode: "exact", url: second }]);
    expect(result.get(first)).toMatchObject({ urlRating: 0, backlinks: 0, referringDomains: 0, scope: "page" });
    expect(result.get(second)).toMatchObject({ urlRating: 20, domainRating: 60 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back missing pages to their own domain and fetches each domain only once", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("bulk_pages")
      ? response([{ items: [] }])
      : response([{ target: "example.test", rank: 45, backlinks: 250, referring_domains: 50 }]));
    const result = await new DataForSeoAuthorityClient("encoded", fetcher).metrics([
      { mode: "exact", url: "https://example.test/one" }, { mode: "exact", url: "https://example.test/two" },
    ]);
    expect([...result.values()]).toHaveLength(2);
    for (const metrics of result.values()) expect(metrics).toMatchObject({ domainRating: 45, urlRating: 45, backlinks: 250, referringDomains: 50, scope: "domain_fallback" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds batches to at most 100 targets/domains and deduplicates pages", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_, init) => {
      const [{ targets }] = JSON.parse(String(init?.body)) as [{ targets: string[] }];
      return response([{ items: targets.map((url) => ({ url, rank: 20, main_domain_rank: 30, backlinks: 1, referring_domains: 1 })) }]);
    });
    const targets = Array.from({ length: 101 }, (_, i) => ({ mode: "exact" as const, url: `https://example${i}.test/page` }));
    const result = await new DataForSeoAuthorityClient("encoded", fetcher).metrics([...targets, targets[0]!]);
    expect(result.size).toBe(101);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(String(init?.body))[0].targets.length).toBeLessThanOrEqual(100);
  });

  it.each([401, 403, 40100, 40204, 40207])("fails immediately for access rejection %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => status < 1000 ? new Response("rejected", { status }) : response([], status));
    const wait = vi.fn(async () => undefined);
    await expect(new DataForSeoAuthorityClient("encoded", fetcher, wait).metrics([{ mode: "domain", url: "example.test" }])).rejects.toMatchObject({ code: "dataforseo_backlinks_access_rejected", statusCode: 424 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([40202, 40209, 50000, 503])("caps HTTP and task-level transient retries at five for %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => status < 1000 ? new Response("unavailable", { status }) : response([], status));
    const wait = vi.fn(async () => undefined);
    await expect(new DataForSeoAuthorityClient("encoded", fetcher, wait).metrics([{ mode: "domain", url: "example.test" }])).rejects.toMatchObject({ statusCode: 424 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it("rejects top-level errors even if a nested task claims success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status_code: 40204, tasks: [{ status_code: 20000 }] }));
    await expect(new DataForSeoAuthorityClient("encoded", fetcher).metrics([{ mode: "domain", url: "example.test" }])).rejects.toMatchObject({ code: "dataforseo_backlinks_access_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete domain data and unexpected scales instead of inventing zero values", async () => {
    for (const row of [{ target: "example.test", rank: 450, backlinks: 2, referring_domains: 1 }, { target: "example.test", rank: 40 }]) {
      const fetcher = vi.fn<typeof fetch>(async () => response([row]));
      await expect(new DataForSeoAuthorityClient("encoded", fetcher).metrics([{ mode: "domain", url: "example.test" }])).rejects.toMatchObject({ code: "dataforseo_backlinks_request_failed" });
    }
  });
});
