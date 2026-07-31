import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { deriveBaseRank, hostFromUrl, normalizeHost } from "./base-rank-derivation.ts";

const NEVER: import("./base-rank-derivation.ts").ExistingKeyword = {
  base_rank: null, ranking_url: null, base_rank_source: null,
  base_rank_checked_at: null, ranking_lookup_checked_at: null,
};

Deno.test("normalizeHost — lowercases, strips scheme/www/path/hash", () => {
  assertEquals(normalizeHost("ao.com"), "ao.com");
  assertEquals(normalizeHost("www.ao.com"), "ao.com");
  assertEquals(normalizeHost("https://AO.COM/"), "ao.com");
  assertEquals(normalizeHost("http://www.ao.com/24-inch-tv?x=1#y"), "ao.com");
  assertEquals(normalizeHost(null), null);
  assertEquals(normalizeHost(""), null);
});

Deno.test("hostFromUrl — URLs and bare hosts alike", () => {
  assertEquals(hostFromUrl("https://www.ao.com/tvs"), "ao.com");
  assertEquals(hostFromUrl("ao.com"), "ao.com");
  assertEquals(hostFromUrl("help.ao.com"), "help.ao.com");
});

Deno.test("serp_hit — client appears in latest snapshot", () => {
  const r = deriveBaseRank(
    "ao.com",
    [
      { rank_absolute: 3, url: "https://www.ao.com/24-inch-tv", domain: "ao.com", fetched_at: "2026-07-15T00:00:00Z" },
      { rank_absolute: 1, url: "https://currys.co.uk/tv", domain: "currys.co.uk", fetched_at: "2026-07-15T00:00:00Z" },
    ],
    NEVER,
  );
  assertEquals(r.base_rank, 3);
  assertEquals(r.ranking_url, "https://www.ao.com/24-inch-tv");
  assertEquals(r.base_rank_source, "serp_results");
  assertEquals(r.base_rank_checked_at, "2026-07-15T00:00:00Z");
  assertEquals(r.action, "serp_hit");
});

Deno.test("multiple client rows — picks lowest rank_absolute", () => {
  const r = deriveBaseRank(
    "ao.com",
    [
      { rank_absolute: 8, url: "https://ao.com/tvs/24", domain: "ao.com", fetched_at: "2026-07-15T00:00:00Z" },
      { rank_absolute: 3, url: "https://ao.com/24-inch-tv", domain: "ao.com", fetched_at: "2026-07-15T00:00:00Z" },
      { rank_absolute: 5, url: "https://ao.com/small-tvs", domain: "ao.com", fetched_at: "2026-07-15T00:00:00Z" },
    ],
    NEVER,
  );
  assertEquals(r.base_rank, 3);
  assertEquals(r.action, "serp_hit");
});

Deno.test("subdomain does NOT count as client", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 4, url: "https://help.ao.com/faq", domain: "help.ao.com", fetched_at: "2026-07-15T00:00:00Z" }],
    NEVER,
  );
  assertEquals(r.base_rank, null);
  assertEquals(r.action, "noop");
});

Deno.test("absent from snapshot — existing Labs value preserved", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 1, url: "https://currys.co.uk", domain: "currys.co.uk", fetched_at: "2026-07-15T00:00:00Z" }],
    { ...NEVER, base_rank: 12, ranking_url: "/24-inch-tv", base_rank_source: "dfs_labs", base_rank_checked_at: "2026-05-05T00:00:00Z" },
  );
  assertEquals(r.base_rank, 12);
  assertEquals(r.ranking_url, "/24-inch-tv");
  assertEquals(r.base_rank_source, "dfs_labs");
  assertEquals(r.action, "unchanged");
});

Deno.test("absent from snapshot + legacy row without new columns — stamps dfs_labs", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 1, url: "https://currys.co.uk", domain: "currys.co.uk", fetched_at: "2026-07-15T00:00:00Z" }],
    { ...NEVER, base_rank: 9, ranking_url: "/x", ranking_lookup_checked_at: "2026-05-05T00:00:00Z" },
  );
  assertEquals(r.base_rank, 9);
  assertEquals(r.base_rank_source, "dfs_labs");
  assertEquals(r.base_rank_checked_at, "2026-05-05T00:00:00Z");
  assertEquals(r.action, "dfs_stamped");
});

Deno.test("older Labs never overwrites newer serp_results", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 4, url: "https://ao.com/x", domain: "ao.com", fetched_at: "2026-07-15T00:00:00Z" }],
    { ...NEVER, base_rank: 12, ranking_url: "/old", base_rank_source: "dfs_labs", base_rank_checked_at: "2026-05-05T00:00:00Z" },
  );
  assertEquals(r.base_rank, 4);
  assertEquals(r.base_rank_source, "serp_results");
  assertEquals(r.action, "serp_hit");
});

Deno.test("Labs newer than snapshot — Labs wins", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 8, url: "https://ao.com/x", domain: "ao.com", fetched_at: "2026-06-01T00:00:00Z" }],
    { ...NEVER, base_rank: 3, ranking_url: "/labs", base_rank_source: "dfs_labs", base_rank_checked_at: "2026-07-01T00:00:00Z" },
  );
  assertEquals(r.base_rank, 3);
  assertEquals(r.base_rank_source, "dfs_labs");
  assertEquals(r.action, "dfs_kept_fresher");
});

Deno.test("existing serp_results value is not overwritten by an older snapshot", () => {
  const r = deriveBaseRank(
    "ao.com",
    [{ rank_absolute: 8, url: "https://ao.com/x", domain: "ao.com", fetched_at: "2026-06-01T00:00:00Z" }],
    { ...NEVER, base_rank: 4, ranking_url: "/newer", base_rank_source: "serp_results", base_rank_checked_at: "2026-07-15T00:00:00Z" },
  );
  assertEquals(r.base_rank, 4);
  assertEquals(r.base_rank_checked_at, "2026-07-15T00:00:00Z");
  assertEquals(r.action, "unchanged");
});

Deno.test("null client domain — safe no-op", () => {
  const r = deriveBaseRank(null, [], { ...NEVER, base_rank: 5, ranking_url: "/x" });
  assertEquals(r.action, "noop");
  assertEquals(r.base_rank, 5);
});
