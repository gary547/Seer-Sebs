// Deno tests for Link Power Score helpers.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildContextDivisors,
  computeLpsForRow,
  LPS_MODEL_VERSION,
  normUrl,
  scoreDistribution,
  type SerpRowMetrics,
} from "./link-power-score.ts";

function row(over: Partial<SerpRowMetrics> = {}): SerpRowMetrics {
  return {
    keyword_id: "k1",
    url_rating: 50,
    domain_rating: 60,
    referring_domains: 100,
    backlinks: 1000,
    ...over,
  };
}

Deno.test("model version constant", () => {
  assertEquals(LPS_MODEL_VERSION, "lps_v2.0.0");
});

Deno.test("linear clamp for UR/DR", () => {
  const ctx = buildContextDivisors([row()]);
  const r = computeLpsForRow(row({ url_rating: 150, domain_rating: -5 }), ctx);
  assertEquals(r.components.ur.score, 100);
  assertEquals(r.components.dr.score, null); // negative → treated as missing
  assert(r.missing.includes("dr"));
});

Deno.test("log normalisation uses project divisor when keyword has <3 rows", () => {
  const rows = [
    row({ keyword_id: "k1", referring_domains: 10, backlinks: 20 }),
    row({ keyword_id: "k2", referring_domains: 1000, backlinks: 5000 }),
  ];
  const ctx = buildContextDivisors(rows);
  const r = computeLpsForRow(rows[0], ctx);
  assertEquals(r.components.rd.divisor_source, "project");
  assertEquals(r.components.bl.divisor_source, "project");
  assert(r.components.rd.score !== null && r.components.rd.score > 0);
});

Deno.test("per-keyword divisor picked when keyword has ≥3 rows", () => {
  const rows: SerpRowMetrics[] = [
    row({ keyword_id: "k1", referring_domains: 10, backlinks: 100 }),
    row({ keyword_id: "k1", referring_domains: 100, backlinks: 1000 }),
    row({ keyword_id: "k1", referring_domains: 1000, backlinks: 10000 }),
  ];
  const ctx = buildContextDivisors(rows);
  const r = computeLpsForRow(rows[2], ctx);
  assertEquals(r.components.rd.divisor_source, "keyword");
  assertEquals(r.components.rd.score, 100);
});

Deno.test("confidence tiers reflect present-component count", () => {
  const ctx = buildContextDivisors([row()]);
  const full = computeLpsForRow(row(), ctx);
  assertEquals(full.confidence, "high");
  const two = computeLpsForRow(
    row({ referring_domains: null, backlinks: null }),
    ctx,
  );
  assertEquals(two.confidence, "medium");
  const zero = computeLpsForRow(
    { keyword_id: "k1", url_rating: null, domain_rating: null, referring_domains: null, backlinks: null },
    ctx,
  );
  assertEquals(zero.confidence, "low");
  assertEquals(zero.lps_score, 0);
  assertEquals(zero.reason, "no_metrics");
});

Deno.test("imputation from client_domain_metrics downgrades confidence", () => {
  const ctx = buildContextDivisors([row()]);
  const r = computeLpsForRow(
    row({ url_rating: null, domain_rating: null }),
    ctx,
    {
      clientDomain: "client.com",
      clientRef: { domain: "client.com", url_rating: 40, domain_rating: 50, ahrefs_rank: 1, fetched_at: null },
    },
  );
  assertEquals(r.components.ur.imputed, true);
  assertEquals(r.components.dr.imputed, true);
  // After imputation all 4 components are present (high) → downgraded once → medium
  assertEquals(r.confidence, "medium");

});

Deno.test("blend weights sum correctly when all present", () => {
  const ctx = buildContextDivisors([row()]);
  // Force divisors so rd/bl score 100 for a deterministic check
  const rows: SerpRowMetrics[] = [
    row({ keyword_id: "k1", referring_domains: 10, backlinks: 10 }),
    row({ keyword_id: "k1", referring_domains: 10, backlinks: 10 }),
    row({ keyword_id: "k1", referring_domains: 10, backlinks: 10 }),
  ];
  const ctx2 = buildContextDivisors(rows);
  const r = computeLpsForRow(row({ url_rating: 100, domain_rating: 100, referring_domains: 10, backlinks: 10 }), ctx2);
  // 100*(0.35+0.30+0.20+0.15) / 1.0 = 100
  assertEquals(r.lps_score, 100);
  void ctx;
});

Deno.test("scoreDistribution returns quantiles", () => {
  const d = scoreDistribution([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert(d.p10 <= d.p50 && d.p50 <= d.p90);
  assertEquals(d.mean, 55);
});

Deno.test("normUrl accepts http(s) and returns lowercased host without www", () => {
  const a = normUrl("HTTPS://WWW.Example.COM/Path?Q=1#frag");
  assert(a !== null);
  assertEquals(a!.domain, "example.com");
  // Fragment stripped; query preserved; host lowercased.
  assertEquals(a!.url, "https://www.example.com/Path?Q=1");
  const b = normUrl("http://sub.example.co.uk/");
  assertEquals(b?.domain, "sub.example.co.uk");
});

Deno.test("normUrl rejects empty, whitespace, and non-http(s) values", () => {
  assertEquals(normUrl(null), null);
  assertEquals(normUrl(undefined), null);
  assertEquals(normUrl(""), null);
  assertEquals(normUrl("   "), null);
  assertEquals(normUrl("mailto:foo@bar.com"), null);
  assertEquals(normUrl("ftp://example.com"), null);
  assertEquals(normUrl("not a url"), null);
});
