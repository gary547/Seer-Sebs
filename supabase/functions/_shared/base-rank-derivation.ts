// Pure derivation module for keywords.base_rank / keywords.ranking_url.
//
// Rule (see plan §3):
//  - If the client host appears in the latest serp_results snapshot for the
//    keyword, prefer that row's rank_absolute + url. Vintage = snapshot's
//    fetched_at. Source = 'serp_results'.
//  - If absent from the snapshot but an existing DFS Labs value is newer than
//    the snapshot, keep the Labs value untouched.
//  - If absent from the snapshot and existing value came from DFS Labs (older
//    or same age), preserve base_rank / ranking_url and stamp source='dfs_labs'.
//    Never null out an existing rank.
//  - Never overwrite a fresher serp_results-derived value with an older Labs
//    value — compare timestamps.
//
// The client-domain match uses the same normalisation as `public.normalize_domain`
// and `src/lib/domain.ts`: lowercase; strip scheme, leading `www.`, and path/query/hash.
// Subdomain policy: exact host match after `www.` stripping. Other subdomains
// (`help.ao.com`, `international.ao.com`) do NOT count as the client.

export type BaseRankSource = "serp_results" | "dfs_labs";

export type SerpRow = {
  rank_absolute: number | null;
  url: string | null;
  domain: string | null;
  fetched_at: string | null; // ISO
};

export type ExistingKeyword = {
  base_rank: number | null;
  ranking_url: string | null;
  base_rank_source: BaseRankSource | null;
  base_rank_checked_at: string | null; // ISO
  ranking_lookup_checked_at: string | null; // ISO — legacy DFS Labs vintage
};

export type DerivationResult = {
  base_rank: number | null;
  ranking_url: string | null;
  base_rank_source: BaseRankSource | null;
  base_rank_checked_at: string | null;
  action: "serp_hit" | "dfs_kept_fresher" | "dfs_stamped" | "unchanged" | "noop";
};

/** Canonicalise a domain string. Byte-for-byte parity with public.normalize_domain. */
export function normalizeHost(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const canonical = trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\s+/g, "");
  return canonical.length ? canonical : null;
}

/** Extract normalised host from a full URL, path-only, or bare-host string. */
export function hostFromUrl(input: string | null | undefined): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  // If it looks like a scheme-qualified URL, use URL(); else treat as bare host.
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      return normalizeHost(u.hostname);
    }
  } catch {
    // fall through to normalizeHost
  }
  return normalizeHost(raw);
}

/** Pick the client-matching row with the lowest rank_absolute. */
function pickClientRow(clientHost: string, rows: SerpRow[]): SerpRow | null {
  let best: SerpRow | null = null;
  for (const r of rows) {
    if (r.rank_absolute == null) continue;
    const host = hostFromUrl(r.url) ?? normalizeHost(r.domain);
    if (host !== clientHost) continue;
    if (best == null || (r.rank_absolute as number) < (best.rank_absolute as number)) {
      best = r;
    }
  }
  return best;
}

/** Newer of two ISO timestamps wins; null loses. */
function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}

/**
 * Apply the derivation rule for one keyword. `serpRows` is every serp_results
 * row for the keyword from the latest snapshot (same fetched_at bucket) —
 * pass in top-20 rows for that keyword.
 */
export function deriveBaseRank(
  clientDomain: string | null | undefined,
  serpRows: SerpRow[],
  existing: ExistingKeyword,
): DerivationResult {
  const clientHost = normalizeHost(clientDomain);
  if (!clientHost) {
    return {
      base_rank: existing.base_rank,
      ranking_url: existing.ranking_url,
      base_rank_source: existing.base_rank_source,
      base_rank_checked_at: existing.base_rank_checked_at,
      action: "noop",
    };
  }

  const hit = pickClientRow(clientHost, serpRows);
  const snapshotAt = hit?.fetched_at ?? null;

  // Existing DFS Labs vintage: prefer explicit base_rank_checked_at (new column)
  // and fall back to legacy ranking_lookup_checked_at for pre-migration rows.
  const existingVintage = existing.base_rank_checked_at ?? existing.ranking_lookup_checked_at;

  if (hit && snapshotAt) {
    // Snapshot claim — accept unless we already have a strictly newer value.
    if (existing.base_rank_source === "serp_results" && isNewer(existing.base_rank_checked_at, snapshotAt)) {
      return {
        base_rank: existing.base_rank,
        ranking_url: existing.ranking_url,
        base_rank_source: "serp_results",
        base_rank_checked_at: existing.base_rank_checked_at,
        action: "unchanged",
      };
    }
    if (existing.base_rank_source === "dfs_labs" && isNewer(existingVintage, snapshotAt)) {
      // A Labs lookup done AFTER this snapshot wins — preserve Labs.
      return {
        base_rank: existing.base_rank,
        ranking_url: existing.ranking_url,
        base_rank_source: "dfs_labs",
        base_rank_checked_at: existingVintage,
        action: "dfs_kept_fresher",
      };
    }
    return {
      base_rank: hit.rank_absolute,
      ranking_url: hit.url,
      base_rank_source: "serp_results",
      base_rank_checked_at: snapshotAt,
      action: "serp_hit",
    };
  }

  // No snapshot hit — never null out an existing rank. Preserve Labs value if any.
  if (existing.base_rank != null) {
    return {
      base_rank: existing.base_rank,
      ranking_url: existing.ranking_url,
      base_rank_source: existing.base_rank_source ?? "dfs_labs",
      base_rank_checked_at: existing.base_rank_checked_at ?? existing.ranking_lookup_checked_at,
      action: existing.base_rank_source ? "unchanged" : "dfs_stamped",
    };
  }

  return {
    base_rank: null,
    ranking_url: existing.ranking_url,
    base_rank_source: existing.base_rank_source,
    base_rank_checked_at: existing.base_rank_checked_at,
    action: "noop",
  };
}
