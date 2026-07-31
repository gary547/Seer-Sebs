// Shared pure helpers for HAR v2 composite scenario computation.
// No I/O, no external calls. Deterministic. Unit-tested in har-v2.test.ts.

export const HAR_V2_MODEL_VERSION = "har_v2.1.0";

export type Scenario = "conservative" | "realistic" | "stretch";
export const SCENARIOS: Scenario[] = ["conservative", "realistic", "stretch"];

export type ClientLpsSource = "serp_row" | "synthetic_client_domain" | "unavailable";
export type ClientLpsMatch = "ranking_url" | "domain_fallback" | "synthetic" | "unavailable";

export interface CompetitorRow {
  rank_absolute: number | null;
  url: string | null;
  domain: string | null;
  url_rating: number | null;
  domain_rating: number | null;
  lps_score: number | null;
}

export interface CompositeInputs {
  client_lps: number | null;
  client_ur: number | null;
  client_dr: number | null;
  client_lps_source?: ClientLpsSource;
  client_lps_match?: ClientLpsMatch;
  client_resolved_url?: string | null;
  competitors: CompetitorRow[];
  content_fit_score: number | null; // 0..1
  serp_feature_count: number | null;
  top_serp_feature: string | null;
  snippet_opportunity: boolean | null;
  base_rank: number | null;
  latest_lps_run_exists: boolean;
  has_client_lps_row: boolean;
  has_client_authority: boolean;
}

export interface ScenarioResult {
  scenario: Scenario;
  har_position: number | null;
  har_confidence: number;
  rank_attainment_probability: number | null;
  authority_score: number | null;
  link_power_score: number | null;
  link_gap_score: number | null;
  content_fit_score: number | null;
  serp_visibility_multiplier: number | null;
  explanation_json: Record<string, unknown>;
}

export interface OverrideInfo {
  har: number;
  v1_forecast_id: string | null;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

export function serpPenalty(featureCount: number | null, topFeature: string | null): number {
  const c = Number.isFinite(featureCount as number) ? Math.max(0, featureCount as number) : 0;
  const topBoost = topFeature ? 0.10 : 0;
  return clamp(0.05 * c + topBoost, 0, 0.35);
}

// -- Scenario knobs ---------------------------------------------------------
// Historically hard-coded; Prompt 1.7 wires these through har_scoring_config
// so operators can tune HAR v2.1 without a code deploy. When no config is
// passed, the helpers fall back to these baked-in defaults verbatim.
export type ScenarioMap = Partial<Record<Scenario, number>>;

export interface ScoringConfig {
  config_id?: string | null;
  config_version?: string | null;
  scenario_thresholds?: ScenarioMap;
  scenario_temperatures?: ScenarioMap;
  scenario_floor_multipliers?: ScenarioMap;
  scenario_prob_factors?: ScenarioMap;
  min_confidence?: number | null;
}

const DEFAULT_THRESHOLDS: Record<Scenario, number> = { conservative: 0.60, realistic: 0.50, stretch: 0.40 };
const DEFAULT_TEMPERATURES: Record<Scenario, number> = { conservative: 1.6, realistic: 1.0, stretch: 0.7 };
const DEFAULT_FLOOR_MULTIPLIERS: Record<Scenario, number> = { conservative: 0.7, realistic: 0.5, stretch: 0.3 };
const DEFAULT_PROB_FACTORS: Record<Scenario, number> = { conservative: 0.85, realistic: 1.0, stretch: 1.15 };
const DEFAULT_MIN_CONFIDENCE_FALLBACK = 0.05;

function pickScenario(
  map: ScenarioMap | undefined,
  s: Scenario,
  fallback: Record<Scenario, number>,
): number {
  const v = map?.[s];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback[s];
}

export function scenarioThreshold(s: Scenario, cfg?: ScoringConfig): number {
  return pickScenario(cfg?.scenario_thresholds, s, DEFAULT_THRESHOLDS);
}

export function scenarioTemperature(s: Scenario, cfg?: ScoringConfig): number {
  return pickScenario(cfg?.scenario_temperatures, s, DEFAULT_TEMPERATURES);
}

export function scenarioFloorMultiplier(s: Scenario, cfg?: ScoringConfig): number {
  return pickScenario(cfg?.scenario_floor_multipliers, s, DEFAULT_FLOOR_MULTIPLIERS);
}

export function scenarioProbFactor(s: Scenario, cfg?: ScoringConfig): number {
  return pickScenario(cfg?.scenario_prob_factors, s, DEFAULT_PROB_FACTORS);
}

// Compute p_beat for a single competitor. Returns null if competitor lacks
// both LPS and UR (row is skipped in the ladder).
export function pBeat(
  clientLps: number | null,
  clientUr: number | null,
  comp: CompetitorRow,
  contentFit: number | null,
  serpPen: number,
): number | null {
  const useLps = clientLps != null && comp.lps_score != null;
  const useUr = clientUr != null && comp.url_rating != null;
  if (!useLps && !useUr) return null;

  const gap = useLps
    ? ((clientLps as number) - (comp.lps_score as number)) / 100
    : ((clientUr as number) - (comp.url_rating as number)) / 100;
  const authorityGap = clamp(gap, -1, 1);
  const contentEdge = contentFit != null ? clamp(contentFit, 0, 1) : 0.5;
  const raw = sigmoid(3.2 * authorityGap + 1.6 * (contentEdge - 0.5));
  return clamp(raw * (1 - serpPen), 0, 1);
}

export const HAR_V2_CONFIDENCE_PENALTIES = {
  no_lps_run: 0.35,
  no_client_lps_row: 0.15,
  synthetic_client_lps: 0.05,
  missing_client_authority: 0.10,
  missing_content_fit: 0.10,
  sparse_serp: 0.10,
  stretch_no_lps_extra: 0.10,
} as const;

function computeConfidence(
  inp: CompositeInputs,
  s: Scenario,
  serpRowCount: number,
  cfg?: ScoringConfig,
): number {
  let c = 1.0;
  const P = HAR_V2_CONFIDENCE_PENALTIES;
  if (!inp.latest_lps_run_exists) c -= P.no_lps_run;
  else if (!inp.has_client_lps_row) c -= P.no_client_lps_row;
  else if (inp.client_lps_source === "synthetic_client_domain") c -= P.synthetic_client_lps;
  if (!inp.has_client_authority) c -= P.missing_client_authority;
  if (inp.content_fit_score == null) c -= P.missing_content_fit;
  if (serpRowCount < 5) c -= P.sparse_serp;
  // Stretch scenarios computed without any LPS coverage are inherently softer.
  if (s === "stretch" && !inp.latest_lps_run_exists) c -= P.stretch_no_lps_extra;
  // When a config is provided, its min_confidence acts as the lower clamp;
  // otherwise fall back to the historical 0.05 floor (regression guard for
  // callers that haven't been wired to the config yet).
  const floor = cfg && typeof cfg.min_confidence === "number" && Number.isFinite(cfg.min_confidence)
    ? clamp(cfg.min_confidence, 0, 1)
    : DEFAULT_MIN_CONFIDENCE_FALLBACK;
  return clamp(c, floor, 1.0);
}

/**
 * Canonical URL normaliser used to match keyword ranking URLs against
 * SERP-derived LPS rows. Lowercases host, strips `www.` and trailing slash,
 * drops fragments, keeps path + query. Returns null for empty/non-http(s).
 */
const TRACKING_QUERY_KEYS = new Set([
  "srsltid",
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
]);

export function canonicalUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  // Path: collapse duplicate slashes, strip single trailing slash unless root.
  let path = (parsed.pathname || "/").replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Query: drop known tracking params + anything starting with utm_, sort remainder for stability.
  const keep: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (TRACKING_QUERY_KEYS.has(lk)) continue;
    if (lk.startsWith("utm_")) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = keep.length
    ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";

  return `${parsed.protocol}//${parsed.hostname}${path}${search}`;
}

/**
 * Resolve a client's absolute ranking URL. `ranking_url` may be:
 * - absolute (`http(s)://…`) — used as-is
 * - path (`/foo/bar`) — prepended with `https://<clientDomain>`
 * - null/empty — returns null
 */
export function resolveClientRankingUrl(
  rankingUrl: string | null | undefined,
  clientDomain: string | null | undefined,
): string | null {
  if (!rankingUrl) return null;
  const raw = String(rankingUrl).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return canonicalUrl(raw);
  if (!clientDomain) return null;
  const host = String(clientDomain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  if (!host) return null;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return canonicalUrl(`https://${host}${path}`);
}

function authorityScore(clientLps: number | null, clientUr: number | null, competitors: CompetitorRow[]): number | null {
  const compVals = competitors
    .map((c) => (c.lps_score != null ? c.lps_score : c.url_rating != null ? c.url_rating : null))
    .filter((v): v is number => v != null);
  const med = median(compVals);
  const client = clientLps ?? clientUr;
  if (med == null || client == null) return null;
  // Map into [0,1] using 100-point authority scale.
  return clamp(0.5 + (client - med) / 200, 0, 1);
}

function linkGapScore(clientLps: number | null, competitors: CompetitorRow[]): number | null {
  const compLps = competitors.map((c) => c.lps_score).filter((v): v is number => v != null);
  const med = median(compLps);
  if (med == null || clientLps == null) return null;
  return clamp((med - clientLps) / 100, 0, 1);
}

export function computeScenario(
  inp: CompositeInputs,
  s: Scenario,
  override: OverrideInfo | null,
  cfg?: ScoringConfig,
): ScenarioResult {
  const sortedComps = [...inp.competitors].sort(
    (a, b) => (a.rank_absolute ?? 999) - (b.rank_absolute ?? 999),
  );
  const serpPen = serpPenalty(inp.serp_feature_count, inp.top_serp_feature);
  const temp = scenarioTemperature(s, cfg);
  const threshold = scenarioThreshold(s, cfg);

  // Ladder walk.
  // p_att = probability of reaching har_position or better,
  // estimated as the tempered beat probability of the marginal
  // competitor at that position. Legacy noisy-OR value retained
  // in explanation_json.p_att_legacy for one release cycle.
  let harPosition: number | null = null;
  let rankProb: number | null = null;
  let pAttLegacy: number | null = null;
  const ladderLog: Array<Record<string, unknown>> = [];
  let notBeatenProduct = 1;
  let ladderConsidered = 0;
  let bestPBeat: number | null = null;
  let bestPBeatCompetitor: { rank: number | null; lps: number | null; ur: number | null } | null = null;

  for (const c of sortedComps) {
    // Skip rows with no comparable authority — same principle as Prompt 9.1.
    const raw = pBeat(inp.client_lps, inp.client_ur, c, inp.content_fit_score, serpPen);
    if (raw == null) {
      ladderLog.push({ rank: c.rank_absolute, skipped: "missing_competitor_authority" });
      continue;
    }
    const p = Math.pow(raw, temp);
    ladderConsidered += 1;
    const beaten = p >= threshold;
    if (bestPBeat == null || p > bestPBeat) {
      bestPBeat = p;
      bestPBeatCompetitor = { rank: c.rank_absolute ?? null, lps: c.lps_score, ur: c.url_rating };
    }
    ladderLog.push({
      rank: c.rank_absolute,
      competitor_lps: c.lps_score,
      competitor_ur: c.url_rating,
      p_beat_raw: Number(raw.toFixed(4)),
      p_beat: Number(p.toFixed(4)),
      beaten,
    });
    if (beaten) {
      harPosition = c.rank_absolute ?? null;
      rankProb = clamp(p, 0, 1);
      pAttLegacy = clamp(1 - notBeatenProduct * (1 - p), 0, 1);
      break;
    }
    notBeatenProduct *= (1 - p);
  }

  // Observed-rank clamp using base_rank as observed-position proxy.
  let clampedFrom: number | null = null;
  if (harPosition != null && inp.base_rank != null && inp.base_rank > 0) {
    const floor = Math.max(1, Math.round(inp.base_rank * scenarioFloorMultiplier(s, cfg)));
    if (harPosition < floor) {
      clampedFrom = harPosition;
      harPosition = floor;
    }
  }

  let confidence = computeConfidence(inp, s, sortedComps.length, cfg);
  const probFactor = scenarioProbFactor(s, cfg);
  if (rankProb != null) rankProb = clamp(rankProb * probFactor, 0, 1);
  if (pAttLegacy != null) pAttLegacy = clamp(pAttLegacy * probFactor, 0, 1);

  // Override precedence.
  if (override) {
    harPosition = override.har;
    confidence = 1.0;
    rankProb = 1.0;
    pAttLegacy = 1.0;
  }

  const noBeatReason = harPosition == null && !override
    ? {
        threshold: Number(threshold.toFixed(2)),
        best_p_beat: bestPBeat == null ? null : Number(bestPBeat.toFixed(4)),
        best_competitor: bestPBeatCompetitor,
        ladder_considered: ladderConsidered,
        reason: ladderConsidered === 0
          ? "no_comparable_competitors"
          : "authority_below_threshold",
      }
    : null;

  const clientLpsSource: ClientLpsSource = inp.client_lps_source
    ?? (inp.client_lps != null ? "serp_row" : "unavailable");
  const clientLpsMatch: ClientLpsMatch = inp.client_lps_match
    ?? (clientLpsSource === "serp_row"
      ? "ranking_url"
      : clientLpsSource === "synthetic_client_domain"
        ? "synthetic"
        : "unavailable");
  // Derived single-enum view over (source, match). Not new state — strictly
  // computed from the two fields above for reader convenience in dashboards.
  const clientLpsBasis: "serp_row" | "domain_fallback" | "synthetic" | "unavailable" =
    clientLpsSource === "synthetic_client_domain"
      ? "synthetic"
      : clientLpsSource === "serp_row"
        ? (clientLpsMatch === "domain_fallback" ? "domain_fallback" : "serp_row")
        : "unavailable";

  const explanation: Record<string, unknown> = {
    scenario: s,
    inputs: {
      client_lps: inp.client_lps,
      client_lps_source: clientLpsSource,
      client_lps_match: clientLpsMatch,
      client_lps_basis: clientLpsBasis,
      client_resolved_url: inp.client_resolved_url ?? null,
      client_ur: inp.client_ur,
      client_dr: inp.client_dr,
      competitor_count: sortedComps.length,
      content_fit: inp.content_fit_score,
      serp_feature_count: inp.serp_feature_count,
      top_serp_feature: inp.top_serp_feature,
      base_rank: inp.base_rank,
    },

    penalties: { serp: Number(serpPen.toFixed(4)) },
    ladder: ladderLog.slice(0, 20),
    ladder_considered: ladderConsidered,
    clamps: {
      floor_multiplier: scenarioFloorMultiplier(s, cfg),
      raw_har_position: clampedFrom,
      clamped_har_position: clampedFrom != null ? harPosition : null,
    },
    scoring_config: cfg
      ? { config_id: cfg.config_id ?? null, config_version: cfg.config_version ?? null }
      : null,
    no_beat_reason: noBeatReason,
    p_att_legacy: pAttLegacy == null
      ? null
      : { value: Number(pAttLegacy.toFixed(4)), formula: "legacy_noisy_or" },
    missing: [
      !inp.latest_lps_run_exists ? "latest_lps_run" : null,
      !inp.has_client_lps_row ? "client_lps_row" : null,
      inp.client_lps_source === "synthetic_client_domain" ? "client_lps_synthetic" : null,
      !inp.has_client_authority ? "client_authority" : null,
      inp.content_fit_score == null ? "content_fit" : null,
      sortedComps.length < 5 ? "sparse_serp" : null,
    ].filter(Boolean),
    override: override
      ? { source: "v1_manual", v1_har: override.har, v1_forecast_id: override.v1_forecast_id }
      : null,
  };

  return {
    scenario: s,
    har_position: harPosition,
    har_confidence: Number(confidence.toFixed(4)),
    rank_attainment_probability: rankProb == null ? null : Number(rankProb.toFixed(4)),
    authority_score: authorityScore(inp.client_lps, inp.client_ur, sortedComps),
    link_power_score: inp.client_lps,
    link_gap_score: linkGapScore(inp.client_lps, sortedComps),
    content_fit_score: inp.content_fit_score,
    serp_visibility_multiplier: Number((1 - serpPen).toFixed(4)),
    explanation_json: explanation,
  };
}
