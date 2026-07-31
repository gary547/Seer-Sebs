// Form-based keyword clustering — normalisation pipeline.
//
// Goal: collapse close surface-form variants of the same demand pool
// (e.g. "32 in tv", "32in tv", "tv 32 inch", "32 inch television") to a
// single cluster_key while KEEPING semantically distinct pairs apart (the
// seven false-positive pairs recorded in
// docs/local-cluster-derivation-diagnostic-2026-07-20.md §2).
//
// Deterministic and idempotent: normaliseKeyword(normaliseKeyword(x)) === normaliseKeyword(x).

const SIZE_TOKEN_RE = /([0-9]+)(inches|inch|in)\b/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;

function foldToken(t: string): string {
  if (t === "in" || t === "inch" || t === "inches") return "inch";
  if (t === "television" || t === "televisions") return "tv";
  return t;
}

export function normaliseKeyword(input: string): string {
  if (input == null) return "";
  let s = String(input).toLowerCase();

  // 1. Split glued size tokens: "32inch" -> "32 inch", "55in" -> "55 in"
  s = s.replace(SIZE_TOKEN_RE, "$1 $2");

  // 2. Collapse non-alphanumerics to spaces.
  s = s.replace(NON_ALNUM_RE, " ").trim();
  if (!s) return "";

  // 3. Tokenise, fold synonyms.
  let tokens = s.split(/\s+/).map(foldToken);

  // 4. Drop trailing "s" from the final token when length > 1 (post-fold,
  //    pre-sort — preserves the last-token pluralisation heuristic used in
  //    the FP-pair diagnostic).
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (last.length > 1 && last.endsWith("s")) {
      tokens[tokens.length - 1] = last.slice(0, -1);
    }
  }

  // 5. Alphabetical sort → stable order-independent key.
  tokens = tokens.slice().sort();

  return tokens.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical selection
//
// Canonical = the surface form the client actually ranks for. Base rank drives
// selection because it reflects Google's chosen representative for the
// underlying query (the same reason DFS's own core_keyword is base-rank
// driven). Annual volume and alphabetical order are tie-breaks only.
//
// Rule (evaluated in order):
//   1. lowest base_rank wins (NULL sorts LAST — a keyword with no measured
//      rank must not out-rank a keyword that does)
//   2. highest annual_volume
//   3. alphabetical by keyword (deterministic tie-break)
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonicalMember {
  id: string;
  keyword: string | null;
  base_rank: number | null;
  annual_volume: number;
  /** Aggregated GSC clicks across all query rows collapsing to this member. */
  gsc_clicks?: number | null;
}

export function pickCanonical<T extends CanonicalMember>(members: readonly T[]): T {
  if (members.length === 0) {
    throw new Error("pickCanonical: empty members array");
  }
  const sorted = members.slice().sort((a, b) => {
    const ar = a.base_rank == null || !Number.isFinite(Number(a.base_rank))
      ? Number.POSITIVE_INFINITY : Number(a.base_rank);
    const br = b.base_rank == null || !Number.isFinite(Number(b.base_rank))
      ? Number.POSITIVE_INFINITY : Number(b.base_rank);
    if (ar !== br) return ar - br;
    const av = Number(a.annual_volume ?? 0);
    const bv = Number(b.annual_volume ?? 0);
    if (bv !== av) return bv - av;
    return (a.keyword ?? "").localeCompare(b.keyword ?? "");
  });
  return sorted[0];
}

export type CanonicalBasis = "gsc_clicks" | "volume" | "base_rank" | "alphabetical";

/**
 * GSC-first canonical selection. Ladder (evaluated in order):
 *   1. highest gsc_clicks (>0)           → basis 'gsc_clicks'
 *   2. else highest annual_volume (>0)   → basis 'volume'
 *   3. else lowest non-null base_rank    → basis 'base_rank'
 *   4. else alphabetical by keyword      → basis 'alphabetical'
 *
 * GSC clicks lead because they measure the surface form users actually click.
 * Volume, rank and alphabetical remain as deterministic fallbacks for clusters
 * with no GSC evidence in the project's latest upload.
 */
export function pickCanonicalWithBasis<T extends CanonicalMember>(
  members: readonly T[],
): { member: T; basis: CanonicalBasis } {
  if (members.length === 0) {
    throw new Error("pickCanonicalWithBasis: empty members array");
  }
  const clicks = (m: T) => {
    const v = Number(m.gsc_clicks ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const maxClicks = Math.max(...members.map(clicks));
  if (maxClicks > 0) {
    const pool = members.filter((m) => clicks(m) === maxClicks);
    // Tie-break within GSC-clicks winners by the existing rank-first rule for
    // determinism.
    return { member: pickCanonical(pool), basis: "gsc_clicks" };
  }

  const vol = (m: T) => {
    const v = Number(m.annual_volume ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const maxVol = Math.max(...members.map(vol));
  if (maxVol > 0) {
    const pool = members.filter((m) => vol(m) === maxVol);
    return { member: pickCanonical(pool), basis: "volume" };
  }

  const hasRank = members.some(
    (m) => m.base_rank != null && Number.isFinite(Number(m.base_rank)),
  );
  if (hasRank) {
    return { member: pickCanonical(members), basis: "base_rank" };
  }

  const sorted = members.slice().sort((a, b) =>
    (a.keyword ?? "").localeCompare(b.keyword ?? ""),
  );
  return { member: sorted[0], basis: "alphabetical" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact-form normaliser
//
// Used ONLY for per-member GSC-clicks attribution. Lower-cases, collapses
// whitespace, trims. No token folding / size splitting / sort — so distinct
// surface forms within a cluster keep distinct exact keys. This is what makes
// the canonical picker's gsc_clicks tier actually differentiate members.
// ─────────────────────────────────────────────────────────────────────────────

export function normaliseExactForm(input: string | null | undefined): string {
  if (input == null) return "";
  return String(input).toLowerCase().replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster-level property derivation
//
// Given all members of a cluster, produce demand/rank/URL properties that
// describe the whole cluster and are identical on every member row. These are
// independent of which member is picked canonical.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterPropertyMember {
  id: string;
  keyword: string | null;
  base_rank: number | null;
  annual_volume: number;
  ranking_url?: string | null;
}

export interface ClusterProperties {
  cluster_volume_annual: number | null;
  cluster_base_rank: number | null;
  cluster_base_rank_keyword_id: string | null;
  cluster_ranking_url: string | null;
  cluster_url_conflict: boolean;
}

export function computeClusterProperties<T extends ClusterPropertyMember>(
  members: readonly T[],
): ClusterProperties {
  if (members.length === 0) {
    return {
      cluster_volume_annual: null,
      cluster_base_rank: null,
      cluster_base_rank_keyword_id: null,
      cluster_ranking_url: null,
      cluster_url_conflict: false,
    };
  }

  // MAX annual volume across members.
  let maxVol: number | null = null;
  for (const m of members) {
    const v = Number(m.annual_volume ?? 0);
    if (!Number.isFinite(v)) continue;
    if (maxVol == null || v > maxVol) maxVol = v;
  }

  // MIN non-null base_rank; tie-break: highest annual_volume DESC, then keyword ASC.
  const ranked = members
    .filter((m) => m.base_rank != null && Number.isFinite(Number(m.base_rank)))
    .slice()
    .sort((a, b) => {
      const ar = Number(a.base_rank);
      const br = Number(b.base_rank);
      if (ar !== br) return ar - br;
      const av = Number(a.annual_volume ?? 0);
      const bv = Number(b.annual_volume ?? 0);
      if (bv !== av) return bv - av;
      return (a.keyword ?? "").localeCompare(b.keyword ?? "");
    });
  const rankPick = ranked[0] ?? null;

  // Modal non-null ranking_url; tie-break by keyword ASC among URLs whose
  // representative member sorts earliest.
  const urlCounts = new Map<string, number>();
  const urlFirstKeyword = new Map<string, string>();
  for (const m of members) {
    const u = m.ranking_url;
    if (u == null || u === "") continue;
    urlCounts.set(u, (urlCounts.get(u) ?? 0) + 1);
    const kw = m.keyword ?? "";
    const cur = urlFirstKeyword.get(u);
    if (cur == null || kw.localeCompare(cur) < 0) urlFirstKeyword.set(u, kw);
  }
  let modeUrl: string | null = null;
  if (urlCounts.size > 0) {
    const entries = Array.from(urlCounts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ka = urlFirstKeyword.get(a[0]) ?? "";
      const kb = urlFirstKeyword.get(b[0]) ?? "";
      return ka.localeCompare(kb);
    });
    modeUrl = entries[0][0];
  }

  return {
    cluster_volume_annual: maxVol,
    cluster_base_rank: rankPick ? Number(rankPick.base_rank) : null,
    cluster_base_rank_keyword_id: rankPick ? rankPick.id : null,
    cluster_ranking_url: modeUrl,
    cluster_url_conflict: urlCounts.size >= 2,
  };
}
