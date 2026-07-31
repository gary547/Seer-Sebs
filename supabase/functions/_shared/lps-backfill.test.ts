import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildBasicAuth } from "./dataforseo.ts";
import {
  ahrefsTargetKeys,
  buildUrlCandidates,
  chunk,
  coverageOf,
  dfsTargetKeys,
  filterCandidatesToFetch,
  normaliseDomain,
  normaliseUrl,
  parseAhrefsAuthorityBatch,
  parseDfsAuthorityBatch,
  runPool,
} from "./lps-backfill.ts";

Deno.test("normaliseUrl strips fragments, tracking, www, casing", () => {
  assertEquals(
    normaliseUrl("HTTPS://WWW.Example.com/Path?utm_source=x&keep=1#frag"),
    "https://example.com/Path?keep=1",
  );
  assertEquals(normaliseUrl("example.com"), "https://example.com");
  assertEquals(normaliseUrl(""), null);
  assertEquals(normaliseUrl(null), null);
  assertEquals(normaliseUrl("ftp://foo"), null);
});

Deno.test("normaliseDomain trims scheme, www, path", () => {
  assertEquals(normaliseDomain("https://WWW.Foo.com/bar?x=1"), "foo.com");
  assertEquals(normaliseDomain("foo.com"), "foo.com");
  assertEquals(normaliseDomain(""), null);
});

Deno.test("buildUrlCandidates dedups and aggregates rows", () => {
  const cands = buildUrlCandidates([
    { id: "a", url: "https://example.com/x?utm_source=y", domain: "example.com", url_rating: 10, referring_domains: null, fetched_at: "2026-01-01T00:00:00Z" },
    { id: "b", url: "https://www.example.com/x", domain: "example.com", url_rating: null, referring_domains: 3, fetched_at: "2026-06-01T00:00:00Z" },
    { id: "c", url: "https://other.com/", domain: "other.com", url_rating: null, referring_domains: null, fetched_at: null },
  ]);
  assertEquals(cands.length, 2);
  const merged = cands.find((c) => c.url === "https://example.com/x")!;
  assertEquals(merged.ids.sort(), ["a", "b"]);
  assertEquals(merged.hadUr, true);
  assertEquals(merged.hadRd, true);
  assertEquals(merged.freshest, "2026-06-01T00:00:00Z");
});

Deno.test("filterCandidatesToFetch keeps missing or stale rows", () => {
  const now = "2026-07-01T00:00:00Z";
  const cands = buildUrlCandidates([
    { id: "1", url: "https://a.com/", domain: "a.com", url_rating: 10, domain_rating: 20, referring_domains: 1, backlinks: 10, fetched_at: "2026-06-30T00:00:00Z" }, // fresh + full
    { id: "2", url: "https://b.com/", domain: "b.com", url_rating: null, domain_rating: null, referring_domains: null, backlinks: null, fetched_at: null },                // missing
    { id: "3", url: "https://c.com/", domain: "c.com", url_rating: 5, domain_rating: 10, referring_domains: 2, backlinks: 20, fetched_at: "2025-01-01T00:00:00Z" },   // stale
  ]);
  const toFetch = filterCandidatesToFetch(cands, 90, now);
  const urls = toFetch.map((c) => c.url).sort();
  assertEquals(urls, ["https://b.com", "https://c.com"]);
});

Deno.test("coverageOf reports UR/RD ratios", () => {
  const stats = coverageOf([
    { id: "1", url: "u", domain: "d", url_rating: 10, domain_rating: 20, referring_domains: 3, backlinks: 30, fetched_at: null },
    { id: "2", url: "u", domain: "d", url_rating: null, domain_rating: null, referring_domains: null, backlinks: 0, fetched_at: null },
  ]);
  assertEquals(stats.total, 2);
  assertEquals(stats.with_ur, 1);
  assertEquals(stats.with_dr, 1);
  assertEquals(stats.with_rd, 1);
  assertEquals(stats.with_bl, 2);
  assertEquals(stats.pct_ur, 0.5);
  assertEquals(stats.pct_dr, 0.5);
  assertEquals(stats.pct_rd, 0.5);
  assertEquals(stats.pct_bl, 1);
});

Deno.test("LPS uses shared DataForSEO Basic Auth contract", () => {
  assertEquals(buildBasicAuth("login:password"), btoa("login:password"));
  assertEquals(buildBasicAuth("bG9naW46cGFzc3dvcmQ="), "bG9naW46cGFzc3dvcmQ=");
});

Deno.test("ahrefsTargetKeys supports canonical URL and domain variants", () => {
  const keys = ahrefsTargetKeys("https://www.Example.com/path/?utm_source=x");
  assertEquals(keys.includes("https://example.com/path/"), true);
  assertEquals(ahrefsTargetKeys("example.com").includes("https://example.com"), true);
});

Deno.test("parseAhrefsAuthorityBatch parses UR, DR, RD and BL", () => {
  const parsed = parseAhrefsAuthorityBatch(["https://example.com/a"], {
    targets: [{
      url: "https://www.example.com/a",
      url_rating: 41,
      domain_rating: 76,
      ahrefs_rank: 12345,
      refdomains: 88,
      backlinks: 901,
    }],
  });
  const v = parsed.values.get("https://example.com/a");
  assertEquals(v?.url_rating, 41);
  assertEquals(v?.domain_rating, 76);
  assertEquals(v?.ahrefs_rank, 12345);
  assertEquals(v?.referring_domains, 88);
  assertEquals(v?.backlinks, 901);
  assertEquals(parsed.diagnostics.ur_matched, 1);
  assertEquals(parsed.diagnostics.dr_matched, 1);
  assertEquals(parsed.diagnostics.rd_matched, 1);
  assertEquals(parsed.diagnostics.bl_matched, 1);
});

Deno.test("parseAhrefsAuthorityBatch falls back to response order", () => {
  const parsed = parseAhrefsAuthorityBatch(["https://example.com/a", "https://example.com/b"], {
    targets: [
      { url_rating: 1, refdomains: 2, backlinks: 3 },
      { url_rating: 4, refdomains: 5, backlinks: 6 },
    ],
  });
  assertEquals(parsed.values.get("https://example.com/a")?.referring_domains, 2);
  assertEquals(parsed.values.get("https://example.com/b")?.backlinks, 6);
  assertEquals(parsed.diagnostics.matched, 2);
});

Deno.test("dfsTargetKeys supports exact, URL, and domain matching", () => {
  assertEquals(
    dfsTargetKeys("https://www.Example.com/path/?utm_source=x").includes("https://example.com/path/"),
    true,
  );
  assertEquals(dfsTargetKeys("https://www.Example.com/path/").includes("example.com"), true);
});

Deno.test("parseDfsAuthorityBatch parses success values including zero", () => {
  const refData = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { target: "https://example.com/a", referring_domains: 0 },
  ] }] }] };
  const blData = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { target: "https://example.com/a", backlinks: 12 },
  ] }] }] };
  const parsed = parseDfsAuthorityBatch(["https://example.com/a"], refData, blData);
  assertEquals(parsed.values.get("https://example.com/a")?.referring_domains, 0);
  assertEquals(parsed.values.get("https://example.com/a")?.backlinks, 12);
  assertEquals(parsed.diagnostics.rd_matched, 1);
  assertEquals(parsed.diagnostics.bl_matched, 1);
});

Deno.test("parseDfsAuthorityBatch reports empty successful items", () => {
  const data = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] };
  const parsed = parseDfsAuthorityBatch(["https://example.com/a"], data, data);
  assertEquals(parsed.diagnostics.ok, true);
  assertEquals(parsed.diagnostics.no_data_targets, 1);
  assertEquals(parsed.values.get("https://example.com/a")?.referring_domains, null);
});

Deno.test("parseDfsAuthorityBatch flags non-success task status", () => {
  const data = { status_code: 20000, tasks: [{ status_code: 40501, status_message: "Invalid Field", result: [] }] };
  const parsed = parseDfsAuthorityBatch(["https://example.com/a"], data, data);
  assertEquals(parsed.diagnostics.ok, false);
  assertEquals(parsed.diagnostics.rd_status_code, 40501);
});

Deno.test("parseDfsAuthorityBatch tolerates provider target canonicalisation", () => {
  const refData = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { target: "https://www.example.com/a", referring_domains: 7 },
  ] }] }] };
  const blData = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { target: "https://example.com/a", backlinks: 70 },
  ] }] }] };
  const parsed = parseDfsAuthorityBatch(["https://example.com/a"], refData, blData);
  assertEquals(parsed.values.get("https://example.com/a")?.referring_domains, 7);
  assertEquals(parsed.values.get("https://example.com/a")?.backlinks, 70);
});

Deno.test("chunk splits arrays", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 3), []);
});

Deno.test("runPool respects concurrency limit", async () => {
  let inFlight = 0;
  let maxSeen = 0;
  await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
    inFlight++;
    maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assertEquals(maxSeen <= 2, true);
});
