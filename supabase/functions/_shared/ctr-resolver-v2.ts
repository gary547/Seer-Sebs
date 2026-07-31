// Shared v2 CTR resolver.
//
// Pure module — no DB access, no side effects. Callers fetch `ctr_curves` (+
// optional `ctr_curve_metadata`) rows and pass them to `buildCtrResolverV2`,
// then call `.resolve({ device, intent, position })` per keyword.
//
// This is intentionally decoupled from v1 `compute-forecasts` — v1 keeps its
// inline `getCtr` untouched. Reserved for future Revenue v2 wiring and the
// admin inspector.

export type CtrDevice = "mobile" | "desktop" | "all";
export type CtrIntent =
  | "transactional"
  | "commercial"
  | "informational"
  | "navigational"
  | "generic";

export interface CtrCurveRow {
  project_id: string | null;
  device: CtrDevice | string;
  intent_segment: string | null;
  rank_position: number;
  ctr_percentage: number;
  is_fallback: boolean;
  id?: string;
}

export interface CtrCurveMetaRow {
  ctr_curve_id: string;
  source: string;
  confidence: "low" | "medium" | "high" | null;
  sample_impressions: number | null;
  sample_clicks: number | null;
  date_range_start: string | null;
  date_range_end: string | null;
}

export type CtrResolverSourceTier =
  | "project_device_intent"
  | "project_all_intent"
  | "project_device_generic"
  | "project_all_generic"
  | "fallback_device_intent"
  | "fallback_device_generic"
  | "fallback_generic"
  | "none";

export interface CtrResolution {
  ctr: number;
  ctrPercentage: number;
  position: number | null;
  requestedDevice: CtrDevice;
  resolvedDevice: CtrDevice | null;
  requestedIntent: CtrIntent;
  resolvedIntent: CtrIntent | null;
  tier: CtrResolverSourceTier;
  usedAllDeviceFallback: boolean;
  source: string | null;
  confidence: "low" | "medium" | "high" | null;
  sampleImpressions: number | null;
  sampleClicks: number | null;
  curveId: string | null;
  clamped: boolean;
  preClampCtr: number;
  preClampCtrPercentage: number;
}

export interface BuildResolverInput {
  curves: CtrCurveRow[];
  metadata?: CtrCurveMetaRow[];
}

export interface CtrResolver {
  resolve(args: {
    device: CtrDevice | string | null | undefined;
    intent: string | null | undefined;
    position: number | null | undefined;
  }): CtrResolution;
}

const INTENTS: CtrIntent[] = [
  "transactional",
  "commercial",
  "informational",
  "navigational",
  "generic",
];

export function normaliseIntent(v: string | null | undefined): CtrIntent {
  const s = (v ?? "").toString().toLowerCase().trim();
  return (INTENTS as string[]).includes(s) ? (s as CtrIntent) : "generic";
}

export function normaliseDevice(v: string | null | undefined): CtrDevice {
  const s = (v ?? "").toString().toLowerCase().trim();
  if (s === "mobile" || s === "desktop" || s === "all") return s;
  return "all";
}

// Matches v1 `getCtr` semantics but with the rank ceiling raised to 30 to
// cover the rank-tail band written by ctr-curves-from-gsc (r1-30). Null /
// non-finite / <= 0 or > 30 bail out; otherwise Math.round clamped to [1, 30].
// Ranks > 30 are the intended floor: keywords at r31+ resolve to tier=none.
export function roundPositionV1(
  pos: number | null | undefined,
): number | null {
  if (pos === null || pos === undefined) return null;
  const n = Number(pos);
  if (!Number.isFinite(n) || n <= 0 || n > 30) return null;
  const r = Math.round(n);
  if (r < 1) return 1;
  if (r > 30) return 30;
  return r;
}

function intentKeyFromRow(row: CtrCurveRow): CtrIntent {
  return normaliseIntent(row.intent_segment);
}

function key(device: string, intent: string, rank: number): string {
  return `${device}|${intent}|${rank}`;
}

// Prefer the row with the most recent metadata date_range_end, then highest
// sample_impressions. Rows without metadata sort last. Returns positive if `a`
// should win over `b`.
function tieBreak(
  a: CtrCurveRow,
  b: CtrCurveRow,
  metaById: Map<string, CtrCurveMetaRow>,
): number {
  const ma = a.id ? metaById.get(a.id) : undefined;
  const mb = b.id ? metaById.get(b.id) : undefined;
  const aEnd = ma?.date_range_end ?? "";
  const bEnd = mb?.date_range_end ?? "";
  if (aEnd !== bEnd) return aEnd > bEnd ? 1 : -1;
  const aImpr = ma?.sample_impressions ?? -1;
  const bImpr = mb?.sample_impressions ?? -1;
  if (aImpr !== bImpr) return aImpr > bImpr ? 1 : -1;
  return 0;
}

export function buildCtrResolverV2(input: BuildResolverInput): CtrResolver {
  const metaById = new Map<string, CtrCurveMetaRow>();
  for (const m of input.metadata ?? []) {
    if (m?.ctr_curve_id) metaById.set(m.ctr_curve_id, m);
  }

  const projectMap = new Map<string, CtrCurveRow>();
  const fallbackMap = new Map<string, CtrCurveRow>();
  const fallbackGenericAny = new Map<number, CtrCurveRow>();

  const put = (
    map: Map<string, CtrCurveRow>,
    k: string,
    row: CtrCurveRow,
  ) => {
    const prev = map.get(k);
    if (!prev || tieBreak(row, prev, metaById) > 0) map.set(k, row);
  };

  for (const row of input.curves ?? []) {
    if (!row) continue;
    const device = normaliseDevice(row.device);
    const intent = intentKeyFromRow(row);
    const rank = Number(row.rank_position);
    if (!Number.isFinite(rank) || rank < 1 || rank > 30) continue;
    const k = key(device, intent, rank);
    if (row.is_fallback) {
      put(fallbackMap, k, row);
      if (intent === "generic") {
        const prev = fallbackGenericAny.get(rank);
        if (!prev || tieBreak(row, prev, metaById) > 0) {
          fallbackGenericAny.set(rank, row);
        }
      }
    } else {
      put(projectMap, k, row);
    }
  }

  function resolutionFor(
    row: CtrCurveRow | undefined,
    tier: CtrResolverSourceTier,
    requestedDevice: CtrDevice,
    requestedIntent: CtrIntent,
    position: number | null,
  ): CtrResolution {
    if (!row || position === null) {
      return {
        ctr: 0,
        ctrPercentage: 0,
        position,
        requestedDevice,
        resolvedDevice: null,
        requestedIntent,
        resolvedIntent: null,
        tier: "none",
        usedAllDeviceFallback: false,
        source: null,
        confidence: null,
        sampleImpressions: null,
        sampleClicks: null,
        curveId: null,
        clamped: false,
        preClampCtr: 0,
        preClampCtrPercentage: 0,
      };
    }
    const resolvedDevice = normaliseDevice(row.device);
    const resolvedIntent = intentKeyFromRow(row);
    const meta = row.id ? metaById.get(row.id) : undefined;
    const isFallbackRow = row.is_fallback;
    const pct = Number(row.ctr_percentage) || 0;
    return {
      ctr: pct / 100,
      ctrPercentage: pct,
      position,
      requestedDevice,
      resolvedDevice,
      requestedIntent,
      resolvedIntent,
      tier,
      usedAllDeviceFallback:
        (tier === "project_all_intent" || tier === "project_all_generic") &&
        requestedDevice !== "all",
      source: isFallbackRow ? "fallback_static" : meta?.source ?? null,
      confidence: isFallbackRow ? null : meta?.confidence ?? null,
      sampleImpressions: isFallbackRow ? null : meta?.sample_impressions ?? null,
      sampleClicks: isFallbackRow ? null : meta?.sample_clicks ?? null,
      curveId: row.id ?? null,
      clamped: false,
      preClampCtr: pct / 100,
      preClampCtrPercentage: pct,
    };
  }


  function resolveRaw(
    requestedDevice: CtrDevice,
    requestedIntent: CtrIntent,
    pos: number | null,
  ): CtrResolution {
    if (pos === null) {
      return resolutionFor(undefined, "none", requestedDevice, requestedIntent, null);
    }

    // 1. project / requested device / requested intent
    let hit = projectMap.get(key(requestedDevice, requestedIntent, pos));
    if (hit) {
      return resolutionFor(hit, "project_device_intent", requestedDevice, requestedIntent, pos);
    }

    // 2. project / all / requested intent (skip if already 'all')
    if (requestedDevice !== "all") {
      hit = projectMap.get(key("all", requestedIntent, pos));
      if (hit) {
        return resolutionFor(hit, "project_all_intent", requestedDevice, requestedIntent, pos);
      }
    }

    // 3. project / requested device / generic
    if (requestedIntent !== "generic") {
      hit = projectMap.get(key(requestedDevice, "generic", pos));
      if (hit) {
        return resolutionFor(hit, "project_device_generic", requestedDevice, requestedIntent, pos);
      }
    }

    // 4. project / all / generic (skip if already 'all')
    if (requestedDevice !== "all") {
      hit = projectMap.get(key("all", "generic", pos));
      if (hit) {
        return resolutionFor(hit, "project_all_generic", requestedDevice, requestedIntent, pos);
      }
    }

    // 5. fallback / requested device / requested intent
    hit = fallbackMap.get(key(requestedDevice, requestedIntent, pos));
    if (hit) {
      return resolutionFor(hit, "fallback_device_intent", requestedDevice, requestedIntent, pos);
    }

    // 6. fallback / requested device / generic
    if (requestedIntent !== "generic") {
      hit = fallbackMap.get(key(requestedDevice, "generic", pos));
      if (hit) {
        return resolutionFor(hit, "fallback_device_generic", requestedDevice, requestedIntent, pos);
      }
    }

    // 7. fallback / any device / generic
    hit = fallbackGenericAny.get(pos);
    if (hit) {
      return resolutionFor(hit, "fallback_generic", requestedDevice, requestedIntent, pos);
    }

    // 8. none
    return resolutionFor(undefined, "none", requestedDevice, requestedIntent, pos);
  }

  // Per-context memoised ladder of clamped resolutions across ranks 1..30.
  // Clamp rule: at rank R, ctr = min(raw[R].ctr, clamped[R-1].ctr). This
  // enforces non-increasing resolved CTR by rank regardless of which tier
  // supplied each raw value. Tier attribution is preserved as-supplied.
  const ladderCache = new Map<string, CtrResolution[]>();

  function getLadder(device: CtrDevice, intent: CtrIntent): CtrResolution[] {
    const k = `${device}|${intent}`;
    const cached = ladderCache.get(k);
    if (cached) return cached;
    const ladder: CtrResolution[] = new Array(31); // index by rank 1..30
    let running = Infinity;
    for (let r = 1; r <= 30; r++) {
      const raw = resolveRaw(device, intent, r);
      const rawCtr = raw.ctr;
      let clampedCtr = rawCtr;
      let didClamp = false;
      if (raw.tier !== "none" && rawCtr > running) {
        clampedCtr = running;
        didClamp = true;
      }
      if (raw.tier !== "none" && clampedCtr < running) {
        running = clampedCtr;
      }
      ladder[r] = {
        ...raw,
        ctr: clampedCtr,
        ctrPercentage: clampedCtr * 100,
        clamped: didClamp,
        preClampCtr: rawCtr,
        preClampCtrPercentage: rawCtr * 100,
      };
    }
    ladderCache.set(k, ladder);
    return ladder;
  }

  return {
    resolve({ device, intent, position }) {
      const requestedDevice = normaliseDevice(device);
      const requestedIntent = normaliseIntent(intent);
      const pos = roundPositionV1(position);
      if (pos === null) {
        return resolutionFor(undefined, "none", requestedDevice, requestedIntent, null);
      }
      const ladder = getLadder(requestedDevice, requestedIntent);
      return ladder[pos];
    },
  };
}

