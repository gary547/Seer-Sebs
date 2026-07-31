// Shared v2 SERP visibility / CTR deflator helper.
//
// Pure module — no DB access, no side effects. Callers fetch a keyword's
// `serp_features` rows plus the active `serp_feature_ctr_adjustments` rows
// and pass them in. Returns a combined multiplier plus explanation metadata.
//
// Reserved for future Revenue/Forecast v2 wiring and the admin inspector.
// v1 `compute-forecasts` does not import this file.

export type SerpDevice = "mobile" | "desktop" | "all";
export type SerpIntent =
  | "transactional"
  | "commercial"
  | "informational"
  | "navigational"
  | "generic";

export interface SerpFeatureRow {
  keyword_id: string;
  result_type: string | null;
  serp_feature_count: number | null;
  serp_feature_owned: boolean | null;
  snippet_opportunity: boolean | null;
}

export interface SerpAdjustmentRow {
  feature_type: string;
  device: string;
  intent: string;
  multiplier: number;
  confidence: "low" | "medium" | "high" | null;
  is_active: boolean;
}

export interface SerpVisibilityInput {
  projectId: string;
  keywordId: string;
  device: SerpDevice | string | null | undefined;
  intent: string | null | undefined;
  features: SerpFeatureRow[];
  adjustments: SerpAdjustmentRow[];
}

export type SerpMatchTier =
  | "device_intent"
  | "all_intent"
  | "device_generic"
  | "all_generic"
  | "none";

export interface MatchedFeature {
  featureType: string;
  multiplier: number;
  rawMultiplier: number;
  confidence: "low" | "medium" | "high" | null;
  matchedDevice: SerpDevice | null;
  matchedIntent: SerpIntent | null;
  tier: SerpMatchTier;
  owned: boolean;
  snippetOpportunity: boolean;
}

export interface SerpVisibilityResolution {
  multiplier: number;
  matched: MatchedFeature[];
  unmatchedFeatureTypes: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  explanation: string;
  dataQualityWarning: string | null;
  /**
   * Structured warning codes aligned with Prompt 1.6. Additive to
   * `dataQualityWarning` (free text). Emitted:
   *   - `missing_svm` when the keyword has zero SERP feature rows.
   *   - `svm_unmatched_features` when ≥1 feature has no active adjustment row.
   */
  warningCodes: string[];
  requestedDevice: SerpDevice;
  requestedIntent: SerpIntent;
  featureCount: number;
}

const INTENTS: SerpIntent[] = [
  "transactional",
  "commercial",
  "informational",
  "navigational",
  "generic",
];

const MIN_MULTIPLIER = 0.1;
const MAX_MULTIPLIER = 1.5;

export function normaliseIntent(v: string | null | undefined): SerpIntent {
  const s = (v ?? "").toString().toLowerCase().trim();
  return (INTENTS as string[]).includes(s) ? (s as SerpIntent) : "generic";
}

export function normaliseDevice(v: string | null | undefined): SerpDevice {
  const s = (v ?? "").toString().toLowerCase().trim();
  if (s === "mobile" || s === "desktop" || s === "all") return s;
  return "all";
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

interface AdjIndex {
  byKey: Map<string, SerpAdjustmentRow>;
}

function key(featureType: string, device: string, intent: string): string {
  return `${featureType}|${device}|${intent}`;
}

function buildAdjIndex(rows: SerpAdjustmentRow[]): AdjIndex {
  const byKey = new Map<string, SerpAdjustmentRow>();
  for (const r of rows ?? []) {
    if (!r || r.is_active === false) continue;
    if (!r.feature_type) continue;
    byKey.set(
      key(
        r.feature_type.toLowerCase().trim(),
        (r.device ?? "all").toLowerCase().trim(),
        (r.intent ?? "generic").toLowerCase().trim(),
      ),
      r,
    );
  }
  return { byKey };
}

function pickAdjustment(
  index: AdjIndex,
  featureType: string,
  device: SerpDevice,
  intent: SerpIntent,
): { row: SerpAdjustmentRow; tier: SerpMatchTier } | null {
  const ladder: Array<{ d: SerpDevice; i: SerpIntent; tier: SerpMatchTier }> = [
    { d: device, i: intent, tier: "device_intent" },
    { d: "all", i: intent, tier: "all_intent" },
    { d: device, i: "generic", tier: "device_generic" },
    { d: "all", i: "generic", tier: "all_generic" },
  ];
  for (const step of ladder) {
    const row = index.byKey.get(key(featureType, step.d, step.i));
    if (row) return { row, tier: step.tier };
  }
  return null;
}

export function resolveSerpVisibilityV2(
  input: SerpVisibilityInput,
): SerpVisibilityResolution {
  const requestedDevice = normaliseDevice(input.device);
  const requestedIntent = normaliseIntent(input.intent);
  const adjIndex = buildAdjIndex(input.adjustments ?? []);

  // Deduplicate features by result_type (case-insensitive).
  const seen = new Map<string, SerpFeatureRow>();
  for (const f of input.features ?? []) {
    if (!f) continue;
    const t = (f.result_type ?? "").toLowerCase().trim();
    if (!t) continue;
    if (!seen.has(t)) seen.set(t, f);
  }

  const matched: MatchedFeature[] = [];
  const unmatched: string[] = [];
  const invalidMultipliers: string[] = [];

  for (const [featureType, row] of seen) {
    const owned = row.serp_feature_owned === true;
    const snippet = row.snippet_opportunity === true;
    const hit = pickAdjustment(adjIndex, featureType, requestedDevice, requestedIntent);
    if (!hit) {
      unmatched.push(featureType);
      matched.push({
        featureType,
        multiplier: 1,
        rawMultiplier: 1,
        confidence: null,
        matchedDevice: null,
        matchedIntent: null,
        tier: "none",
        owned,
        snippetOpportunity: snippet,
      });
      continue;
    }
    const raw = Number(hit.row.multiplier);
    let mult = raw;
    if (!Number.isFinite(mult) || mult <= 0) {
      invalidMultipliers.push(featureType);
      mult = 1;
    }
    // Owning a feature should never deflate CTR.
    if (owned && mult < 1) mult = 1;

    matched.push({
      featureType,
      multiplier: mult,
      rawMultiplier: raw,
      confidence: hit.row.confidence ?? null,
      matchedDevice: (hit.row.device as SerpDevice) ?? null,
      matchedIntent: (hit.row.intent as SerpIntent) ?? null,
      tier: hit.tier,
      owned,
      snippetOpportunity: snippet,
    });
  }

  const featureCount = seen.size;
  const product = matched.reduce((acc, m) => acc * (m.tier === "none" ? 1 : m.multiplier), 1);
  const multiplier = featureCount === 0 ? 1 : clamp(product, MIN_MULTIPLIER, MAX_MULTIPLIER);

  // Confidence rollup.
  let confidence: SerpVisibilityResolution["confidence"];
  if (featureCount === 0) {
    confidence = "unknown";
  } else if (
    unmatched.length > 0 ||
    matched.some((m) => m.tier !== "none" && m.confidence === "low")
  ) {
    confidence = "low";
  } else if (matched.some((m) => m.confidence === "medium")) {
    confidence = "medium";
  } else if (matched.every((m) => m.tier === "none" || m.confidence === "high")) {
    confidence = "high";
  } else {
    confidence = "medium";
  }

  // Data quality warning.
  let dataQualityWarning: string | null = null;
  if (featureCount === 0) {
    dataQualityWarning = "No SERP features recorded — multiplier defaults to 1.0";
  } else if (unmatched.length > 0) {
    dataQualityWarning = `${unmatched.length} feature(s) had no adjustment row: ${unmatched.join(", ")}`;
  } else if (invalidMultipliers.length > 0) {
    dataQualityWarning = `Invalid multiplier for: ${invalidMultipliers.join(", ")}`;
  }

  // Explanation.
  const explanation = featureCount === 0
    ? "No SERP features — visibility multiplier 1.00"
    : matched
        .map((m) => `${m.featureType} ×${m.multiplier.toFixed(2)} (${m.tier})`)
        .join(", ");

  const warningCodes: string[] = [];
  if (featureCount === 0) warningCodes.push("missing_svm");
  if (unmatched.length > 0) warningCodes.push("svm_unmatched_features");

  return {
    multiplier,
    matched,
    unmatchedFeatureTypes: unmatched,
    confidence,
    explanation,
    dataQualityWarning,
    warningCodes,
    requestedDevice,
    requestedIntent,
    featureCount,
  };
}
