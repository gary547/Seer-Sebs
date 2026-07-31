import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDemandSignal,
  normaliseSeries,
  rollupCategorySignals,
  type CategoryRollupMember,
  type MonthlyPoint,
  type DemandSignalRow,
} from "./demand-signals.ts";
import { CALC_RUN_SUCCESS_STATUS } from "./calc-run-registry.ts";

function mkMember(
  partial: Partial<DemandSignalRow>,
  avg_monthly_volume: number | null = 100,
): CategoryRollupMember {
  return {
    avg_monthly_volume,
    signal: {
      trend_direction: partial.trend_direction ?? "stable",
      trend_pct: partial.trend_pct ?? 0,
      trend_confidence: partial.trend_confidence ?? "high",
      seasonality_strength: partial.seasonality_strength ?? null,
      peak_months_json: partial.peak_months_json ?? [],
    },
  };
}


function series(volumes: number[], startYear = 2024, startMonth = 1): MonthlyPoint[] {
  const out: MonthlyPoint[] = [];
  let y = startYear;
  let m = startMonth;
  for (const v of volumes) {
    out.push({ month: `${y}-${String(m).padStart(2, "0")}-01`, volume: v });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

Deno.test("calc_run_registry success status uses database vocabulary", () => {
  assertEquals(CALC_RUN_SUCCESS_STATUS, "succeeded");
});

Deno.test("normaliseSeries dedupes and sorts", () => {
  const input: MonthlyPoint[] = [
    { month: "2025-03-01", volume: 30 },
    { month: "2025-01-01", volume: 10 },
    { month: "2025-01-01", volume: 15 }, // dupe — last wins
    { month: "2025-02-01", volume: 20 },
  ];
  const out = normaliseSeries(input);
  assertEquals(out.map((p) => p.month), ["2025-01-01", "2025-02-01", "2025-03-01"]);
  assertEquals(out[0].volume, 15);
});

Deno.test("zero months → no_history", () => {
  const r = computeDemandSignal([]);
  assertEquals(r.trend_direction, "insufficient_data");
  assertEquals(r.data_coverage_months, 0);
  assertEquals(r.demand_warning, true);
  assertEquals(r.demand_warning_reason, "no_history");
  assertEquals(r.branch, "insufficient");
});

Deno.test("single month → insufficient_history", () => {
  const r = computeDemandSignal(series([100]));
  assertEquals(r.trend_direction, "insufficient_data");
  assertEquals(r.data_coverage_months, 1);
  assertEquals(r.demand_warning_reason, "insufficient_history");
});

Deno.test("12-month growing → momentum branch, low confidence, warning", () => {
  // steady 100 for months 1..9, jump to 200 for months 10..12.
  const vols = [...Array(9).fill(100), 200, 200, 200];
  const r = computeDemandSignal(series(vols));
  assertEquals(r.branch, "momentum_12");
  assertEquals(r.trend_direction, "growing");
  assertEquals(r.trend_confidence, "low");
  assertEquals(r.demand_warning, true);
  assertEquals(r.demand_warning_reason, "limited_history_lt_24_months");
  assert((r.trend_pct ?? 0) > 15);
});

Deno.test("12-month declining → declining direction", () => {
  const vols = [...Array(9).fill(200), 100, 100, 100];
  const r = computeDemandSignal(series(vols));
  assertEquals(r.trend_direction, "declining");
  assert((r.trend_pct ?? 0) < -15);
});

Deno.test("24-month growing → high_confidence branch, positive YoY", () => {
  // Prior year avg 100, current year avg 150.
  const vols = [...Array(12).fill(100), ...Array(12).fill(150)];
  const r = computeDemandSignal(series(vols));
  assertEquals(r.branch, "high_confidence_24");
  assertEquals(r.trend_direction, "growing");
  assertEquals(r.trend_confidence, "high");
  assertEquals(r.trailing12, 12 * 150);
  assertEquals(r.prior12, 12 * 100);
  assertEquals(r.trend_pct, 50);
  assert((r.yoy_same_month_pct ?? 0) > 40 && (r.yoy_same_month_pct ?? 0) < 60);
});

Deno.test("24-month stable → stable direction", () => {
  const vols = Array(24).fill(100);
  const r = computeDemandSignal(series(vols));
  assertEquals(r.trend_direction, "stable");
  assertEquals(r.trend_pct, 0);
  // volatility=0 when mean>0 and all equal → high confidence.
  assertEquals(r.trend_confidence, "high");
});

Deno.test("24-month volatile → volatile direction regardless of trend_pct", () => {
  // Repeat [0, 0, 1000] → CV ≈ 1.41, well above the 1.0 volatility threshold.
  const vols: number[] = [];
  for (let i = 0; i < 24; i++) vols.push(i % 3 === 2 ? 1000 : 0);
  const r = computeDemandSignal(series(vols));
  assertEquals(r.trend_direction, "volatile");
  assert((r.volatility_score ?? 0) > 1.0);
  assertEquals(r.demand_warning, true);
  assertEquals(r.demand_warning_reason, "high_volatility");
});


Deno.test("zero-volume series → volatility null, direction stable", () => {
  const r = computeDemandSignal(series(Array(24).fill(0)));
  assertEquals(r.volatility_score, null);
  assertEquals(r.trend_direction, "stable");
  assertEquals(r.trend_pct, 0);
});

Deno.test("peak months detected on seasonal series", () => {
  // Every December spikes to 1000, other months 100. 24 months.
  const vols: number[] = [];
  for (let i = 0; i < 24; i++) {
    const m = ((i % 12) + 1);
    vols.push(m === 12 ? 1000 : 100);
  }
  const r = computeDemandSignal(series(vols));
  const peakMonths = r.peak_months_json.map((p) => p.month);
  assert(peakMonths.includes(12), `expected Dec in peaks, got ${peakMonths.join(",")}`);
  assert((r.seasonality_strength ?? 0) > 0);
});

// ---------- rollupCategorySignals (Prompt 6.2) ----------

Deno.test("rollup: <3 members → insufficient_data / low", () => {
  const r = rollupCategorySignals([
    mkMember({ trend_direction: "growing", trend_pct: 40, trend_confidence: "high" }, 500),
    mkMember({ trend_direction: "growing", trend_pct: 40, trend_confidence: "high" }, 500),
  ]);
  assertEquals(r.trend_direction, "insufficient_data");
  assertEquals(r.trend_confidence, "low");
  assertEquals(r.keyword_count, 2);
  assertEquals(r.total_volume, 1000);
});

Deno.test("rollup: 5-member growing → growing / medium, weighted pct", () => {
  const members: CategoryRollupMember[] = [
    mkMember({ trend_direction: "growing", trend_pct: 50, trend_confidence: "high" }, 1000),
    mkMember({ trend_direction: "growing", trend_pct: 30, trend_confidence: "high" }, 500),
    mkMember({ trend_direction: "stable", trend_pct: 5, trend_confidence: "high" }, 100),
    mkMember({ trend_direction: "growing", trend_pct: 20, trend_confidence: "high" }, 100),
    mkMember({ trend_direction: "stable", trend_pct: 0, trend_confidence: "high" }, 100),
  ];
  const r = rollupCategorySignals(members);
  assertEquals(r.keyword_count, 5);
  assertEquals(r.trend_direction, "growing");
  assertEquals(r.trend_confidence, "medium");
  assert((r.trend_pct ?? 0) > 20 && (r.trend_pct ?? 0) < 45,
    `weighted pct out of expected band: ${r.trend_pct}`);
});

Deno.test("rollup: ≥30% volatile members → volatile", () => {
  const members: CategoryRollupMember[] = [];
  for (let i = 0; i < 7; i++) {
    members.push(mkMember({ trend_direction: "growing", trend_pct: 25, trend_confidence: "high" }, 200));
  }
  for (let i = 0; i < 3; i++) {
    members.push(mkMember({ trend_direction: "volatile", trend_pct: 200, trend_confidence: "medium" }, 200));
  }
  const r = rollupCategorySignals(members);
  assertEquals(r.trend_direction, "volatile");
});

Deno.test("rollup: 20-member all-high growing → growing / high", () => {
  const members: CategoryRollupMember[] = [];
  for (let i = 0; i < 20; i++) {
    members.push(mkMember({ trend_direction: "growing", trend_pct: 25, trend_confidence: "high" }, 300));
  }
  const r = rollupCategorySignals(members);
  assertEquals(r.trend_direction, "growing");
  assertEquals(r.trend_confidence, "high");
  assertEquals(r.trend_pct, 25);
});

Deno.test("rollup: peak months aggregate above 1.15× floor", () => {
  const dec = [{ month: 12, mean_volume: 1000, index_vs_avg: 3.0 }];
  const nov = [{ month: 11, mean_volume: 500, index_vs_avg: 1.5 }];
  const members: CategoryRollupMember[] = [
    mkMember({ trend_direction: "growing", trend_pct: 15, trend_confidence: "high", peak_months_json: dec }, 500),
    mkMember({ trend_direction: "growing", trend_pct: 15, trend_confidence: "high", peak_months_json: dec }, 500),
    mkMember({ trend_direction: "growing", trend_pct: 15, trend_confidence: "high", peak_months_json: nov }, 500),
    mkMember({ trend_direction: "growing", trend_pct: 15, trend_confidence: "high", peak_months_json: dec }, 500),
    mkMember({ trend_direction: "growing", trend_pct: 15, trend_confidence: "high", peak_months_json: [] }, 500),
  ];
  const r = rollupCategorySignals(members);
  const peakMs = r.peak_months_json.map((p) => p.month);
  assert(peakMs.includes(12), `expected Dec in peaks, got ${peakMs.join(",")}`);
});

Deno.test("rollup: empty members → insufficient_data", () => {
  const r = rollupCategorySignals([]);
  assertEquals(r.keyword_count, 0);
  assertEquals(r.trend_direction, "insufficient_data");
  assertEquals(r.total_volume, 0);
});

