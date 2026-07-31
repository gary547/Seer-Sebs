// Link Power Score (LPS) v2 — pure helpers.
// Phase 8 · Prompt 8.1.
//
// Deterministic, side-effect free. No Deno / DB imports. Same functions
// are consumed by `link-power-score-compute` (edge function) and the
// Deno test suite. Do not add Deno-URL imports here.

export const LPS_MODEL_VERSION = "lps_v2.0.0";

/**
 * Validate + lightly normalise a URL for LPS persistence. Returns null when
 * the value is empty, non-http(s), or unparseable. Also returns a bare host
 * (without `www.`) so callers can backfill a missing `domain` column.
 */
export function normUrl(raw: string | null | undefined): { url: string; domain: string } | null {
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
  parsed.hostname = parsed.hostname.toLowerCase();
  const host = parsed.hostname.replace(/^www\./, "");
  if (!host) return null;
  return { url: parsed.toString(), domain: host };
}

export type LpsConfidence = "high" | "medium" | "low";

export const LPS_WEIGHTS = {
  ur: 0.35,
  dr: 0.30,
  rd: 0.20,
  bl: 0.15,
} as const;

export type LpsComponentKey = keyof typeof LPS_WEIGHTS;

export interface SerpRowMetrics {
  keyword_id: string;
  url_rating: number | null;
  domain_rating: number | null;
  referring_domains: number | null;
  backlinks: number | null;
}

export interface ClientDomainRef {
  url_rating: number | null;
  domain_rating: number | null;
  ahrefs_rank: number | null;
  fetched_at: string | null;
  domain: string | null;
}

export interface ContextDivisors {
  perKeywordRd: Map<string, number>;
  perKeywordBl: Map<string, number>;
  projectRd: number;
  projectBl: number;
}

export interface ComputeOptions {
  clientDomain?: string | null;
  clientRef?: ClientDomainRef | null;
}

export interface ComponentDetail {
  raw: number | null;
  score: number | null;         // 0..100 or null when missing
  imputed?: boolean;
  source?: string;
  divisor?: number;
  divisor_source?: "keyword" | "project";
}

export interface LpsResult {
  lps_score: number;
  confidence: LpsConfidence;
  components: Record<LpsComponentKey, ComponentDetail>;
  missing: LpsComponentKey[];
  imputations: Array<{ component: LpsComponentKey; source: string }>;
  reason?: string;
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
function safeNum(n: unknown): number | null {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return null;
  return v;
}

/**
 * Build per-keyword and project-wide log divisors for referring_domains and
 * backlinks. Project fallback uses the p95 so a single wildly-linked
 * competitor row doesn't compress every score toward zero.
 */
export function buildContextDivisors(rows: SerpRowMetrics[]): ContextDivisors {
  const perKwRdMax = new Map<string, number>();
  const perKwBlMax = new Map<string, number>();
  const perKwRdCount = new Map<string, number>();
  const perKwBlCount = new Map<string, number>();
  const allRd: number[] = [];
  const allBl: number[] = [];

  for (const r of rows) {
    const rd = safeNum(r.referring_domains);
    const bl = safeNum(r.backlinks);
    if (rd !== null) {
      perKwRdMax.set(r.keyword_id, Math.max(perKwRdMax.get(r.keyword_id) ?? 0, rd));
      perKwRdCount.set(r.keyword_id, (perKwRdCount.get(r.keyword_id) ?? 0) + 1);
      allRd.push(rd);
    }
    if (bl !== null) {
      perKwBlMax.set(r.keyword_id, Math.max(perKwBlMax.get(r.keyword_id) ?? 0, bl));
      perKwBlCount.set(r.keyword_id, (perKwBlCount.get(r.keyword_id) ?? 0) + 1);
      allBl.push(bl);
    }
  }

  // Drop per-keyword divisor when the keyword has <3 rows with data, so we
  // fall back to the project context instead of comparing a URL to itself.
  const perKeywordRd = new Map<string, number>();
  for (const [k, v] of perKwRdMax) {
    if ((perKwRdCount.get(k) ?? 0) >= 3 && v > 0) perKeywordRd.set(k, v);
  }
  const perKeywordBl = new Map<string, number>();
  for (const [k, v] of perKwBlMax) {
    if ((perKwBlCount.get(k) ?? 0) >= 3 && v > 0) perKeywordBl.set(k, v);
  }

  return {
    perKeywordRd,
    perKeywordBl,
    projectRd: percentile(allRd, 0.95),
    projectBl: percentile(allBl, 0.95),
  };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function logNormalise(raw: number, divisor: number): number {
  if (divisor <= 0) return 0;
  const num = Math.log10(1 + raw);
  const den = Math.log10(1 + divisor);
  if (den <= 0) return 0;
  return clamp((num / den) * 100, 0, 100);
}

/**
 * Compute the LPS 0–100 score for a single SERP result row.
 */
export function computeLpsForRow(
  row: SerpRowMetrics,
  ctx: ContextDivisors,
  opts: ComputeOptions = {},
): LpsResult {
  const components: Record<LpsComponentKey, ComponentDetail> = {
    ur: { raw: null, score: null },
    dr: { raw: null, score: null },
    rd: { raw: null, score: null },
    bl: { raw: null, score: null },
  };
  const imputations: LpsResult["imputations"] = [];

  // ur / dr — linear clamp.
  const ur = safeNum(row.url_rating);
  if (ur !== null) components.ur = { raw: ur, score: clamp(ur, 0, 100) };
  const dr = safeNum(row.domain_rating);
  if (dr !== null) components.dr = { raw: dr, score: clamp(dr, 0, 100) };

  // rd — log-normalised, per-keyword divisor first.
  const rd = safeNum(row.referring_domains);
  if (rd !== null) {
    const kwDiv = ctx.perKeywordRd.get(row.keyword_id);
    const useKw = kwDiv !== undefined && kwDiv > 0;
    const divisor = useKw ? kwDiv! : ctx.projectRd;
    components.rd = {
      raw: rd,
      score: divisor > 0 ? logNormalise(rd, divisor) : 0,
      divisor,
      divisor_source: useKw ? "keyword" : "project",
    };
  }

  // bl — same treatment.
  const bl = safeNum(row.backlinks);
  if (bl !== null) {
    const kwDiv = ctx.perKeywordBl.get(row.keyword_id);
    const useKw = kwDiv !== undefined && kwDiv > 0;
    const divisor = useKw ? kwDiv! : ctx.projectBl;
    components.bl = {
      raw: bl,
      score: divisor > 0 ? logNormalise(bl, divisor) : 0,
      divisor,
      divisor_source: useKw ? "keyword" : "project",
    };
  }

  // Client-domain imputation (ur/dr only — client_domain_metrics has no rd/bl).
  const clientDomain = (opts.clientDomain ?? "").toLowerCase();
  const rowDomain = null; // caller-side match; imputation gated by explicit clientRef presence
  if (opts.clientRef && clientDomain && opts.clientRef.domain &&
      opts.clientRef.domain.toLowerCase() === clientDomain) {
    if (components.ur.score === null) {
      const v = safeNum(opts.clientRef.url_rating);
      if (v !== null) {
        components.ur = { raw: v, score: clamp(v, 0, 100), imputed: true, source: "client_domain_metrics" };
        imputations.push({ component: "ur", source: "client_domain_metrics" });
      }
    }
    if (components.dr.score === null) {
      const v = safeNum(opts.clientRef.domain_rating);
      if (v !== null) {
        components.dr = { raw: v, score: clamp(v, 0, 100), imputed: true, source: "client_domain_metrics" };
        imputations.push({ component: "dr", source: "client_domain_metrics" });
      }
    }
  }
  void rowDomain;

  // Blend.
  const keys: LpsComponentKey[] = ["ur", "dr", "rd", "bl"];
  const missing: LpsComponentKey[] = [];
  let num = 0;
  let den = 0;
  for (const k of keys) {
    const c = components[k];
    if (c.score === null || !isFiniteNum(c.score)) {
      missing.push(k);
      continue;
    }
    num += c.score * LPS_WEIGHTS[k];
    den += LPS_WEIGHTS[k];
  }

  const presentCount = keys.length - missing.length;
  let confidence: LpsConfidence;
  if (presentCount >= 4) confidence = "high";
  else if (presentCount >= 2) confidence = "medium";
  else confidence = "low";
  if (imputations.length > 0) {
    confidence = confidence === "high" ? "medium" : confidence === "medium" ? "low" : "low";
  }

  const lps = den > 0 ? Math.round((num / den) * 100) / 100 : 0;

  return {
    lps_score: lps,
    confidence,
    components,
    missing,
    imputations,
    reason: presentCount === 0 ? "no_metrics" : undefined,
  };
}

export function scoreDistribution(scores: number[]): {
  p10: number; p50: number; p90: number; mean: number;
} {
  if (scores.length === 0) return { p10: 0, p50: 0, p90: 0, mean: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  const q = (p: number) => sorted[clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    p10: Number(q(0.1).toFixed(2)),
    p50: Number(q(0.5).toFixed(2)),
    p90: Number(q(0.9).toFixed(2)),
    mean: Number(mean.toFixed(2)),
  };
}
