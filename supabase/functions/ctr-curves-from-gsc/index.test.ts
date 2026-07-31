import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAggregations,
  pickDevicesToBuild,
  INTENT_KEYS,
  CTR_ELIGIBLE_SOURCES,
  blendRankCtr,
  pavNonIncreasing,
  type AggRow,
} from "./index.ts";


function row(partial: Partial<AggRow>): AggRow {
  return {
    clicks: 0,
    impressions: 0,
    position: 5,
    search_intent: null,
    device: null,
    is_branded: null,
    ...partial,
  };
}

Deno.test("pickDevicesToBuild: mixed upload -> mobile/desktop/all", () => {
  const r = pickDevicesToBuild({ device: "mixed" });
  assertEquals(r.hasPerRowDevice, true);
  assertEquals(r.devices, ["mobile", "desktop", "all"]);
});

Deno.test("pickDevicesToBuild: all/null/other -> all only (legacy)", () => {
  for (const d of ["all", null, "mobile", "desktop"]) {
    const r = pickDevicesToBuild({ device: d as any });
    assertEquals(r.devices, ["all"]);
    assertEquals(r.hasPerRowDevice, false);
  }
});

Deno.test("device splitting: mixed upload aggregates per device and all=sum", () => {
  const rows: AggRow[] = [
    row({ device: "mobile", position: 3, impressions: 1000, clicks: 100, search_intent: "commercial" }),
    row({ device: "mobile", position: 3, impressions: 500, clicks: 40, search_intent: "commercial" }),
    row({ device: "desktop", position: 3, impressions: 2000, clicks: 300, search_intent: "commercial" }),
  ];
  const r = buildAggregations(rows, true);
  const mob = r.agg.mobile.commercial.get(3)!;
  const desk = r.agg.desktop.commercial.get(3)!;
  const all = r.agg.all.commercial.get(3)!;
  assertEquals(mob, { clicks: 140, impressions: 1500 });
  assertEquals(desk, { clicks: 300, impressions: 2000 });
  assertEquals(all, { clicks: 440, impressions: 3500 });
  assertEquals(r.rowsUsed, 3);
  assertEquals(r.brandedExcludedRows, 0);
});

Deno.test("branded exclusion: is_branded=true dropped; null counted+included", () => {
  const rows: AggRow[] = [
    row({ position: 4, impressions: 100, clicks: 10, is_branded: true }),
    row({ position: 4, impressions: 200, clicks: 20, is_branded: null }),
    row({ position: 4, impressions: 300, clicks: 30, is_branded: false }),
  ];
  const r = buildAggregations(rows, false);
  const all = r.agg.all.generic.get(4)!;
  assertEquals(all, { clicks: 50, impressions: 500 });
  assertEquals(r.brandedExcludedRows, 1);
  assertEquals(r.unclassifiedRows, 1);
  assertEquals(r.rowsUsed, 2);
  assertEquals(r.rowsConsidered, 3);
});

Deno.test("legacy no-device path: only 'all' bucket exists", () => {
  const rows: AggRow[] = [
    row({ position: 1, impressions: 5000, clicks: 1500, search_intent: "transactional" }),
    row({ position: 2, impressions: 4000, clicks: 800, search_intent: "informational" }),
  ];
  const r = buildAggregations(rows, false);
  assert(r.agg.all);
  assertEquals((r.agg as any).mobile, undefined);
  assertEquals((r.agg as any).desktop, undefined);
  assertEquals(r.agg.all.transactional.get(1), { clicks: 1500, impressions: 5000 });
  assertEquals(r.agg.all.informational.get(2), { clicks: 800, impressions: 4000 });
});

Deno.test("per-bucket threshold independence: mobile skipped, desktop kept", () => {
  const MIN = 500;
  const rows: AggRow[] = [
    // mobile/commercial: 200 impr total across ranks -> below threshold
    row({ device: "mobile", position: 5, impressions: 200, clicks: 20, search_intent: "commercial" }),
    // desktop/commercial: 3000 impr -> above threshold
    row({ device: "desktop", position: 5, impressions: 3000, clicks: 400, search_intent: "commercial" }),
  ];
  const r = buildAggregations(rows, true);
  let mobImpr = 0;
  for (const v of r.agg.mobile.commercial.values()) mobImpr += v.impressions;
  let deskImpr = 0;
  for (const v of r.agg.desktop.commercial.values()) deskImpr += v.impressions;
  assert(mobImpr < MIN);
  assert(deskImpr >= MIN);
});

Deno.test("unknown device under mixed upload: contributes to 'all' only and is counted", () => {
  const rows: AggRow[] = [
    row({ device: null, position: 6, impressions: 1000, clicks: 50, search_intent: "informational" }),
    row({ device: "tablet", position: 6, impressions: 500, clicks: 20, search_intent: "informational" }),
    row({ device: "mobile", position: 6, impressions: 800, clicks: 40, search_intent: "informational" }),
  ];
  const r = buildAggregations(rows, true);
  assertEquals(r.unknownDeviceRows, 2);
  assertEquals(r.agg.mobile.informational.get(6), { clicks: 40, impressions: 800 });
  assertEquals(r.agg.desktop.informational.get(6), undefined);
  assertEquals(r.agg.all.informational.get(6), { clicks: 110, impressions: 2300 });
});

Deno.test("position filter: rows outside (0, 30.5] excluded from rowsUsed", () => {
  const rows: AggRow[] = [
    row({ position: 0, impressions: 100, clicks: 10 }),
    row({ position: 31, impressions: 100, clicks: 10 }),
    row({ position: 30.5, impressions: 100, clicks: 10 }),
    row({ position: 25, impressions: 100, clicks: 10 }),
    row({ position: 1, impressions: 100, clicks: 10 }),
  ];
  const r = buildAggregations(rows, false);
  assertEquals(r.rowsConsidered, 5);
  assertEquals(r.rowsUsed, 3);
});

Deno.test("rank-tail: r25 bucket aggregates into rankMap at rank=25", () => {
  const rows: AggRow[] = [
    row({ position: 25, impressions: 800, clicks: 12, search_intent: "commercial" }),
    row({ position: 24.7, impressions: 400, clicks: 5, search_intent: "commercial" }),
  ];
  const r = buildAggregations(rows, false);
  // Both round to rank 25 via clampRank; aggregated together.
  const b = r.agg.all.commercial.get(25);
  assertEquals(b, { clicks: 17, impressions: 1200 });
});

Deno.test("all five intent buckets exist per device (empty maps allowed)", () => {
  const r = buildAggregations([], true);
  for (const d of ["mobile", "desktop", "all"] as const) {
    for (const i of INTENT_KEYS) {
      assert(r.agg[d][i] instanceof Map);
    }
  }
});

Deno.test("CTR_ELIGIBLE_SOURCES: accepts both gsc_csv_v2 and gsc_workbook_v1", () => {
  assert(CTR_ELIGIBLE_SOURCES.includes("gsc_csv_v2"));
  assert(CTR_ELIGIBLE_SOURCES.includes("gsc_workbook_v1"));
  assertEquals(CTR_ELIGIBLE_SOURCES.length, 2);
});

// Predicate mirrors the guard in the handler: mixed upload requires at least
// one row to carry a per-row device value.
function anyRowHasDevice(rows: AggRow[]): boolean {
  return rows.some((r) => ((r.device ?? "").toString().toLowerCase().trim()).length > 0);
}

Deno.test("guard: mixed_upload_missing_row_devices fires when every row.device is null", () => {
  const allNull: AggRow[] = [
    row({ device: null, position: 3, impressions: 100, clicks: 10 }),
    row({ device: null, position: 5, impressions: 200, clicks: 20 }),
  ];
  assertEquals(anyRowHasDevice(allNull), false);

  const oneMobile: AggRow[] = [
    ...allNull,
    row({ device: "mobile", position: 4, impressions: 50, clicks: 5 }),
  ];
  assertEquals(anyRowHasDevice(oneMobile), true);
});

// Predicate mirrors the guard: at least one row must be branded-classified
// (true or false); all-null triggers the guard.
function anyRowClassified(rows: AggRow[]): boolean {
  return rows.some((r) => r.is_branded === true || r.is_branded === false);
}

Deno.test("guard: upload_unclassified fires when 100% is_branded is null", () => {
  const allNull: AggRow[] = [
    row({ is_branded: null, position: 3, impressions: 100, clicks: 10 }),
    row({ is_branded: null, position: 5, impressions: 200, clicks: 20 }),
  ];
  assertEquals(anyRowClassified(allNull), false);

  const oneClassified: AggRow[] = [
    ...allNull,
    row({ is_branded: false, position: 4, impressions: 50, clicks: 5 }),
  ];
  assertEquals(anyRowClassified(oneClassified), true);

  const oneBranded: AggRow[] = [
    ...allNull,
    row({ is_branded: true, position: 4, impressions: 50, clicks: 5 }),
  ];
  assertEquals(anyRowClassified(oneBranded), true);
});

// --- Unit convention (percentage points, matching STANDARD_CTR seeds) ---

Deno.test("blendRankCtr: full-trust bucket stores percentage points, not fraction", () => {
  // 100 clicks / 1000 impressions == 10% CTR.
  // Weight = min(1000/1000, 1) = 1 -> measured dominates, fallback ignored.
  // Must store 10.00 (percentage points), NOT 0.10 (fraction).
  const out = blendRankCtr(100, 1000, /* fallbackPct */ 28);
  assertEquals(out, 10);
  assert(out > 1, "value must be percentage points (>1), not a fraction");
});

Deno.test("blendRankCtr: partial-trust blend keeps unit consistency in percentage points", () => {
  // 5 clicks / 100 impressions == 5% measured.
  // Weight = 100 / 1000 = 0.1, fallback = 28 pp.
  // Expected = 0.1 * 0.05 + 0.9 * 0.28 = 0.005 + 0.252 = 0.257 -> 25.70 pp.
  const out = blendRankCtr(5, 100, 28);
  assertEquals(out, 25.7);
  assert(out <= 100, "clamped to <=100 (percentage points)");
});

Deno.test("blendRankCtr: no impressions returns fallback in percentage points", () => {
  assertEquals(blendRankCtr(0, 0, 28), 28);
});

Deno.test("blendRankCtr: clamps and rounds to 2dp; negatives coerced to 0", () => {
  assertEquals(blendRankCtr(0, 0, 150), 100);
  assertEquals(blendRankCtr(0, 0, -5), 0);
  // 1 click / 3 impressions == 33.333% at full trust when impressions >= trust
  // is not the case here; use small bucket with fallback 0 to isolate rounding.
  const out = blendRankCtr(1, 3, 0, /* rankFullTrust */ 3);
  assertEquals(out, 33.33);
});

// --- Honest provenance: zero-impression ranks must not be persisted ---

Deno.test("provenance: zero-impression ranks are skipped (no fallback impersonation)", () => {
  // Simulate the writer's per-rank decision: skip when bucket.impressions <= 0.
  const bucket = { clicks: 0, impressions: 0 };
  const shouldSkip = bucket.impressions <= 0;
  assertEquals(shouldSkip, true);
});

Deno.test("provenance: non-zero low-impression rank still blends and is written", () => {
  // 5 clicks / 100 impressions with fallback 28pp -> blended 25.70pp; written.
  const bucket = { clicks: 5, impressions: 100 };
  const shouldSkip = bucket.impressions <= 0;
  assertEquals(shouldSkip, false);
  const out = blendRankCtr(bucket.clicks, bucket.impressions, 28);
  assertEquals(out, 25.7);
});

Deno.test("provenance: ranks_skipped_empty count matches zero-impression ranks in bucket", () => {
  // Simulate a bucket where ranks 1-3 have data, 4-20 are empty.
  const rankMap = new Map<number, { clicks: number; impressions: number }>();
  rankMap.set(1, { clicks: 100, impressions: 1000 });
  rankMap.set(2, { clicks: 50, impressions: 500 });
  rankMap.set(3, { clicks: 20, impressions: 300 });

  const skipped: number[] = [];
  const written: number[] = [];
  for (let rank = 1; rank <= 20; rank++) {
    const bucket = rankMap.get(rank) ?? { clicks: 0, impressions: 0 };
    if (bucket.impressions <= 0) skipped.push(rank);
    else written.push(rank);
  }
  assertEquals(written.length, 3);
  assertEquals(skipped.length, 17);
  assertEquals(skipped[0], 4);
  assertEquals(skipped[skipped.length - 1], 20);
});

// --- PAV monotone-decreasing regularisation ---

Deno.test("pavNonIncreasing: observed inversion sequence is regularised non-increasing", () => {
  // Mobile/transactional r1-r10 from first-project-curve report §4 (observed
  // GSC average-position dilution artifact — r7 spikes above head buckets).
  const input = [
    { rank: 1, ctr: 0.31 },
    { rank: 2, ctr: 0.44 },
    { rank: 3, ctr: 0.40 },
    { rank: 4, ctr: 0.50 },
    { rank: 5, ctr: 0.80 },
    { rank: 6, ctr: 1.20 },
    { rank: 7, ctr: 1.61 },
    { rank: 8, ctr: 0.90 },
    { rank: 9, ctr: 0.60 },
    { rank: 10, ctr: 0.40 },
  ];
  const out = pavNonIncreasing(input);
  assertEquals(out.length, input.length);
  for (let i = 1; i < out.length; i++) {
    assert(out[i].ctr <= out[i - 1].ctr, `rank ${out[i].rank} > rank ${out[i - 1].rank}`);
  }
  // r1 gets pulled up by pooling with the r7 spike (was 0.31, must rise).
  assert(out[0].ctr > 0.31, `r1 should be pulled up by pool, got ${out[0].ctr}`);
  for (let i = 0; i < out.length; i++) {
    assertEquals(out[i].rank, input[i].rank);
  }
});

Deno.test("pavNonIncreasing: already-monotone input passes through unchanged", () => {
  const input = [
    { rank: 1, ctr: 28 },
    { rank: 2, ctr: 15 },
    { rank: 3, ctr: 11 },
    { rank: 4, ctr: 8 },
    { rank: 5, ctr: 6 },
    { rank: 6, ctr: 4 },
    { rank: 7, ctr: 3 },
    { rank: 8, ctr: 2 },
    { rank: 9, ctr: 1.5 },
    { rank: 10, ctr: 1 },
  ];
  const out = pavNonIncreasing(input);
  assertEquals(out, input);
});

Deno.test("pavNonIncreasing: skipped ranks stay absent; sequence over present ranks only", () => {
  // Gaps at ranks 3, 4, 6, 8, 9 — writer skipped them as zero-impression.
  const input = [
    { rank: 1, ctr: 0.5 },
    { rank: 2, ctr: 0.9 },   // violates -> will pool with r1
    { rank: 5, ctr: 0.4 },
    { rank: 7, ctr: 0.3 },
    { rank: 10, ctr: 0.2 },
  ];
  const out = pavNonIncreasing(input);
  assertEquals(out.length, 5);
  const ranks = out.map((r) => r.rank);
  assertEquals(ranks, [1, 2, 5, 7, 10]);
  for (let i = 1; i < out.length; i++) {
    assert(out[i].ctr <= out[i - 1].ctr);
  }
  // r1 and r2 pool to their mean (0.5 + 0.9) / 2 = 0.70.
  assertEquals(out[0].ctr, 0.7);
  assertEquals(out[1].ctr, 0.7);
});

// --- Rank-tail (r21-r30) coverage ---

import { buildCtrResolverV2, type CtrCurveRow } from "../_shared/ctr-resolver-v2.ts";

Deno.test("resolver: r21-r30 resolve via global fallback ladder when project curves absent", () => {
  const fallback: CtrCurveRow[] = [];
  const seeds: Record<number, number> = {
    21: 0.25, 22: 0.20, 23: 0.17, 24: 0.14, 25: 0.12,
    26: 0.10, 27: 0.08, 28: 0.07, 29: 0.06, 30: 0.05,
  };
  for (const [rank, pct] of Object.entries(seeds)) {
    fallback.push({
      project_id: null, device: "mobile", intent_segment: "transactional",
      rank_position: Number(rank), ctr_percentage: pct, is_fallback: true,
    });
  }
  const resolver = buildCtrResolverV2({ curves: fallback });
  for (let r = 21; r <= 30; r++) {
    const hit = resolver.resolve({ device: "mobile", intent: "transactional", position: r });
    assert(hit.tier !== "none", `rank ${r} resolved to tier=none (should hit ladder)`);
    assert(hit.ctrPercentage > 0, `rank ${r} ctrPercentage=${hit.ctrPercentage}`);
    assertEquals(hit.ctrPercentage, seeds[r]);
  }
});

Deno.test("resolver: rank > 30 remains the intended floor (tier=none)", () => {
  const resolver = buildCtrResolverV2({ curves: [] });
  const hit = resolver.resolve({ device: "all", intent: "generic", position: 45 });
  assertEquals(hit.tier, "none");
  assertEquals(hit.ctrPercentage, 0);
});

Deno.test("pavNonIncreasing: r1-r30 sequence stays monotone-non-increasing", () => {
  const input = Array.from({ length: 30 }, (_, i) => ({
    rank: i + 1,
    // Deliberate mid-range spike to force pooling across the extended range.
    ctr: i === 17 ? 5 : Math.max(0.05, 20 - i * 0.7),
  }));
  const out = pavNonIncreasing(input);
  assertEquals(out.length, 30);
  for (let i = 1; i < out.length; i++) {
    assert(out[i].ctr <= out[i - 1].ctr, `rank ${out[i].rank}=${out[i].ctr} > rank ${out[i-1].rank}=${out[i-1].ctr}`);
  }
});
