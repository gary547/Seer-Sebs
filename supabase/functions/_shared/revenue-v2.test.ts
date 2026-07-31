import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { annualVolumeFromInputs, computeRevenueV2, trendFactor } from "./revenue-v2.ts";

Deno.test("identity: tp_incremental = tp_absolute - current, non-negative", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  assertEquals(r.current_revenue_annual, 1200);
  assertEquals(r.tp_absolute_revenue_annual, 4800);
  assertEquals(r.tp_incremental_revenue_annual, 3600);
  // v2.1.0: expected = tp_incremental × p_att = 3600 × 0.5 = 1800
  assertEquals(r.expected_incremental_revenue_annual, 1800);
});

Deno.test("non-negative floor when tp < current", () => {
  const r = computeRevenueV2({
    scenario: "conservative",
    volume_annual: 12000,
    ctr_now: 0.2,
    ctr_tp: 0.05,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 3,
    pos_tp: 8,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  assertEquals(r.tp_incremental_revenue_annual, 0);
  assertEquals(r.expected_incremental_revenue_annual, 0);
});

Deno.test("missing CTR/CVR/AOV → nulls + warnings", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: null,
    ctr_tp: 0.2,
    svm: 1,
    cvr: null,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  assertEquals(r.current_revenue_annual, null);
  assertEquals(r.tp_absolute_revenue_annual, null);
  assertEquals(r.tp_incremental_revenue_annual, null);
  assertEquals(r.expected_incremental_revenue_annual, null);
  assert(r.warnings.includes("missing_ctr_now"));
  assert(r.warnings.includes("missing_cvr"));
});

Deno.test("svm default = 1 when null, adds warning", () => {
  const r = computeRevenueV2({
    scenario: "stretch",
    volume_annual: 1000,
    ctr_now: 0.1,
    ctr_tp: 0.1,
    svm: null,
    cvr: 0.01,
    aov: 10,
    pos_now: 5,
    pos_tp: 5,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: [],
  });
  assertEquals(r.svm_used, 1);
  assert(r.warnings.includes("missing_svm"));
});

Deno.test("monthly split — 12 real months uses source keyword_monthly_volumes", () => {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `2026-${String(i + 1).padStart(2, "0")}-01`,
    volume: 100,
  }));
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 1200,
    ctr_now: 0.1,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 50,
    pos_now: 5,
    pos_tp: 2,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: monthly,
  });
  assertEquals(r.monthly_revenue_json.monthly_source, "keyword_monthly_volumes");
  assertEquals(r.monthly_revenue_json.months.length, 12);
  const sumCurrent = r.monthly_revenue_json.months.reduce(
    (s, m) => s + (m.current ?? 0),
    0,
  );
  assertAlmostEquals(sumCurrent, r.current_revenue_annual ?? 0, 0.5);
});

Deno.test("monthly split — no monthly volumes falls back to avg", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 1200,
    ctr_now: 0.1,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 50,
    pos_now: 5,
    pos_tp: 2,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: [],
  });
  assertEquals(r.monthly_revenue_json.monthly_source, "avg");
  assertEquals(r.monthly_revenue_json.months.length, 12);
});

Deno.test("annualVolumeFromInputs prefers sum when 12+ months", () => {
  const v = annualVolumeFromInputs(
    Array.from({ length: 12 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}-01`,
      volume: 100,
    })),
    999, // ignored
  );
  assertEquals(v.volume_annual, 1200);
  assertEquals(v.source, "keyword_monthly_volumes");
});

Deno.test("annualVolumeFromInputs falls back to avg*12 with <12 months", () => {
  const v = annualVolumeFromInputs([{ month: "2026-01-01", volume: 50 }], 100);
  assertEquals(v.volume_annual, 1200);
  assertEquals(v.source, "avg");
});

Deno.test("expected no longer scales with har_confidence (v2.1.0)", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 1,
    har_confidence: 0.6,
    monthly_volumes: [],
  });
  // tp_incremental = 3600, p_att = 1 → expected = 3600 (har_conf ignored in product)
  assertEquals(r.expected_incremental_revenue_annual, 3600);
  assertEquals(r.tp_incremental_revenue_annual, 3600);
  // Band opens because har_conf < 1: low = 3600*0.6 = 2160; high = expected (= tp_incr) = 3600
  assertEquals(r.expected_incremental_low_annual, 2160);
  assertEquals(r.expected_incremental_high_annual, 3600);
});

Deno.test("band: har_conf = 1 → low = high = expected", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 1,
    monthly_volumes: [],
  });
  const expected = r.expected_incremental_revenue_annual!;
  assertEquals(r.expected_incremental_low_annual, expected);
  assertEquals(r.expected_incremental_high_annual, expected);
});

Deno.test("band: har_conf = 0.5 opens symmetrically toward floor and ceiling", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.5,
    monthly_volumes: [],
  });
  // tp_incr = 3600, expected = 3600 * 0.5 = 1800
  // low = 1800 * 0.5 = 900; high = 1800 + (3600 - 1800) * 0.5 = 2700
  assertEquals(r.expected_incremental_revenue_annual, 1800);
  assertEquals(r.expected_incremental_low_annual, 900);
  assertEquals(r.expected_incremental_high_annual, 2700);
});

Deno.test("band: har_conf = 0 → low = 0, high = tp_incremental", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0,
    monthly_volumes: [],
  });
  assertEquals(r.expected_incremental_low_annual, 0);
  assertEquals(
    r.expected_incremental_high_annual,
    r.tp_incremental_revenue_annual,
  );
});

Deno.test("band: har_conf null → band collapses to [expected, expected] + warning", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: 0.05,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: null,
    monthly_volumes: [],
  });
  const expected = r.expected_incremental_revenue_annual!;
  assertEquals(r.expected_incremental_low_annual, expected);
  assertEquals(r.expected_incremental_high_annual, expected);
  assert(r.warnings.includes("missing_har_confidence"));
});

Deno.test("invariant: low ≤ expected ≤ high ≤ tp_incremental over random valid inputs", () => {
  let prevWidth = Infinity;
  const harConfSweep = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  for (const hc of harConfSweep) {
    const r = computeRevenueV2({
      scenario: "realistic",
      volume_annual: 10000,
      ctr_now: 0.04,
      ctr_tp: 0.18,
      svm: 1,
      cvr: 0.03,
      aov: 75,
      pos_now: 9,
      pos_tp: 2,
      rank_attainment_probability: 0.4,
      har_confidence: hc,
      monthly_volumes: [],
    });
    const low = r.expected_incremental_low_annual!;
    const exp = r.expected_incremental_revenue_annual!;
    const high = r.expected_incremental_high_annual!;
    const tpIncr = r.tp_incremental_revenue_annual!;
    assert(low <= exp + 1e-6, `low ${low} > expected ${exp} at hc=${hc}`);
    assert(exp <= high + 1e-6, `expected ${exp} > high ${high} at hc=${hc}`);
    assert(high <= tpIncr + 1e-6, `high ${high} > tp_incr ${tpIncr} at hc=${hc}`);
    const width = high - low;
    assert(width <= prevWidth + 1e-6, `band width increased as har_conf rose (hc=${hc})`);
    prevWidth = width;
  }
});


Deno.test("clamp: p_att > 1 → 1", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 1000,
    ctr_now: 0.01,
    ctr_tp: 0.1,
    svm: 1,
    cvr: 0.01,
    aov: 10,
    pos_now: 20,
    pos_tp: 1,
    rank_attainment_probability: 5,
    har_confidence: 1,
    monthly_volumes: [],
  });
  assertEquals(r.p_att_used, 1);
});

Deno.test("not_ranking: pos_now null → current = 0, tp_incremental = tp_absolute", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: null,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: null,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  assertEquals(r.current_revenue_annual, 0);
  assertEquals(r.tp_absolute_revenue_annual, 4800);
  assertEquals(r.tp_incremental_revenue_annual, 4800);
  // expected = tp_incremental × p_att = 4800 × 0.5 = 2400
  assertEquals(r.expected_incremental_revenue_annual, 2400);
  assert(r.warnings.includes("not_ranking"), "expected not_ranking warning");
  assert(!r.warnings.includes("missing_ctr_now"), "should not emit missing_ctr_now when unranked");
});

Deno.test("pos_now present + ctr_now null → legacy behaviour preserved (regression guard)", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: null,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: 8,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  assertEquals(r.current_revenue_annual, null);
  assertEquals(r.tp_incremental_revenue_annual, null);
  assert(r.warnings.includes("missing_ctr_now"));
  assert(!r.warnings.includes("not_ranking"));
});

Deno.test("not_ranking monthly conservation (avg-shape): Σ current = 0, Σ tp_absolute ≈ tp_absolute", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 12000,
    ctr_now: null,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: null,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: [],
  });
  const months = r.monthly_revenue_json.months;
  assertEquals(months.length, 12);
  const sumCurrent = months.reduce((s, m) => s + (m.current ?? 0), 0);
  const sumTpAbs = months.reduce((s, m) => s + (m.tp_absolute ?? 0), 0);
  assertEquals(sumCurrent, 0);
  assertAlmostEquals(sumTpAbs, r.tp_absolute_revenue_annual ?? 0, 0.03);
});

Deno.test("not_ranking with 12+ keyword_monthly_volumes: tp_absolute follows volume shape, current is 0 every month", () => {
  const monthly = [
    { month: "2025-01-01", volume: 100 },
    { month: "2025-02-01", volume: 100 },
    { month: "2025-03-01", volume: 100 },
    { month: "2025-04-01", volume: 100 },
    { month: "2025-05-01", volume: 100 },
    { month: "2025-06-01", volume: 100 },
    { month: "2025-07-01", volume: 100 },
    { month: "2025-08-01", volume: 100 },
    { month: "2025-09-01", volume: 100 },
    { month: "2025-10-01", volume: 100 },
    { month: "2025-11-01", volume: 1200 }, // seasonal peak
    { month: "2025-12-01", volume: 100 },
  ];
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 2300,
    ctr_now: null,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 100,
    pos_now: null,
    pos_tp: 3,
    rank_attainment_probability: 0.5,
    har_confidence: 0.8,
    monthly_volumes: monthly,
  });
  assertEquals(r.monthly_revenue_json.monthly_source, "keyword_monthly_volumes");
  const tps = r.monthly_revenue_json.months.map((m) => m.tp_absolute ?? 0);
  const maxTp = Math.max(...tps);
  const minTp = Math.min(...tps);
  assert(maxTp - minTp > 1, `tp_absolute should follow volume shape, got range ${minTp}..${maxTp}`);
  for (const m of r.monthly_revenue_json.months) {
    assertEquals(m.current, 0, `month ${m.month} current should be 0`);
  }
});

Deno.test("monthly split — full-history keyword projects onto forward 12-month window", () => {
  // Historical rows: 2025-06 .. 2026-05, distinctive volume per month-of-year
  const monthly = [
    { month: "2025-06-01", volume: 60 },
    { month: "2025-07-01", volume: 70 },
    { month: "2025-08-01", volume: 80 },
    { month: "2025-09-01", volume: 90 },
    { month: "2025-10-01", volume: 100 },
    { month: "2025-11-01", volume: 110 },
    { month: "2025-12-01", volume: 120 },
    { month: "2026-01-01", volume: 10 },
    { month: "2026-02-01", volume: 20 },
    { month: "2026-03-01", volume: 30 },
    { month: "2026-04-01", volume: 40 },
    { month: "2026-05-01", volume: 50 },
  ];
  const nowUtc = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 780,
    ctr_now: 0.1,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 50,
    pos_now: 5,
    pos_tp: 2,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: monthly,
  }, nowUtc);

  const mj = r.monthly_revenue_json;
  assertEquals(mj.monthly_source, "keyword_monthly_volumes");
  assertEquals(mj.label_mode, "forward_projected");
  assertEquals(mj.months.length, 12);

  // All month keys are strictly after nowUtc's month (2026-07)
  for (const m of mj.months) {
    assert(m.month > "2026-07", `expected forward month, got ${m.month}`);
  }
  assertEquals(mj.months[0].month, "2026-08");
  assertEquals(mj.months[11].month, "2027-07");

  // Volumes map by month-of-year
  const volByMonth = new Map(mj.months.map((m) => [m.month, m.volume]));
  assertEquals(volByMonth.get("2026-08"), 80);   // historical 08 → 80
  assertEquals(volByMonth.get("2026-12"), 120);  // historical 12 → 120
  assertEquals(volByMonth.get("2027-03"), 30);   // historical 03 → 30
  assertEquals(volByMonth.get("2027-07"), 70);   // historical 07 → 70

  // Conservation: months sum to annual totals within rounding tolerance
  const sumCurrent = mj.months.reduce((s, m) => s + (m.current ?? 0), 0);
  const sumTpAbs = mj.months.reduce((s, m) => s + (m.tp_absolute ?? 0), 0);
  assertAlmostEquals(sumCurrent, r.current_revenue_annual ?? 0, 0.5);
  assertAlmostEquals(sumTpAbs, r.tp_absolute_revenue_annual ?? 0, 0.5);
});

Deno.test("monthly split — sparse keyword keeps avg/mixed source and gets forward label", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: 1200,
    ctr_now: 0.1,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 50,
    pos_now: 5,
    pos_tp: 2,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: [
      { month: "2026-01-01", volume: 200 },
      { month: "2026-02-01", volume: 150 },
    ],
  });
  const mj = r.monthly_revenue_json;
  assertEquals(mj.monthly_source, "mixed");
  assertEquals(mj.label_mode, "forward");
  assertEquals(mj.months.length, 12);
});

Deno.test("monthly split — empty keyword yields label_mode 'none'", () => {
  const r = computeRevenueV2({
    scenario: "realistic",
    volume_annual: null,
    ctr_now: 0.1,
    ctr_tp: 0.2,
    svm: 1,
    cvr: 0.02,
    aov: 50,
    pos_now: 5,
    pos_tp: 2,
    rank_attainment_probability: 1,
    har_confidence: 1,
    monthly_volumes: [],
  });
  const mj = r.monthly_revenue_json;
  assertEquals(mj.monthly_source, "none");
  assertEquals(mj.label_mode, "none");
  assertEquals(mj.months.length, 0);
});


// ---------------------------------------------------------------------------
// Prompt 2.4 — trend-adjusted forward volume
// ---------------------------------------------------------------------------

const baseTrendInputs = {
  scenario: "realistic" as const,
  volume_annual: 1200,
  ctr_now: 0.1,
  ctr_tp: 0.2,
  svm: 1,
  cvr: 0.02,
  aov: 50,
  pos_now: 5,
  pos_tp: 2,
  rank_attainment_probability: 1,
  har_confidence: 1,
  monthly_volumes: [] as { month: string; volume: number }[],
};

Deno.test("trend cap: +60% saturates to factor 1.3", () => {
  const r = computeRevenueV2({ ...baseTrendInputs, trend_pct: 60, trend_confidence: "high" });
  assertEquals(r.factor_applied, 1.3);
  assertEquals(r.volume_forward, 1560);
  // tp_abs = volume_forward × ctr_tp × svm × cvr × aov = 1560 × 0.2 × 1 × 0.02 × 50 = 312
  assertEquals(r.tp_absolute_revenue_annual, 312);
  assert(r.warnings.includes("trend_adjusted"));
  assert(!r.warnings.includes("trend_declining"));
});

Deno.test("trend cap: -50% saturates to factor 0.7 and emits trend_declining", () => {
  const r = computeRevenueV2({ ...baseTrendInputs, trend_pct: -50, trend_confidence: "high" });
  assertEquals(r.factor_applied, 0.7);
  assertEquals(r.volume_forward, 840);
  assert(r.warnings.includes("trend_adjusted"));
  assert(r.warnings.includes("trend_declining"));
});

Deno.test("trend low-confidence → no adjustment, no warning", () => {
  const r = computeRevenueV2({ ...baseTrendInputs, trend_pct: 40, trend_confidence: "low" });
  assertEquals(r.factor_applied, 1);
  assertEquals(r.volume_forward, 1200);
  assert(!r.warnings.includes("trend_adjusted"));
});

Deno.test("trend null pct → factor 1 even with high confidence", () => {
  const r = computeRevenueV2({ ...baseTrendInputs, trend_pct: null, trend_confidence: "high" });
  assertEquals(r.factor_applied, 1);
  assert(!r.warnings.includes("trend_adjusted"));
});

Deno.test("trend_declining threshold: -15 (=0.85) not flagged; -16 (=0.84) flagged", () => {
  const at15 = computeRevenueV2({ ...baseTrendInputs, trend_pct: -15, trend_confidence: "high" });
  assertEquals(at15.factor_applied, 0.85);
  assert(at15.warnings.includes("trend_adjusted"));
  assert(!at15.warnings.includes("trend_declining"), "boundary 0.85 must NOT warn");

  const at16 = computeRevenueV2({ ...baseTrendInputs, trend_pct: -16, trend_confidence: "high" });
  assertEquals(at16.factor_applied, 0.84);
  assert(at16.warnings.includes("trend_declining"));
});

Deno.test("trendFactor helper: pure clamp semantics", () => {
  assertEquals(trendFactor(0, "high").factor, 1);
  assertEquals(trendFactor(15, "high").factor, 1.15);
  assertEquals(trendFactor(200, "high").factor, 1.3);
  assertEquals(trendFactor(-200, "high").factor, 0.7);
  assertEquals(trendFactor(15, "low").applied, false);
  assertEquals(trendFactor(null, "high").applied, false);
  assertEquals(trendFactor(15, null).applied, false);
});

Deno.test("monthly conservation under trend (keyword_monthly_volumes source)", () => {
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: `2025-${String(i + 1).padStart(2, "0")}-01`,
    volume: 100,
  }));
  const r = computeRevenueV2({
    ...baseTrendInputs,
    volume_annual: 1200,
    monthly_volumes: monthly,
    trend_pct: 20,
    trend_confidence: "high",
  });
  assertEquals(r.factor_applied, 1.2);
  assertEquals(r.volume_forward, 1440);
  const sumVol = r.monthly_revenue_json.months.reduce((s, m) => s + m.volume, 0);
  const sumTpAbs = r.monthly_revenue_json.months.reduce((s, m) => s + (m.tp_absolute ?? 0), 0);
  const sumCurrent = r.monthly_revenue_json.months.reduce((s, m) => s + (m.current ?? 0), 0);
  assertAlmostEquals(sumVol, 1440, 1);
  assertAlmostEquals(sumTpAbs, r.tp_absolute_revenue_annual ?? 0, 0.5);
  assertAlmostEquals(sumCurrent, r.current_revenue_annual ?? 0, 0.5);
});

Deno.test("monthly conservation under trend (avg source, no historical rows)", () => {
  const r = computeRevenueV2({
    ...baseTrendInputs,
    volume_annual: 1200,
    monthly_volumes: [],
    trend_pct: -20,
    trend_confidence: "medium",
  });
  assertEquals(r.factor_applied, 0.8);
  assertEquals(r.volume_forward, 960);
  const sumVol = r.monthly_revenue_json.months.reduce((s, m) => s + m.volume, 0);
  const sumTpAbs = r.monthly_revenue_json.months.reduce((s, m) => s + (m.tp_absolute ?? 0), 0);
  assertAlmostEquals(sumVol, 960, 1);
  assertAlmostEquals(sumTpAbs, r.tp_absolute_revenue_annual ?? 0, 0.5);
});

Deno.test("monthly conservation under trend (mixed source, partial history)", () => {
  const r = computeRevenueV2({
    ...baseTrendInputs,
    volume_annual: 1200,
    monthly_volumes: [
      { month: "2026-01-01", volume: 200 },
      { month: "2026-02-01", volume: 150 },
    ],
    trend_pct: 10,
    trend_confidence: "high",
  });
  assertEquals(r.factor_applied, 1.1);
  assertEquals(r.volume_forward, 1320);
  assertEquals(r.monthly_revenue_json.monthly_source, "mixed");
  const sumTpAbs = r.monthly_revenue_json.months.reduce((s, m) => s + (m.tp_absolute ?? 0), 0);
  assertAlmostEquals(sumTpAbs, r.tp_absolute_revenue_annual ?? 0, 0.5);
});

Deno.test("zero-behaviour guarantee: omitted trend fields match legacy output", () => {
  const legacy = computeRevenueV2({ ...baseTrendInputs });
  const withNulls = computeRevenueV2({ ...baseTrendInputs, trend_pct: null, trend_confidence: null });
  assertEquals(legacy.current_revenue_annual, withNulls.current_revenue_annual);
  assertEquals(legacy.tp_absolute_revenue_annual, withNulls.tp_absolute_revenue_annual);
  assertEquals(legacy.tp_incremental_revenue_annual, withNulls.tp_incremental_revenue_annual);
  assertEquals(legacy.expected_incremental_revenue_annual, withNulls.expected_incremental_revenue_annual);
  assertEquals(legacy.factor_applied, 1);
  assertEquals(legacy.volume_forward, legacy.tp_absolute_revenue_annual == null ? null : 1200);
  // legacy path emits no trend warnings
  assert(!legacy.warnings.includes("trend_adjusted"));
  assert(!legacy.warnings.includes("trend_declining"));
});



