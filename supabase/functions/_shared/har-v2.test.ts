import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalUrl,
  clamp,
  computeScenario,
  HAR_V2_MODEL_VERSION,
  pBeat,
  resolveClientRankingUrl,
  scenarioFloorMultiplier,
  scenarioThreshold,
  serpPenalty,
  sigmoid,
  type CompetitorRow,
  type CompositeInputs,
  type ScoringConfig,
} from "./har-v2.ts";

Deno.test("canonicalUrl lowercases host, strips www + trailing slash", () => {
  assertEquals(canonicalUrl("HTTPS://WWW.Example.COM/Foo/"), "https://example.com/Foo");
  assertEquals(canonicalUrl("https://example.com/"), "https://example.com/");
  assertEquals(canonicalUrl("mailto:foo@bar"), null);
  assertEquals(canonicalUrl(null), null);
});

Deno.test("canonicalUrl strips tracking params and normalises path", () => {
  // srsltid + trailing slash before query
  assertEquals(
    canonicalUrl("https://www.musicmagpie.co.uk/store/laptops/?srsltid=AfmBOoq123"),
    "https://musicmagpie.co.uk/store/laptops",
  );
  // Should equal the client-side resolved URL
  assertEquals(
    canonicalUrl("https://www.musicmagpie.co.uk/store/laptops/?srsltid=AfmBOoq123"),
    canonicalUrl("https://musicmagpie.co.uk/store/laptops/"),
  );
  // utm_* stripped, non-tracking param preserved
  assertEquals(
    canonicalUrl("https://example.com/p?utm_source=x&utm_medium=y&id=42"),
    "https://example.com/p?id=42",
  );
  // gclid + fbclid + msclkid stripped
  assertEquals(
    canonicalUrl("https://example.com/p?gclid=a&fbclid=b&msclkid=c"),
    "https://example.com/p",
  );
  // Root slash preserved
  assertEquals(canonicalUrl("https://example.com/?utm_source=x"), "https://example.com/");
  // Duplicate slashes collapsed
  assertEquals(canonicalUrl("https://example.com//a///b/"), "https://example.com/a/b");
  // Multiple kept params sorted for stability
  assertEquals(
    canonicalUrl("https://example.com/p?b=2&a=1"),
    "https://example.com/p?a=1&b=2",
  );
});

Deno.test("resolveClientRankingUrl handles path + absolute + missing", () => {
  assertEquals(
    resolveClientRankingUrl("/store/laptops/", "musicmagpie.co.uk"),
    "https://musicmagpie.co.uk/store/laptops",
  );
  assertEquals(
    resolveClientRankingUrl("https://www.musicmagpie.co.uk/store/", null),
    "https://musicmagpie.co.uk/store",
  );
  assertEquals(resolveClientRankingUrl(null, "x.com"), null);
  assertEquals(resolveClientRankingUrl("/x", null), null);
});

Deno.test("computeScenario surfaces no_beat_reason when ladder fails", () => {
  const comps: CompetitorRow[] = [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 90, domain_rating: 95, lps_score: 90 },
    { rank_absolute: 2, url: "b", domain: "b", url_rating: 85, domain_rating: 92, lps_score: 85 },
  ];
  const inp: CompositeInputs = {
    client_lps: 5, client_ur: 5, client_dr: 10, competitors: comps,
    content_fit_score: 0.3, serp_feature_count: 0, top_serp_feature: null,
    snippet_opportunity: null, base_rank: null,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
    client_lps_source: "serp_row",
  };
  const r = computeScenario(inp, "conservative", null);
  assertEquals(r.har_position, null);
  const nbr = (r.explanation_json as any).no_beat_reason;
  assert(nbr && nbr.reason === "authority_below_threshold");
  assert(nbr.best_p_beat != null && nbr.best_p_beat < 0.6);
});

Deno.test("synthetic client LPS applies lighter confidence penalty", () => {
  const comps: CompetitorRow[] = [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 30, domain_rating: 50, lps_score: 40 },
  ];
  const base: CompositeInputs = {
    client_lps: 42, client_ur: 20, client_dr: 40, competitors: comps,
    content_fit_score: 0.7, serp_feature_count: 0, top_serp_feature: null,
    snippet_opportunity: null, base_rank: 10,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
  };
  const real = computeScenario({ ...base, client_lps_source: "serp_row" }, "realistic", null);
  const synth = computeScenario({ ...base, client_lps_source: "synthetic_client_domain" }, "realistic", null);
  assert(synth.har_confidence < real.har_confidence);
  assert(Math.abs((real.har_confidence - synth.har_confidence) - 0.05) < 1e-6);
  const missing = (synth.explanation_json as any).missing as string[];
  assert(missing.includes("client_lps_synthetic"));
});



Deno.test("clamp/sigmoid basics", () => {
  assertEquals(clamp(5, 0, 3), 3);
  assertEquals(clamp(-1, 0, 3), 0);
  assert(Math.abs(sigmoid(0) - 0.5) < 1e-9);
});

Deno.test("serpPenalty saturates at 0.35", () => {
  assertEquals(serpPenalty(null, null), 0);
  assertEquals(serpPenalty(0, "featured_snippet"), 0.10);
  assert(serpPenalty(100, "featured_snippet") === 0.35);
});

Deno.test("pBeat returns null when competitor has no authority", () => {
  const comp: CompetitorRow = {
    rank_absolute: 1, url: "x", domain: "x", url_rating: null, domain_rating: null, lps_score: null,
  };
  assertEquals(pBeat(50, 30, comp, 0.5, 0), null);
});

Deno.test("pBeat uses LPS gap when available", () => {
  const comp: CompetitorRow = {
    rank_absolute: 1, url: "x", domain: "x", url_rating: 10, domain_rating: null, lps_score: 40,
  };
  const p = pBeat(60, 10, comp, 0.5, 0);
  assert(p != null && p > 0.5, `expected > 0.5, got ${p}`);
});

const baseInputs = (over: Partial<CompositeInputs> = {}): CompositeInputs => ({
  client_lps: 60,
  client_ur: 20,
  client_dr: 40,
  competitors: [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 30, domain_rating: 50, lps_score: 40 },
    { rank_absolute: 2, url: "b", domain: "b", url_rating: 40, domain_rating: 55, lps_score: 55 },
    { rank_absolute: 3, url: "c", domain: "c", url_rating: 20, domain_rating: 30, lps_score: 25 },
  ],
  content_fit_score: 0.7,
  serp_feature_count: 1,
  top_serp_feature: null,
  snippet_opportunity: null,
  base_rank: 15,
  latest_lps_run_exists: true,
  has_client_lps_row: true,
  has_client_authority: true,
  ...over,
});

Deno.test("computeScenario ladder finds beatable rank", () => {
  const r = computeScenario(baseInputs(), "realistic", null);
  assert(r.har_position != null && r.har_position >= 1);
});

Deno.test("computeScenario skips missing-authority competitors", () => {
  const inp = baseInputs({
    competitors: [
      { rank_absolute: 1, url: "a", domain: "a", url_rating: null, domain_rating: null, lps_score: null },
      { rank_absolute: 2, url: "b", domain: "b", url_rating: 40, domain_rating: 55, lps_score: 55 },
    ],
  });
  const r = computeScenario(inp, "realistic", null);
  const ladder = (r.explanation_json as any).ladder as any[];
  assertEquals(ladder[0].skipped, "missing_competitor_authority");
});

Deno.test("base_rank floor clamps optimistic v2 positions", () => {
  const r = computeScenario(baseInputs({ base_rank: 20 }), "realistic", null);
  const floor = Math.max(1, Math.round(20 * scenarioFloorMultiplier("realistic")));
  if (r.har_position != null) assert(r.har_position >= floor, `expected ≥ ${floor}, got ${r.har_position}`);
});

Deno.test("override precedence: all scenarios use v1 HAR at confidence 1.0", () => {
  const r = computeScenario(baseInputs(), "stretch", { har: 3, v1_forecast_id: "f1" });
  assertEquals(r.har_position, 3);
  assertEquals(r.har_confidence, 1);
  assertEquals((r.explanation_json as any).override.source, "v1_manual");
});

Deno.test("missing LPS run lowers confidence but still returns a row", () => {
  const r = computeScenario(
    baseInputs({ latest_lps_run_exists: false, has_client_lps_row: false, client_lps: null }),
    "realistic",
    null,
  );
  assert(r.har_confidence < 0.7, `confidence should be reduced, got ${r.har_confidence}`);
});

Deno.test("scenario thresholds are ordered", () => {
  assert(scenarioThreshold("conservative") > scenarioThreshold("realistic"));
  assert(scenarioThreshold("realistic") > scenarioThreshold("stretch"));
});

Deno.test("client_lps_match surfaces in explanation for each source", () => {
  const rankingUrl = computeScenario(
    baseInputs({ client_lps_source: "serp_row", client_lps_match: "ranking_url" }),
    "realistic",
    null,
  );
  assertEquals((rankingUrl.explanation_json as any).inputs.client_lps_match, "ranking_url");

  const fallback = computeScenario(
    baseInputs({ client_lps_source: "serp_row", client_lps_match: "domain_fallback" }),
    "realistic",
    null,
  );
  assertEquals((fallback.explanation_json as any).inputs.client_lps_match, "domain_fallback");

  const synth = computeScenario(
    baseInputs({ client_lps_source: "synthetic_client_domain", client_lps_match: "synthetic" }),
    "realistic",
    null,
  );
  assertEquals((synth.explanation_json as any).inputs.client_lps_match, "synthetic");

  // Defaults when not supplied
  const defaultReal = computeScenario(baseInputs({ client_lps_source: "serp_row" }), "realistic", null);
  assertEquals((defaultReal.explanation_json as any).inputs.client_lps_match, "ranking_url");
});

Deno.test("p_att = tempered beat probability of marginal competitor (deep ladder)", () => {
  // 10 non-beaten competitors at p≈0.15, then one beaten at p≈0.5.
  // With contentFit=0.5 and no SERP features, p = sigmoid(3.2 * (client_lps - comp_lps) / 100).
  // p=0.15 requires comp_lps ≈ client_lps + 54.21; p=0.5 requires comp_lps == client_lps.
  const clientLps = 40;
  const strong: CompetitorRow[] = Array.from({ length: 10 }, (_, i) => ({
    rank_absolute: i + 1,
    url: `s${i}`,
    domain: `s${i}`,
    url_rating: 50,
    domain_rating: 60,
    lps_score: 94.21,
  }));
  const marginal: CompetitorRow = {
    rank_absolute: 11, url: "m", domain: "m", url_rating: 50, domain_rating: 60, lps_score: 40,
  };
  const inp: CompositeInputs = {
    client_lps: clientLps, client_ur: 20, client_dr: 40,
    competitors: [...strong, marginal],
    content_fit_score: 0.5,
    serp_feature_count: 0, top_serp_feature: null, snippet_opportunity: null,
    base_rank: null,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
    client_lps_source: "serp_row",
  };
  const r = computeScenario(inp, "realistic", null);
  assertEquals(r.har_position, 11);
  // New p_att ≈ 0.5 (tempered p of marginal competitor, probFactor=1 for realistic).
  assert(
    r.rank_attainment_probability != null &&
      Math.abs(r.rank_attainment_probability - 0.5) < 0.02,
    `expected p_att ≈ 0.5, got ${r.rank_attainment_probability}`,
  );
  const legacy = (r.explanation_json as any).p_att_legacy;
  assert(legacy && legacy.formula === "legacy_noisy_or");
  // Legacy noisy-OR ≈ 1 - 0.85^10 * 0.5 ≈ 0.90 — must diverge markedly from new p_att.
  assert(legacy.value > 0.85, `expected legacy > 0.85, got ${legacy.value}`);
  assert(legacy.value - (r.rank_attainment_probability ?? 0) > 0.3);
});

Deno.test("p_att_legacy is null when no competitor is beaten", () => {
  const comps: CompetitorRow[] = [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 90, domain_rating: 95, lps_score: 90 },
  ];
  const inp: CompositeInputs = {
    client_lps: 5, client_ur: 5, client_dr: 10, competitors: comps,
    content_fit_score: 0.3, serp_feature_count: 0, top_serp_feature: null,
    snippet_opportunity: null, base_rank: null,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
    client_lps_source: "serp_row",
  };
  const r = computeScenario(inp, "realistic", null);
  assertEquals(r.har_position, null);
  assertEquals((r.explanation_json as any).p_att_legacy, null);
});

Deno.test("HAR_V2_MODEL_VERSION bumped to har_v2.1.0", () => {
  assertEquals(HAR_V2_MODEL_VERSION, "har_v2.1.0");
});

Deno.test("synthetic client LPS yields varied per-competitor p_beat (vs UR fallback flattening)", () => {
  // Client synthetic LPS, competitors with distinct lps_score → per-competitor
  // LPS-vs-LPS pBeat must vary.
  // Client synthetic LPS, competitors with distinct lps_score arranged
  // strongest-first so the ladder walks all rows before beating the last.
  const synthComps: CompetitorRow[] = [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 30, domain_rating: 50, lps_score: 60 },
    { rank_absolute: 2, url: "b", domain: "b", url_rating: 30, domain_rating: 50, lps_score: 50 },
    { rank_absolute: 3, url: "c", domain: "c", url_rating: 30, domain_rating: 50, lps_score: 40 },
    { rank_absolute: 4, url: "d", domain: "d", url_rating: 30, domain_rating: 50, lps_score: 30 },
    { rank_absolute: 5, url: "e", domain: "e", url_rating: 30, domain_rating: 50, lps_score: 20 },
  ];
  const synthInp: CompositeInputs = {
    client_lps: 25, client_ur: 30, client_dr: 40, competitors: synthComps,

    content_fit_score: 0.5, serp_feature_count: 0, top_serp_feature: null,
    snippet_opportunity: null, base_rank: null,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
    client_lps_source: "synthetic_client_domain", client_lps_match: "synthetic",
  };
  const synthR = computeScenario(synthInp, "realistic", null);
  const synthLadder = (synthR.explanation_json as any).ladder as any[];
  const synthPs = new Set(synthLadder.map((l) => Math.round((l.p_beat ?? 0) * 1000) / 1000));
  assert(synthPs.size > 1, `synthetic LPS should yield varied p_beat, got ${[...synthPs]}`);

  // UR-fallback flattening: client_lps null + competitors with identical UR
  // → every pBeat collapses to the same value.
  const urComps: CompetitorRow[] = synthComps.map((c) => ({ ...c, lps_score: null, url_rating: 30 }));
  const urR = computeScenario(
    { ...synthInp, client_lps: null, competitors: urComps, client_lps_source: "unavailable", client_lps_match: "unavailable" },
    "realistic",
    null,
  );
  const urLadder = (urR.explanation_json as any).ladder as any[];
  const urPs = new Set(urLadder.map((l) => Math.round((l.p_beat ?? 0) * 1000) / 1000));
  assertEquals(urPs.size, 1, `UR-fallback with identical UR should collapse p_beat, got ${[...urPs]}`);
});

Deno.test("client_lps_basis derived enum covers serp_row/domain_fallback/synthetic/unavailable", () => {
  const cases: Array<[Partial<CompositeInputs>, string]> = [
    [{ client_lps_source: "serp_row", client_lps_match: "ranking_url" }, "serp_row"],
    [{ client_lps_source: "serp_row", client_lps_match: "domain_fallback" }, "domain_fallback"],
    [{ client_lps_source: "synthetic_client_domain", client_lps_match: "synthetic" }, "synthetic"],
    [{ client_lps: null, client_lps_source: "unavailable", client_lps_match: "unavailable", has_client_lps_row: false }, "unavailable"],
  ];
  for (const [over, expected] of cases) {
    const r = computeScenario(baseInputs(over), "realistic", null);
    assertEquals((r.explanation_json as any).inputs.client_lps_basis, expected, `basis for ${expected}`);
  }
});

// -- Prompt 1.7: scoring-config wiring ------------------------------------

Deno.test("computeScenario: custom threshold config flips beat decision", () => {
  // Marginal setup where realistic (default threshold 0.50) beats rank 1
  // but a raised threshold of 0.55 pushes past it, forcing a lower rank
  // or no beat.
  const comps: CompetitorRow[] = [
    { rank_absolute: 1, url: "a", domain: "a", url_rating: 55, domain_rating: 60, lps_score: 55 },
    { rank_absolute: 2, url: "b", domain: "b", url_rating: 50, domain_rating: 55, lps_score: 50 },
  ];
  const inp: CompositeInputs = {
    client_lps: 60, client_ur: 40, client_dr: 50, competitors: comps,
    content_fit_score: 0.7, serp_feature_count: 0, top_serp_feature: null,
    snippet_opportunity: null, base_rank: null,
    latest_lps_run_exists: true, has_client_lps_row: true, has_client_authority: true,
    client_lps_source: "serp_row",
  };
  const baseline = computeScenario(inp, "realistic", null);
  const strict: ScoringConfig = {
    config_id: "cfg-a",
    config_version: "test_v1",
    scenario_thresholds: { realistic: 0.99 },
  };
  const strictR = computeScenario(inp, "realistic", null, strict);
  assert(baseline.har_position != null, "baseline should beat something");
  assert(
    strictR.har_position == null || (strictR.har_position ?? 0) > (baseline.har_position ?? 0),
    `strict threshold should worsen har_position (baseline=${baseline.har_position}, strict=${strictR.har_position})`,
  );
  assertEquals(
    (strictR.explanation_json as any).scoring_config,
    { config_id: "cfg-a", config_version: "test_v1" },
  );
});

Deno.test("computeScenario: min_confidence config floors har_confidence", () => {
  const inp: CompositeInputs = {
    client_lps: null, client_ur: null, client_dr: null, competitors: [],
    content_fit_score: null, serp_feature_count: null, top_serp_feature: null,
    snippet_opportunity: null, base_rank: null,
    latest_lps_run_exists: false, has_client_lps_row: false, has_client_authority: false,
    client_lps_source: "unavailable",
  };
  // Raw confidence for stretch here: 1 - 0.35 - 0.10 - 0.10 - 0.10 - 0.10 = 0.25.
  // Without config: floor is 0.05, so 0.25 passes through.
  const noCfg = computeScenario(inp, "stretch", null);
  assert(Math.abs(noCfg.har_confidence - 0.25) < 1e-6, `expected 0.25, got ${noCfg.har_confidence}`);
  // With config min_confidence 0.4: floor lifts to 0.4, clamping 0.25 → 0.4.
  const cfg: ScoringConfig = { min_confidence: 0.4 };
  const withCfg = computeScenario(inp, "stretch", null, cfg);
  assertEquals(withCfg.har_confidence, 0.4);
});

Deno.test("computeScenario: no config yields identical output vs baseline (regression guard)", () => {
  const inp = baseInputs();
  const a = computeScenario(inp, "realistic", null);
  const b = computeScenario(inp, "realistic", null, undefined);
  assertEquals(a.har_position, b.har_position);
  assertEquals(a.har_confidence, b.har_confidence);
  assertEquals(a.rank_attainment_probability, b.rank_attainment_probability);
  assertEquals(a.serp_visibility_multiplier, b.serp_visibility_multiplier);
});



