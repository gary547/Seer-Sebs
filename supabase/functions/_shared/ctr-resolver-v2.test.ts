// Deno tests for the v2 CTR resolver. Run via supabase--test_edge_functions
// or `deno test supabase/functions/_shared/ctr-resolver-v2.test.ts`.

import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildCtrResolverV2,
  normaliseIntent,
  roundPositionV1,
  type CtrCurveMetaRow,
  type CtrCurveRow,
} from "./ctr-resolver-v2.ts";

function row(
  overrides: Partial<CtrCurveRow> & { rank_position: number },
): CtrCurveRow {
  return {
    project_id: "p1",
    device: "desktop",
    intent_segment: null,
    ctr_percentage: 10,
    is_fallback: false,
    id: crypto.randomUUID(),
    ...overrides,
  };
}

function meta(
  ctr_curve_id: string,
  overrides: Partial<CtrCurveMetaRow> = {},
): CtrCurveMetaRow {
  return {
    ctr_curve_id,
    source: "gsc_workbook_all_device",
    confidence: "high",
    sample_impressions: 10000,
    sample_clicks: 500,
    date_range_start: "2025-01-01",
    date_range_end: "2025-03-31",
    ...overrides,
  };
}

Deno.test("tier 1: project · device · intent · position", () => {
  const r = row({
    device: "desktop",
    intent_segment: "transactional",
    rank_position: 3,
    ctr_percentage: 22,
  });
  const resolver = buildCtrResolverV2({ curves: [r], metadata: [meta(r.id!)] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "project_device_intent");
  assertEquals(out.usedAllDeviceFallback, false);
  assertEquals(out.resolvedDevice, "desktop");
  assertEquals(out.resolvedIntent, "transactional");
  assertAlmostEquals(out.ctr, 0.22);
  assertEquals(out.source, "gsc_workbook_all_device");
  assertEquals(out.confidence, "high");
  assertEquals(out.sampleImpressions, 10000);
});

Deno.test("tier 2: project · all · intent (all-device fallback)", () => {
  const allRow = row({
    device: "all",
    intent_segment: "transactional",
    rank_position: 3,
    ctr_percentage: 18,
  });
  const resolver = buildCtrResolverV2({
    curves: [allRow],
    metadata: [meta(allRow.id!)],
  });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "project_all_intent");
  assertEquals(out.usedAllDeviceFallback, true);
  assertEquals(out.resolvedDevice, "all");
});

Deno.test("tier 3: project · device · generic", () => {
  const generic = row({
    device: "desktop",
    intent_segment: null,
    rank_position: 3,
    ctr_percentage: 9,
  });
  const resolver = buildCtrResolverV2({ curves: [generic] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "project_device_generic");
  assertEquals(out.usedAllDeviceFallback, false);
  assertEquals(out.resolvedIntent, "generic");
});

Deno.test("tier 4: project · all · generic", () => {
  const generic = row({
    device: "all",
    intent_segment: null,
    rank_position: 3,
    ctr_percentage: 7,
  });
  const resolver = buildCtrResolverV2({ curves: [generic] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "project_all_generic");
  assertEquals(out.usedAllDeviceFallback, true);
});

Deno.test("tier 5: fallback · device · intent", () => {
  const fb = row({
    project_id: null,
    device: "desktop",
    intent_segment: "transactional",
    rank_position: 3,
    ctr_percentage: 14,
    is_fallback: true,
  });
  const resolver = buildCtrResolverV2({ curves: [fb] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "fallback_device_intent");
  assertEquals(out.source, "fallback_static");
  assertEquals(out.confidence, null);
});

Deno.test("tier 6: fallback · device · generic", () => {
  const fb = row({
    project_id: null,
    device: "desktop",
    intent_segment: null,
    rank_position: 3,
    ctr_percentage: 8,
    is_fallback: true,
  });
  const resolver = buildCtrResolverV2({ curves: [fb] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "fallback_device_generic");
});

Deno.test("tier 7: fallback · any device · generic", () => {
  const fb = row({
    project_id: null,
    device: "mobile",
    intent_segment: null,
    rank_position: 3,
    ctr_percentage: 6,
    is_fallback: true,
  });
  const resolver = buildCtrResolverV2({ curves: [fb] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "fallback_generic");
  assertEquals(out.resolvedDevice, "mobile");
});

Deno.test("tier 8: none · empty curves → ctr 0", () => {
  const resolver = buildCtrResolverV2({ curves: [] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 3,
  });
  assertEquals(out.tier, "none");
  assertEquals(out.ctr, 0);
  assertEquals(out.resolvedDevice, null);
});

Deno.test("metadata surfacing for project row; fallback row → fallback_static", () => {
  const proj = row({
    device: "desktop",
    intent_segment: "commercial",
    rank_position: 5,
    ctr_percentage: 12,
  });
  const fb = row({
    project_id: null,
    device: "desktop",
    intent_segment: "commercial",
    rank_position: 5,
    ctr_percentage: 4,
    is_fallback: true,
  });
  const resolver = buildCtrResolverV2({
    curves: [proj, fb],
    metadata: [
      meta(proj.id!, { source: "gsc_workbook_all_device", confidence: "medium", sample_impressions: 2000, sample_clicks: 240 }),
      meta(fb.id!, { source: "should_be_ignored", confidence: "high" }),
    ],
  });
  const out = resolver.resolve({ device: "desktop", intent: "commercial", position: 5 });
  assertEquals(out.tier, "project_device_intent");
  assertEquals(out.source, "gsc_workbook_all_device");
  assertEquals(out.confidence, "medium");
  assertEquals(out.sampleImpressions, 2000);
  assertEquals(out.sampleClicks, 240);
});

Deno.test("position rounding matches v1", () => {
  assertEquals(roundPositionV1(3.4), 3);
  assertEquals(roundPositionV1(3.6), 4);
  assertEquals(roundPositionV1(20.5), 21); // r21-30 ladder now covers this
  assertEquals(roundPositionV1(20), 20);
  assertEquals(roundPositionV1(0.4), 1);
  assertEquals(roundPositionV1(21), 21); // within the extended ladder
  assertEquals(roundPositionV1(30.0), 30); // upper cap inclusive
  assertEquals(roundPositionV1(30.5), null); // strictly greater than 30 bails
  assertEquals(roundPositionV1(31), null); // above-30 bails
  assertEquals(roundPositionV1(0), null);
  assertEquals(roundPositionV1(null), null);
  assertEquals(roundPositionV1(undefined), null);
  assertEquals(roundPositionV1(Number.NaN), null);
});

Deno.test("requestedDevice='all' skips tiers 2/4", () => {
  const generic = row({
    device: "all",
    intent_segment: null,
    rank_position: 3,
    ctr_percentage: 5,
  });
  const resolver = buildCtrResolverV2({ curves: [generic] });
  const out = resolver.resolve({ device: "all", intent: "transactional", position: 3 });
  // Should skip tier 2 (all/intent missing) and land on tier 3 (all/generic).
  assertEquals(out.tier, "project_device_generic");
  assertEquals(out.usedAllDeviceFallback, false);
});

Deno.test("intent normalisation", () => {
  assertEquals(normaliseIntent("Transactional "), "transactional");
  assertEquals(normaliseIntent(""), "generic");
  assertEquals(normaliseIntent("weird"), "generic");
  assertEquals(normaliseIntent(null), "generic");
  assertEquals(normaliseIntent(undefined), "generic");
});

// -------- Monotonicity clamp --------

Deno.test("clamp: cross-tier rank-29 generic clamps to rank-20 intent", () => {
  // rank 20 served by project_device_intent at 0.39%
  const intentR20 = row({
    device: "desktop",
    intent_segment: "transactional",
    rank_position: 20,
    ctr_percentage: 0.39,
  });
  // rank 29 only available via project_device_generic at 1.52%
  const genericR29 = row({
    device: "desktop",
    intent_segment: null,
    rank_position: 29,
    ctr_percentage: 1.52,
  });
  const resolver = buildCtrResolverV2({ curves: [intentR20, genericR29] });
  const out = resolver.resolve({
    device: "desktop",
    intent: "transactional",
    position: 29,
  });
  assertEquals(out.tier, "project_device_generic");
  assertEquals(out.clamped, true);
  assertAlmostEquals(out.preClampCtr, 0.0152);
  // Clamped ctr must be <= rank-20 intent value (0.0039).
  assertEquals(out.ctr <= 0.0039 + 1e-12, true);
});

Deno.test("clamp: strictly decreasing single-tier ladder passes through", () => {
  const curves: CtrCurveRow[] = [];
  for (let r = 1; r <= 30; r++) {
    curves.push(
      row({
        device: "desktop",
        intent_segment: "commercial",
        rank_position: r,
        ctr_percentage: 30 - r, // 29, 28, ... 0
      }),
    );
  }
  const resolver = buildCtrResolverV2({ curves });
  for (let r = 1; r <= 30; r++) {
    const out = resolver.resolve({
      device: "desktop",
      intent: "commercial",
      position: r,
    });
    assertEquals(out.clamped, false);
    assertAlmostEquals(out.ctr, (30 - r) / 100);
    assertAlmostEquals(out.preClampCtr, (30 - r) / 100);
  }
});

Deno.test("clamp: only lowers, never raises", () => {
  // Spike ladder: r5 high, r6 low, r7 high again.
  const mk = (r: number, pct: number) =>
    row({
      device: "desktop",
      intent_segment: "commercial",
      rank_position: r,
      ctr_percentage: pct,
    });
  const resolver = buildCtrResolverV2({
    curves: [mk(5, 20), mk(6, 5), mk(7, 30), mk(8, 2)],
  });
  const r5 = resolver.resolve({ device: "desktop", intent: "commercial", position: 5 });
  const r6 = resolver.resolve({ device: "desktop", intent: "commercial", position: 6 });
  const r7 = resolver.resolve({ device: "desktop", intent: "commercial", position: 7 });
  const r8 = resolver.resolve({ device: "desktop", intent: "commercial", position: 8 });

  // r5: first observed, no clamp.
  assertEquals(r5.clamped, false);
  assertAlmostEquals(r5.ctr, 0.20);
  // r6: 0.05 < running 0.20 → passthrough.
  assertEquals(r6.clamped, false);
  assertAlmostEquals(r6.ctr, 0.05);
  // r7: raw 0.30 > running 0.05 → clamp.
  assertEquals(r7.clamped, true);
  assertAlmostEquals(r7.preClampCtr, 0.30);
  assertEquals(r7.ctr <= 0.05 + 1e-12, true);
  // r8: raw 0.02 < running 0.05 → passthrough.
  assertEquals(r8.clamped, false);
  assertAlmostEquals(r8.ctr, 0.02);
});

Deno.test("clamp: per (device, intent) context, no leakage", () => {
  // Context A: desktop/transactional — spike at r7 that would clamp.
  const a5 = row({
    device: "desktop", intent_segment: "transactional",
    rank_position: 5, ctr_percentage: 10,
  });
  const a7 = row({
    device: "desktop", intent_segment: "transactional",
    rank_position: 7, ctr_percentage: 25,
  });
  // Context B: mobile/informational — high value at r7, no earlier ranks that would depress it.
  const b7 = row({
    device: "mobile", intent_segment: "informational",
    rank_position: 7, ctr_percentage: 40,
  });
  const resolver = buildCtrResolverV2({ curves: [a5, a7, b7] });

  const outA = resolver.resolve({ device: "desktop", intent: "transactional", position: 7 });
  assertEquals(outA.clamped, true);
  assertEquals(outA.ctr <= 0.10 + 1e-12, true);

  const outB = resolver.resolve({ device: "mobile", intent: "informational", position: 7 });
  // Context B has no lower running value, so passthrough at 0.40.
  assertEquals(outB.clamped, false);
  assertAlmostEquals(outB.ctr, 0.40);
  assertAlmostEquals(outB.preClampCtr, 0.40);
});

