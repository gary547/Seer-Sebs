import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeClusterProperties,
  normaliseExactForm,
  normaliseKeyword,
  pickCanonical,
  pickCanonicalWithBasis,
} from "./keyword-cluster.ts";

// ── 55 inch tv fixture ──
// Mirrors §2.2 of docs/canonical-selection-mechanism-investigation-2026-07-21.md.
// Exact GSC clicks are per-member (post-fix), NOT the cluster-summed value.
const FIFTY_FIVE_INCH_TV_FIXTURE = [
  { id: "kw-55in-tv",              keyword: "55in tv",             base_rank: 11,   annual_volume: 594000, gsc_clicks: 25,   ranking_url: "https://ao.com/tvs/55-inch" },
  { id: "kw-55-inch-tv",           keyword: "55 inch tv",          base_rank: 14,   annual_volume: 43200,  gsc_clicks: 2170, ranking_url: "https://ao.com/tvs/55-inch" },
  { id: "kw-55-inch-television",   keyword: "55 inch television",  base_rank: 18,   annual_volume: 594000, gsc_clicks: 0,    ranking_url: "https://ao.com/tvs/55-inch" },
  { id: "kw-55-in-tvs",            keyword: "55-in tvs",           base_rank: 20,   annual_volume: 594000, gsc_clicks: 0,    ranking_url: null },
  { id: "kw-55inch-tv",            keyword: "55inch tv",           base_rank: null, annual_volume: 594000, gsc_clicks: 188,  ranking_url: null },
  { id: "kw-tv-55-inch",           keyword: "tv 55 inch",          base_rank: null, annual_volume: 43200,  gsc_clicks: 105,  ranking_url: null },
  { id: "kw-55-inch-tvs",          keyword: "55 inch tvs",         base_rank: null, annual_volume: 594000, gsc_clicks: 30,   ranking_url: null },
];

Deno.test("32-inch TV family collapses to a single key", () => {
  const variants = [
    "32 in tv",
    "32in tv",
    "tv 32 inch",
    "32 inch television",
    "32 INCH TV",
    "32-inch tv",
    "32inches tv",
  ];
  const keys = variants.map(normaliseKeyword);
  const first = keys[0];
  for (const k of keys) assertEquals(k, first, `variant should collapse: ${keys.join(" | ")}`);
});

Deno.test("seven diagnostic false-positive pairs stay distinct", () => {
  // Semantically distinct queries that happened to share annual volume in the
  // local-cluster-derivation diagnostic (§2). Form-based clustering must NOT
  // merge them.
  const pairs: Array<[string, string]> = [
    ["samsung tv remote", "sony tv remote"],
    ["lg oled 55", "lg oled 65"],
    ["tv wall mount", "tv stand"],
    ["smart tv", "4k tv"],
    ["hisense tv", "toshiba tv"],
    ["tv aerial", "tv antenna"],
    ["cheap tv", "used tv"],
  ];
  for (const [a, b] of pairs) {
    assertNotEquals(normaliseKeyword(a), normaliseKeyword(b), `must differ: ${a} vs ${b}`);
  }
});

Deno.test("idempotent", () => {
  for (const s of ["32 inch tv", "  Samsung   TV  Remote ", "lg-oled-55!", "TELEVISION 40 IN"]) {
    const once = normaliseKeyword(s);
    const twice = normaliseKeyword(once);
    assertEquals(once, twice, `not idempotent for: ${s}`);
  }
});

Deno.test("empty and null-ish inputs return empty string", () => {
  assertEquals(normaliseKeyword(""), "");
  assertEquals(normaliseKeyword("   "), "");
  // deno-lint-ignore no-explicit-any
  assertEquals(normaliseKeyword(null as any), "");
});

Deno.test("pickCanonical: lowest base_rank wins over higher-volume sibling", () => {
  const members = [
    { id: "a", keyword: "32 in tv",       base_rank: 4, annual_volume: 519800 },
    { id: "b", keyword: "32 inch tv",     base_rank: 1, annual_volume: 43200 },
    { id: "c", keyword: "32 inch television", base_rank: 12, annual_volume: 519800 },
  ];
  assertEquals(pickCanonical(members).id, "b");
});

Deno.test("pickCanonical: null base_rank sorts last", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: null, annual_volume: 999999 },
    { id: "b", keyword: "bbb", base_rank: 7,    annual_volume: 100 },
  ];
  assertEquals(pickCanonical(members).id, "b");
});

Deno.test("pickCanonical: volume tie-break when base_rank equal", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 3, annual_volume: 100 },
    { id: "b", keyword: "bbb", base_rank: 3, annual_volume: 500 },
    { id: "c", keyword: "ccc", base_rank: 3, annual_volume: 200 },
  ];
  assertEquals(pickCanonical(members).id, "b");
});

Deno.test("pickCanonical: alphabetical tie-break when rank and volume equal", () => {
  const members = [
    { id: "a", keyword: "zebra", base_rank: 5, annual_volume: 100 },
    { id: "b", keyword: "apple", base_rank: 5, annual_volume: 100 },
    { id: "c", keyword: "mango", base_rank: 5, annual_volume: 100 },
  ];
  assertEquals(pickCanonical(members).id, "b");
});

Deno.test("pickCanonical: exact '32 inch tv' case from production diagnostic", () => {
  // Members observed on TVs Ongoing under cluster_key '32 inch tv' — the old
  // (annual_volume DESC, base_rank ASC) rule picked '32 in tv'. New rule must
  // pick '32 inch tv' because it ranks at position 1.
  const members = [
    { id: "d0e55b50", keyword: "32 in tv",           base_rank: 4,  annual_volume: 519800 },
    { id: "6e76dc67", keyword: "32 inch tv",         base_rank: 1,  annual_volume: 305600 },
    { id: "89da40cc", keyword: "tv 32 inch",         base_rank: 2,  annual_volume: 287700 },
    { id: "2ac9e002", keyword: "32 inch television", base_rank: 12, annual_volume: 519800 },
    { id: "ea5ab648", keyword: "32in tv",            base_rank: 14, annual_volume: 519800 },
  ];
  assertEquals(pickCanonical(members).id, "6e76dc67");
});

Deno.test("pickCanonicalWithBasis: gsc_clicks wins over volume and rank", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 1,  annual_volume: 999999, gsc_clicks: 5 },
    { id: "b", keyword: "bbb", base_rank: 5,  annual_volume: 100,    gsc_clicks: 200 },
    { id: "c", keyword: "ccc", base_rank: 20, annual_volume: 500,    gsc_clicks: 0 },
  ];
  const r = pickCanonicalWithBasis(members);
  assertEquals(r.member.id, "b");
  assertEquals(r.basis, "gsc_clicks");
});

Deno.test("pickCanonicalWithBasis: falls back to volume when no gsc clicks", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 1, annual_volume: 100, gsc_clicks: 0 },
    { id: "b", keyword: "bbb", base_rank: 5, annual_volume: 500, gsc_clicks: null },
  ];
  const r = pickCanonicalWithBasis(members);
  assertEquals(r.member.id, "b");
  assertEquals(r.basis, "volume");
});

Deno.test("pickCanonicalWithBasis: falls back to base_rank when no clicks and no volume", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 7, annual_volume: 0, gsc_clicks: 0 },
    { id: "b", keyword: "bbb", base_rank: 3, annual_volume: 0, gsc_clicks: 0 },
    { id: "c", keyword: "ccc", base_rank: null, annual_volume: 0, gsc_clicks: 0 },
  ];
  const r = pickCanonicalWithBasis(members);
  assertEquals(r.member.id, "b");
  assertEquals(r.basis, "base_rank");
});

Deno.test("pickCanonicalWithBasis: alphabetical when nothing else discriminates", () => {
  const members = [
    { id: "a", keyword: "zebra", base_rank: null, annual_volume: 0, gsc_clicks: 0 },
    { id: "b", keyword: "apple", base_rank: null, annual_volume: 0, gsc_clicks: 0 },
    { id: "c", keyword: "mango", base_rank: null, annual_volume: 0, gsc_clicks: 0 },
  ];
  const r = pickCanonicalWithBasis(members);
  assertEquals(r.member.id, "b");
  assertEquals(r.basis, "alphabetical");
});

Deno.test("pickCanonicalWithBasis: gsc-clicks tie is broken by base_rank", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 4, annual_volume: 500, gsc_clicks: 100 },
    { id: "b", keyword: "bbb", base_rank: 1, annual_volume: 100, gsc_clicks: 100 },
  ];
  const r = pickCanonicalWithBasis(members);
  assertEquals(r.member.id, "b");
  assertEquals(r.basis, "gsc_clicks");
});

// ─── normaliseExactForm ───

Deno.test("normaliseExactForm: lower-cases and collapses whitespace, no folding", () => {
  assertEquals(normaliseExactForm("  55 INCH  TV  "), "55 inch tv");
  // Distinct forms must remain distinct (unlike normaliseKeyword).
  assertNotEquals(normaliseExactForm("55in tv"), normaliseExactForm("55 inch tv"));
  assertNotEquals(normaliseExactForm("tv 55 inch"), normaliseExactForm("55 inch tv"));
  assertEquals(normaliseExactForm(null), "");
  assertEquals(normaliseExactForm(undefined), "");
});

// ─── 55 inch tv fixture: canonical + cluster properties ───

Deno.test("55 inch tv fixture: canonical is '55 inch tv' on gsc_clicks basis", () => {
  const r = pickCanonicalWithBasis(FIFTY_FIVE_INCH_TV_FIXTURE);
  assertEquals(r.member.id, "kw-55-inch-tv");
  assertEquals(r.member.keyword, "55 inch tv");
  assertEquals(r.basis, "gsc_clicks");
});

Deno.test("55 inch tv fixture: cluster_volume_annual is MAX = 594000", () => {
  const p = computeClusterProperties(FIFTY_FIVE_INCH_TV_FIXTURE);
  assertEquals(p.cluster_volume_annual, 594000);
});

Deno.test("55 inch tv fixture: cluster_base_rank = 11 supplied by '55in tv'", () => {
  const p = computeClusterProperties(FIFTY_FIVE_INCH_TV_FIXTURE);
  assertEquals(p.cluster_base_rank, 11);
  assertEquals(p.cluster_base_rank_keyword_id, "kw-55in-tv");
});

Deno.test("55 inch tv fixture: cluster_ranking_url = single non-null URL, no conflict", () => {
  const p = computeClusterProperties(FIFTY_FIVE_INCH_TV_FIXTURE);
  assertEquals(p.cluster_ranking_url, "https://ao.com/tvs/55-inch");
  assertEquals(p.cluster_url_conflict, false);
});

Deno.test("cluster_url_conflict = true when members carry ≥2 distinct URLs", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 1, annual_volume: 100, ranking_url: "https://x.com/one" },
    { id: "b", keyword: "bbb", base_rank: 2, annual_volume: 100, ranking_url: "https://x.com/two" },
    { id: "c", keyword: "ccc", base_rank: 3, annual_volume: 100, ranking_url: null },
  ];
  const p = computeClusterProperties(members);
  assertEquals(p.cluster_url_conflict, true);
  // Mode picks whichever URL sorts earliest by representative keyword (a < b).
  assertEquals(p.cluster_ranking_url, "https://x.com/one");
});

Deno.test("cluster_ranking_url = null when all members have null URLs", () => {
  const members = [
    { id: "a", keyword: "aaa", base_rank: 1, annual_volume: 100, ranking_url: null },
    { id: "b", keyword: "bbb", base_rank: 2, annual_volume: 100, ranking_url: null },
  ];
  const p = computeClusterProperties(members);
  assertEquals(p.cluster_ranking_url, null);
  assertEquals(p.cluster_url_conflict, false);
});

Deno.test("cluster_base_rank tie-break: highest annual_volume DESC then keyword ASC", () => {
  const members = [
    { id: "a", keyword: "zebra", base_rank: 3, annual_volume: 100 },
    { id: "b", keyword: "apple", base_rank: 3, annual_volume: 500 },
    { id: "c", keyword: "mango", base_rank: 3, annual_volume: 500 },
  ];
  const p = computeClusterProperties(members);
  assertEquals(p.cluster_base_rank, 3);
  // Volume ties at 500 → keyword ASC picks 'apple'.
  assertEquals(p.cluster_base_rank_keyword_id, "b");
});
