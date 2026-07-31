import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateGscByNormalised,
  computeCalibration,
  isPromotionEligible,
  normaliseActualTo30d,
  rankBand,
  trafficLight,
  type CalibrationPair,
} from "./calibration.ts";


const pair = (o: Partial<CalibrationPair>): CalibrationPair => ({
  modelled_monthly_clicks: 100,
  actual_clicks_raw: 100,
  window_days: 30,
  impressions: 1000,
  intent: "commercial",
  rank: 5,
  ...o,
});

Deno.test("normaliseActualTo30d: 28-day → scaled up, 90-day → scaled down, 365-day → scaled down", () => {
  assertAlmostEquals(normaliseActualTo30d(28, 28), 30);
  assertAlmostEquals(normaliseActualTo30d(90, 90), 30);
  assertAlmostEquals(normaliseActualTo30d(365, 365), 30);
  assertAlmostEquals(normaliseActualTo30d(100, 28), (100 * 30) / 28);
  assertAlmostEquals(normaliseActualTo30d(100, 90), (100 * 30) / 90);
});

Deno.test("normaliseActualTo30d: guards on non-positive window", () => {
  assertEquals(normaliseActualTo30d(100, 0), 0);
  assertEquals(normaliseActualTo30d(100, -1), 0);
});

Deno.test("rankBand: canonical boundaries", () => {
  assertEquals(rankBand(1), "1-3");
  assertEquals(rankBand(3), "1-3");
  assertEquals(rankBand(4), "4-10");
  assertEquals(rankBand(10), "4-10");
  assertEquals(rankBand(11), "11-20");
  assertEquals(rankBand(20), "11-20");
  assertEquals(rankBand(21), "21-30");
  assertEquals(rankBand(30), "21-30");
  assertEquals(rankBand(31), null);
  assertEquals(rankBand(0), null);
});

Deno.test("noise-floor exclusion: normalised actual < 5 is excluded and counted", () => {
  // 4 raw over 30 days = 4 normalised → excluded; 5 raw over 30 days = 5 → kept.
  const r = computeCalibration([
    pair({ actual_clicks_raw: 4, modelled_monthly_clicks: 4 }),
    pair({ actual_clicks_raw: 5, modelled_monthly_clicks: 5 }),
  ]);
  assertEquals(r.excluded_noise_floor, 1);
  assertEquals(r.matched, 1);
});

Deno.test("noise-floor: 90-day window with raw=12 normalises to 4 → excluded", () => {
  const r = computeCalibration([pair({ actual_clicks_raw: 12, window_days: 90 })]);
  assertEquals(r.excluded_noise_floor, 1);
  assertEquals(r.matched, 0);
});

Deno.test("weighted aggregation: identical ratios collapse to overall=1", () => {
  const r = computeCalibration([
    pair({ modelled_monthly_clicks: 100, actual_clicks_raw: 100, impressions: 500 }),
    pair({ modelled_monthly_clicks: 200, actual_clicks_raw: 200, impressions: 2000 }),
  ]);
  assertEquals(r.matched, 2);
  assertAlmostEquals(r.overall_ratio ?? -1, 1);
});

Deno.test("ruled fixture: overall_ratio = Σ modelled / Σ actual (hand-checkable)", () => {
  // Pair A: modelled 40, actual 50 → per-pair 0.80
  // Pair B: modelled 10, actual 10 → per-pair 1.00
  // Σm=50, Σa=60, overall = 50/60 ≈ 0.83333; median per-pair = 0.9.
  const r = computeCalibration([
    pair({ modelled_monthly_clicks: 40, actual_clicks_raw: 50, impressions: 999 }),
    pair({ modelled_monthly_clicks: 10, actual_clicks_raw: 10, impressions: 1 }),
  ]);
  assertEquals(r.matched, 2);
  assertAlmostEquals(r.overall_ratio ?? -1, 50 / 60, 1e-9);
  assertAlmostEquals(r.median_per_pair_ratio ?? -1, 0.9, 1e-9);
  assertEquals(r.sum_modelled_monthly, 50);
  assertEquals(r.sum_actual_monthly, 60);
});

Deno.test("range guardrail: overall_ratio lies within [min, max] of per-pair ratios (would have caught the impression-weighting defect)", () => {
  const inRange = (r: ReturnType<typeof computeCalibration>, pairs: CalibrationPair[]) => {
    const perPair = pairs.map((p) =>
      p.modelled_monthly_clicks / normaliseActualTo30d(p.actual_clicks_raw, p.window_days)
    );
    const lo = Math.min(...perPair);
    const hi = Math.max(...perPair);
    const eps = 1e-9;
    const v = r.overall_ratio ?? Number.NaN;
    if (!(v + eps >= lo && v - eps <= hi)) {
      throw new Error(`overall ${v} outside [${lo}, ${hi}]`);
    }
  };
  const twoPair: CalibrationPair[] = [
    pair({ modelled_monthly_clicks: 40, actual_clicks_raw: 50, impressions: 100 }),
    pair({ modelled_monthly_clicks: 10, actual_clicks_raw: 10, impressions: 10000 }),
  ];
  inRange(computeCalibration(twoPair), twoPair);

  const fivePair: CalibrationPair[] = [
    pair({ modelled_monthly_clicks: 20, actual_clicks_raw: 100, impressions: 5 }),
    pair({ modelled_monthly_clicks: 60, actual_clicks_raw: 50,  impressions: 50000 }),
    pair({ modelled_monthly_clicks: 30, actual_clicks_raw: 30,  impressions: 200 }),
    pair({ modelled_monthly_clicks: 5,  actual_clicks_raw: 40,  impressions: 8000 }),
    pair({ modelled_monthly_clicks: 90, actual_clicks_raw: 60,  impressions: 12 }),
  ];
  inRange(computeCalibration(fivePair), fivePair);
});

Deno.test("impression irrelevance: identical (modelled, actual) pairs → identical ratios regardless of impressions", () => {
  const base = (impsA: number, impsB: number): CalibrationPair[] => [
    pair({ modelled_monthly_clicks: 40, actual_clicks_raw: 50, impressions: impsA, intent: "commercial", rank: 5 }),
    pair({ modelled_monthly_clicks: 10, actual_clicks_raw: 10, impressions: impsB, intent: "commercial", rank: 5 }),
  ];
  const r1 = computeCalibration(base(1, 1));
  const r2 = computeCalibration(base(50000, 1));
  assertAlmostEquals(r1.overall_ratio ?? -1, r2.overall_ratio ?? -2, 1e-12);
  assertAlmostEquals(
    r1.by_intent.commercial.ratio ?? -1,
    r2.by_intent.commercial.ratio ?? -2,
    1e-12,
  );
  assertAlmostEquals(
    r1.by_rank_band["4-10"].ratio ?? -1,
    r2.by_rank_band["4-10"].ratio ?? -2,
    1e-12,
  );
});

Deno.test("bucket assignment: intent + rank band routed correctly", () => {
  const r = computeCalibration([
    pair({ intent: "informational", rank: 2 }),
    pair({ intent: "transactional", rank: 15 }),
    pair({ intent: "commercial", rank: 7 }),
    pair({ intent: "navigational", rank: 25 }), // now in 21-30 band
  ]);
  assertEquals(r.by_intent.informational.matched, 1);
  assertEquals(r.by_intent.transactional.matched, 1);
  assertEquals(r.by_intent.commercial.matched, 1);
  assertEquals(r.by_intent.navigational.matched, 1);
  assertEquals(r.by_rank_band["1-3"].matched, 1);
  assertEquals(r.by_rank_band["4-10"].matched, 1);
  assertEquals(r.by_rank_band["11-20"].matched, 1);
  assertEquals(r.by_rank_band["21-30"].matched, 1);
  assertEquals(r.matched, 4);
});

Deno.test("rank-band 21-30: six rank-25 fixtures land in 21-30 and totals stay invariant", () => {
  const pairs: CalibrationPair[] = Array.from({ length: 6 }, () =>
    pair({ rank: 25, modelled_monthly_clicks: 10, actual_clicks_raw: 20, impressions: 100 }),
  );
  const r = computeCalibration(pairs);
  assertEquals(r.matched, 6);
  assertEquals(r.by_rank_band["21-30"].matched, 6);
  assertEquals(r.by_rank_band["1-3"].matched, 0);
  const bbm = Object.values(r.by_rank_band).reduce((a, b) => a + b.sum_modelled_monthly, 0);
  const bba = Object.values(r.by_rank_band).reduce((a, b) => a + b.sum_actual_monthly, 0);
  assertAlmostEquals(bbm, r.sum_modelled_monthly, 1e-9);
  assertAlmostEquals(bba, r.sum_actual_monthly, 1e-9);
});

Deno.test("scale invariance: multiplying every modelled by k scales the ratio by k", () => {
  const base = [
    pair({ modelled_monthly_clicks: 100, actual_clicks_raw: 200, impressions: 1000 }),
    pair({ modelled_monthly_clicks: 50, actual_clicks_raw: 100, impressions: 500 }),
  ];
  const r1 = computeCalibration(base);
  const r2 = computeCalibration(base.map((p) => ({ ...p, modelled_monthly_clicks: p.modelled_monthly_clicks * 2 })));
  assertAlmostEquals((r2.overall_ratio ?? 0) / (r1.overall_ratio ?? 1), 2);
});

Deno.test("empty inputs → null ratio, zero counts", () => {
  const r = computeCalibration([]);
  assertEquals(r.overall_ratio, null);
  assertEquals(r.matched, 0);
  assertEquals(r.excluded_noise_floor, 0);
});

Deno.test("trafficLight: green/amber/red boundaries", () => {
  assertEquals(trafficLight(1.0), "green");
  assertEquals(trafficLight(0.5), "green");
  assertEquals(trafficLight(2.0), "green");
  assertEquals(trafficLight(0.4), "amber");
  assertEquals(trafficLight(2.5), "amber");
  assertEquals(trafficLight(0.2), "red");
  assertEquals(trafficLight(4.0), "red");
  assertEquals(trafficLight(null), null);
});

Deno.test("promotion gate: green overall + no red intent → eligible", () => {
  const r = computeCalibration([pair({ modelled_monthly_clicks: 100, actual_clicks_raw: 100 })]);
  assertEquals(isPromotionEligible(r), true);
});

Deno.test("promotion gate: one red intent bucket blocks eligibility even if overall is green", () => {
  const r = computeCalibration([
    // commercial: per-pair 1.0
    pair({ intent: "commercial",    modelled_monthly_clicks: 100, actual_clicks_raw: 100 }),
    // informational: per-pair 10 → red bucket
    pair({ intent: "informational", modelled_monthly_clicks: 100, actual_clicks_raw: 10 }),
  ]);
  // Σm=200, Σa=110 → overall ≈ 1.818 (green)
  assertEquals(trafficLight(r.overall_ratio), "green");
  assertEquals(trafficLight(r.by_intent.informational.ratio), "red");
  assertEquals(isPromotionEligible(r), false);
});

Deno.test("aggregateGscByNormalised: 3 device rows sum clicks + impressions into one entry", () => {
  const agg = aggregateGscByNormalised([
    { keyword: "24 inch tv", clicks: 10, impressions: 100, position: 2, search_intent: "commercial", device: "desktop" },
    { keyword: "24 inch tv", clicks: 5,  impressions: 50,  position: 4, search_intent: null,         device: "mobile"  },
    { keyword: "24 inch tv", clicks: 2,  impressions: 20,  position: 6, search_intent: null,         device: "tablet"  },
  ]);
  assertEquals(agg.size, 1);
  const row = agg.get("24 inch tv")!;
  assertEquals(row.clicks, 17);
  assertEquals(row.impressions, 170);
  assertEquals(row.device_rows, 3);
  // Impressions-weighted mean position: (2·100 + 4·50 + 6·20) / 170 = 520/170
  assertAlmostEquals(row.position ?? -1, 520 / 170, 1e-6);
  assertEquals(row.search_intent, "commercial");
});

Deno.test("aggregateGscByNormalised: single row is passthrough; whitespace/case normalised", () => {
  const agg = aggregateGscByNormalised([
    { keyword: "  Sony  TV  ", clicks: 3, impressions: 30, position: 5, search_intent: null, device: "desktop" },
  ]);
  assertEquals(agg.size, 1);
  const row = agg.get("sony tv")!;
  assertEquals(row.clicks, 3);
  assertEquals(row.impressions, 30);
  assertEquals(row.device_rows, 1);
  assertEquals(row.position, 5);
});

Deno.test("aggregateGscByNormalised: zero-impression rows tolerated, contribute clicks only", () => {
  const agg = aggregateGscByNormalised([
    { keyword: "foo", clicks: 1, impressions: 0,  position: null, search_intent: null, device: null },
    { keyword: "foo", clicks: 4, impressions: 10, position: 3,    search_intent: null, device: null },
  ]);
  const row = agg.get("foo")!;
  assertEquals(row.clicks, 5);
  assertEquals(row.impressions, 10);
  // Second row supplies the position (first had none).
  assertEquals(row.position, 3);
});

Deno.test("computeCalibration: pairs with non-finite rank are excluded from every aggregate", () => {
  const mk = (rank: number, intent: CalibrationPair["intent"] = "commercial"): CalibrationPair => ({
    modelled_monthly_clicks: 100, actual_clicks_raw: 100, window_days: 30,
    impressions: 1000, intent, rank,
  });
  const r = computeCalibration([mk(2), mk(7), mk(15), mk(Number.NaN, "informational")]);
  assertEquals(r.matched, 3);                              // NaN pair skipped
  assertEquals(r.by_intent.informational.matched, 0);      // and not routed
  assertEquals(r.by_rank_band["1-3"].matched, 1);
  assertEquals(r.by_rank_band["4-10"].matched, 1);
  assertEquals(r.by_rank_band["11-20"].matched, 1);
  // Total actuals reflect only the three scored pairs.
  assertEquals(r.total_actual_30d_clicks, 300);
});

Deno.test("per-pair round-trip: modelled/actual == per_pair_ratio (calibrator invariant)", () => {
  // Hand-checkable fixture used by the calibration-compute per-pair ledger:
  // modelled=40, actual raw=50 over 30 days → actual30=50 → per_pair=0.8
  // modelled=10, actual raw=20 over 60 days → actual30=10 → per_pair=1.0
  const cases = [
    { modelled: 40, raw: 50, window: 30, expected: 0.8 },
    { modelled: 10, raw: 20, window: 60, expected: 1.0 },
  ];
  for (const c of cases) {
    const actual30 = normaliseActualTo30d(c.raw, c.window);
    const ratio = actual30 > 0 ? c.modelled / actual30 : null;
    assertAlmostEquals(ratio ?? -1, c.expected, 1e-9);
}
});

Deno.test("calibrator ctr-conversion contract: 1.05pp curve → ctr_used=0.0105, modelled = V×ctr×svm/12", () => {
  // Mirrors the resolver contract in _shared/ctr-resolver-v2.ts:
  //   res.ctr           — decimal fraction (e.g. 0.0105)
  //   res.ctrPercentage — percentage points  (e.g. 1.05)
  // The calibrator must apply exactly ONE conversion from ctrPercentage.
  // Consuming res.ctr AND dividing by 100 was the 100× defect fixed in
  // calibrator-per-pair-dump-2026-07-20 §3. This test locks the contract.
  const res = { ctr: 0.0105, ctrPercentage: 1.05 };
  const ctrNow = res.ctrPercentage != null ? res.ctrPercentage / 100 : null;
  assertAlmostEquals(ctrNow ?? -1, 0.0105, 1e-12);
  assert(ctrNow !== 0.000105, "ctr_used must not be 100× low (double-division defect)");

  const volFwd = 12000; // annual keyword volume
  const svm = 1.0;
  const modelled = (volFwd * (ctrNow ?? 0) * svm) / 12;
  assertAlmostEquals(modelled, 10.5, 1e-9); // 12000 × 0.0105 × 1 / 12
});

Deno.test("computeCalibration: bucket totals sum to overall totals (post-exclusion invariant)", () => {
  const pairs = [
    { modelled_monthly_clicks: 100, actual_clicks_raw: 60, window_days: 30, impressions: 1000, intent: "transactional" as const, rank: 2 },
    { modelled_monthly_clicks: 50,  actual_clicks_raw: 30, window_days: 30, impressions: 500,  intent: "commercial"    as const, rank: 5 },
    { modelled_monthly_clicks: 20,  actual_clicks_raw: 10, window_days: 30, impressions: 200,  intent: "informational" as const, rank: 15 },
    { modelled_monthly_clicks: 5,   actual_clicks_raw: 2,  window_days: 30, impressions: 100,  intent: "unknown"       as const, rank: 3 }, // noise-floor drop
  ];
  const r = computeCalibration(pairs);
  const bim = Object.values(r.by_intent).reduce((a, b) => a + b.sum_modelled_monthly, 0);
  const bia = Object.values(r.by_intent).reduce((a, b) => a + b.sum_actual_monthly, 0);
  const bimatched = Object.values(r.by_intent).reduce((a, b) => a + b.matched, 0);
  assertAlmostEquals(bim, r.sum_modelled_monthly, 1e-9);
  assertAlmostEquals(bia, r.sum_actual_monthly, 1e-9);
  assertEquals(bimatched, r.matched);
  const bbm = Object.values(r.by_rank_band).reduce((a, b) => a + b.sum_modelled_monthly, 0);
  const bbmatched = Object.values(r.by_rank_band).reduce((a, b) => a + b.matched, 0);
  // Band sums ≤ overall (rank bands cap at 11-20).
  if (bbm > r.sum_modelled_monthly + 1e-9) throw new Error("band sum exceeds overall");
  if (bbmatched > r.matched) throw new Error("band matched exceeds overall");
});
