// Pure helpers for the LPS Authority Backfill edge function.
// Deterministic, side-effect free. No Deno / DB imports.

export const LPS_BACKFILL_MODEL_VERSION = "lps_authority_backfill_v1";

// Batch sizes tuned to match the HAR pipeline that already talks to the same
// APIs. Ahrefs batch-analysis and DataForSEO bulk endpoints both accept ~100
// targets per call comfortably.
export const AHREFS_BATCH_SIZE = 100;
export const DFS_BATCH_SIZE = 100;
export const DB_UPSERT_CHUNK = 500;
export const DEFAULT_LIMIT_URLS = 5000;
export const DEFAULT_REFRESH_STALE_DAYS = 90;
export const REQUEST_PARALLELISM = 3;

export interface SerpRowLite {
  id: string;
  url: string | null;
  domain: string | null;
  url_rating: number | null;
  domain_rating?: number | null;
  referring_domains: number | null;
  backlinks?: number | null;
  fetched_at: string | null;
}

export interface UrlCandidate {
  url: string;               // normalised form used as the API target
  domain: string | null;     // normalised domain fallback target
  ids: string[];             // serp_results.id rows that share this URL
  hadUr: boolean;            // any row already has UR/DR
  hadDr: boolean;
  hadRd: boolean;            // any row already has RD/BL
  hadBl: boolean;
  freshest: string | null;   // max(fetched_at) across those rows, ISO
}

export interface CoverageStats {
  total: number;
  with_ur: number;
  with_dr: number;
  with_rd: number;
  with_bl: number;
  pct_ur: number;
  pct_dr: number;
  pct_rd: number;
  pct_bl: number;
}

export interface DfsAuthorityMetrics {
  referring_domains: number | null;
  backlinks: number | null;
  source: "url" | "domain";
  matched_target?: string;
}

export interface DfsParseDiagnostics {
  source: "url" | "domain";
  requested: number;
  rd_status_code: number | null;
  rd_status_message: string | null;
  bl_status_code: number | null;
  bl_status_message: string | null;
  rd_items_count: number;
  bl_items_count: number;
  rd_matched: number;
  bl_matched: number;
  no_data_targets: number;
  unmatched_returned_targets: string[];
  sample_returned_targets: string[];
  ok: boolean;
}

export interface DfsParseResult {
  values: Map<string, DfsAuthorityMetrics>;
  diagnostics: DfsParseDiagnostics;
}

export interface AhrefsAuthorityMetrics {
  url_rating: number | null;
  domain_rating: number | null;
  ahrefs_rank: number | null;
  referring_domains: number | null;
  backlinks: number | null;
  matched_target?: string;
}

export interface AhrefsParseDiagnostics {
  requested: number;
  returned: number;
  matched: number;
  ur_matched: number;
  dr_matched: number;
  rd_matched: number;
  bl_matched: number;
  no_data_targets: number;
  unmatched_returned_targets: string[];
  sample_returned_targets: string[];
}

export interface AhrefsParseResult {
  values: Map<string, AhrefsAuthorityMetrics>;
  diagnostics: AhrefsParseDiagnostics;
}

/**
 * Normalise a raw URL string for use as an Ahrefs / DataForSEO target and as
 * a dedup key. Strips fragments and common tracking params. Returns null when
 * the input is unusable.
 */
export function normaliseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    const hasHttpScheme = /^https?:\/\//i.test(trimmed);
    const hasOtherScheme = !hasHttpScheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    if (hasOtherScheme) return null;
    u = new URL(hasHttpScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  // Strip common tracking params so different-tagged URLs collapse.
  const drop = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "hsCtaTracking",
  ];
  for (const k of drop) u.searchParams.delete(k);
  // Force lower-case host, keep path/query case (URLs are case-sensitive on path).
  u.hostname = u.hostname.toLowerCase();
  if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
  // Drop trailing slash on bare hosts for consistency.
  let out = u.toString();
  if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
  return out;
}

export function normaliseDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return s || null;
}

function finiteNonNegativeNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function ahrefsTargetKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const trimmed = String(raw).trim();
  if (trimmed) out.add(trimmed);
  const url = normaliseUrl(trimmed);
  if (url) {
    out.add(url);
    try {
      const u = new URL(url);
      out.add(`${u.protocol}//${u.hostname}${u.pathname}${u.search}`);
      if (u.pathname === "/" && !u.search) out.add(`https://${u.hostname}`);
    } catch {
      // ignored: normaliseUrl already validates URL-ish inputs
    }
  }
  const domain = normaliseDomain(trimmed);
  if (domain) {
    out.add(domain);
    out.add(`https://${domain}`);
  }
  return Array.from(out);
}

/**
 * Parse Ahrefs Batch Analysis rows. Ahrefs can return the full authority set
 * LPS needs: URL Rating, Domain Rating, Ahrefs Rank, refdomains, backlinks.
 * Prefer the echoed URL for matching, but fall back to response order because
 * the endpoint returns one row per submitted target in order.
 */
export function parseAhrefsAuthorityBatch(
  targets: string[],
  body: unknown,
): AhrefsParseResult {
  const targetByKey = new Map<string, string>();
  for (const target of targets) {
    for (const key of ahrefsTargetKeys(target)) targetByKey.set(key, target);
  }

  const values = new Map<string, AhrefsAuthorityMetrics>();
  const rowsRaw = (body as { targets?: unknown[] } | null)?.targets;
  const rows = Array.isArray(rowsRaw)
    ? rowsRaw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
  const unmatched = new Set<string>();
  const returned = new Set<string>();
  let matched = 0, urMatched = 0, drMatched = 0, rdMatched = 0, blMatched = 0;

  const resolveTarget = (row: Record<string, unknown>, idx: number): string | null => {
    const providerUrl = typeof row.url === "string" ? row.url : typeof row.target === "string" ? row.target : "";
    if (providerUrl) {
      returned.add(providerUrl);
      for (const key of ahrefsTargetKeys(providerUrl)) {
        const target = targetByKey.get(key);
        if (target) return target;
      }
      unmatched.add(providerUrl);
    }
    return targets[idx] ?? null;
  };

  rows.forEach((row, idx) => {
    const target = resolveTarget(row, idx);
    if (!target) return;
    const metrics: AhrefsAuthorityMetrics = {
      url_rating: finiteNonNegativeNumber(row.url_rating),
      domain_rating: finiteNonNegativeNumber(row.domain_rating),
      ahrefs_rank: finiteNonNegativeNumber(row.ahrefs_rank),
      referring_domains: finiteNonNegativeNumber(row.refdomains ?? row.referring_domains),
      backlinks: finiteNonNegativeNumber(row.backlinks),
      matched_target: String(row.url ?? row.target ?? target),
    };
    values.set(target, metrics);
    matched += 1;
    if (metrics.url_rating !== null) urMatched += 1;
    if (metrics.domain_rating !== null) drMatched += 1;
    if (metrics.referring_domains !== null) rdMatched += 1;
    if (metrics.backlinks !== null) blMatched += 1;
  });

  let noDataTargets = 0;
  for (const target of targets) {
    const v = values.get(target);
    if (!v || (v.url_rating === null && v.domain_rating === null && v.referring_domains === null && v.backlinks === null)) {
      noDataTargets += 1;
    }
  }

  return {
    values,
    diagnostics: {
      requested: targets.length,
      returned: rows.length,
      matched,
      ur_matched: urMatched,
      dr_matched: drMatched,
      rd_matched: rdMatched,
      bl_matched: blMatched,
      no_data_targets: noDataTargets,
      unmatched_returned_targets: Array.from(unmatched).slice(0, 10),
      sample_returned_targets: Array.from(returned).slice(0, 10),
    },
  };
}

function dfsTask(data: unknown): Record<string, unknown> | null {
  const d = data as { tasks?: unknown[] } | null;
  const task = Array.isArray(d?.tasks) ? d?.tasks?.[0] : null;
  return task && typeof task === "object" ? task as Record<string, unknown> : null;
}

function dfsStatus(data: unknown): { code: number | null; message: string | null; ok: boolean; noData: boolean } {
  const task = dfsTask(data);
  const root = data as { status_code?: unknown; status_message?: unknown } | null;
  const rawCode = task?.status_code ?? root?.status_code ?? null;
  const code = rawCode === null || rawCode === undefined ? null : Number(rawCode);
  const message = String(task?.status_message ?? root?.status_message ?? "") || null;
  return {
    code: Number.isFinite(code) ? code : null,
    message,
    ok: code === 20000,
    noData: code === 40204,
  };
}

function dfsItems(data: unknown): Array<Record<string, unknown>> {
  const task = dfsTask(data) as { result?: unknown[] } | null;
  const result0 = Array.isArray(task?.result) ? task?.result?.[0] as { items?: unknown[] } | undefined : undefined;
  const items = Array.isArray(result0?.items) ? result0.items : [];
  return items.filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
}

export function dfsTargetKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const trimmed = String(raw).trim();
  if (trimmed) out.add(trimmed);
  const url = normaliseUrl(trimmed);
  if (url) {
    out.add(url);
    try {
      const u = new URL(url);
      out.add(`${u.protocol}//${u.hostname}${u.pathname}${u.search}`);
      if (u.pathname === "/" && !u.search) out.add(u.hostname);
    } catch {
      // ignored: normaliseUrl already validates URL-ish inputs
    }
  }
  const domain = normaliseDomain(trimmed);
  if (domain) out.add(domain);
  return Array.from(out);
}

/**
 * Parse paired DataForSEO bulk RD/BL responses and match provider-returned
 * target strings back to the exact request targets, even when DataForSEO
 * canonicalises www/scheme/trailing-slash variants.
 */
export function parseDfsAuthorityBatch(
  targets: string[],
  refData: unknown,
  blData: unknown,
  source: "url" | "domain" = "url",
): DfsParseResult {
  const targetByKey = new Map<string, string>();
  for (const target of targets) {
    for (const key of dfsTargetKeys(target)) targetByKey.set(key, target);
  }

  const values = new Map<string, DfsAuthorityMetrics>();
  for (const t of targets) values.set(t, { referring_domains: null, backlinks: null, source });

  const refStatus = dfsStatus(refData);
  const blStatus = dfsStatus(blData);
  const refItems = refStatus.ok ? dfsItems(refData) : [];
  const blItems = blStatus.ok ? dfsItems(blData) : [];
  const unmatched = new Set<string>();
  const returned = new Set<string>();
  let rdMatched = 0;
  let blMatched = 0;

  const resolveTarget = (providerTarget: unknown): string | null => {
    const raw = typeof providerTarget === "string" ? providerTarget : String(providerTarget ?? "");
    if (raw) returned.add(raw);
    for (const key of dfsTargetKeys(raw)) {
      const target = targetByKey.get(key);
      if (target) return target;
    }
    if (raw) unmatched.add(raw);
    return null;
  };

  for (const item of refItems) {
    const target = resolveTarget(item.target);
    if (!target) continue;
    const value = finiteNonNegativeNumber(item.referring_domains);
    if (value !== null) {
      const cur = values.get(target) ?? { referring_domains: null, backlinks: null, source };
      cur.referring_domains = value;
      cur.matched_target = String(item.target ?? target);
      values.set(target, cur);
      rdMatched += 1;
    }
  }

  for (const item of blItems) {
    const target = resolveTarget(item.target);
    if (!target) continue;
    const value = finiteNonNegativeNumber(item.backlinks);
    if (value !== null) {
      const cur = values.get(target) ?? { referring_domains: null, backlinks: null, source };
      cur.backlinks = value;
      cur.matched_target = String(item.target ?? target);
      values.set(target, cur);
      blMatched += 1;
    }
  }

  let noDataTargets = 0;
  for (const v of values.values()) {
    if (v.referring_domains === null && v.backlinks === null) noDataTargets += 1;
  }

  return {
    values,
    diagnostics: {
      source,
      requested: targets.length,
      rd_status_code: refStatus.code,
      rd_status_message: refStatus.message,
      bl_status_code: blStatus.code,
      bl_status_message: blStatus.message,
      rd_items_count: refItems.length,
      bl_items_count: blItems.length,
      rd_matched: rdMatched,
      bl_matched: blMatched,
      no_data_targets: noDataTargets,
      unmatched_returned_targets: Array.from(unmatched).slice(0, 10),
      sample_returned_targets: Array.from(returned).slice(0, 10),
      ok: (refStatus.ok || refStatus.noData) && (blStatus.ok || blStatus.noData),
    },
  };
}

/**
 * Build the ordered list of URL candidates to backfill for a project.
 * - Dedup by normalised URL.
 * - Aggregate serp_results.id per URL so a single API result updates every
 *   row for the same URL.
 * - Compute the freshest existing `fetched_at` so the caller can gate on
 *   `refresh_stale_days`.
 */
export function buildUrlCandidates(rows: SerpRowLite[]): UrlCandidate[] {
  const map = new Map<string, UrlCandidate>();
  for (const r of rows) {
    const url = normaliseUrl(r.url);
    if (!url) continue;
    const domain = normaliseDomain(r.domain) ?? normaliseDomain(url);
    const cur = map.get(url);
    const hadUr = r.url_rating !== null && r.url_rating !== undefined;
    const hadDr = r.domain_rating !== null && r.domain_rating !== undefined;
    const hadRd = r.referring_domains !== null && r.referring_domains !== undefined;
    const hadBl = r.backlinks !== null && r.backlinks !== undefined;
    const fetched = r.fetched_at ?? null;
    if (!cur) {
      map.set(url, {
        url,
        domain,
        ids: [r.id],
        hadUr,
        hadDr,
        hadRd,
        hadBl,
        freshest: fetched,
      });
    } else {
      cur.ids.push(r.id);
      cur.hadUr = cur.hadUr || hadUr;
      cur.hadDr = cur.hadDr || hadDr;
      cur.hadRd = cur.hadRd || hadRd;
      cur.hadBl = cur.hadBl || hadBl;
      if (!cur.domain && domain) cur.domain = domain;
      if (fetched && (!cur.freshest || fetched > cur.freshest)) cur.freshest = fetched;
    }
  }
  return Array.from(map.values());
}

/**
 * Filter candidates that still need enrichment given a staleness window.
 * A candidate is "needed" when it is missing UR (or RD) OR its freshest data
 * is older than the staleness cutoff.
 */
export function filterCandidatesToFetch(
  candidates: UrlCandidate[],
  refreshStaleDays: number,
  nowIso: string,
): UrlCandidate[] {
  const cutoff = new Date(nowIso);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(0, refreshStaleDays));
  const cutoffIso = cutoff.toISOString();
  const out: UrlCandidate[] = [];
  for (const c of candidates) {
    const missing = !c.hadUr || !c.hadDr || !c.hadRd || !c.hadBl;
    const stale = c.freshest ? c.freshest < cutoffIso : true;
    if (missing || stale) out.push(c);
  }
  return out;
}

export function coverageOf(rows: SerpRowLite[]): CoverageStats {
  const total = rows.length;
  let ur = 0, dr = 0, rd = 0, bl = 0;
  for (const r of rows) {
    if (r.url_rating !== null && r.url_rating !== undefined) ur += 1;
    if (r.domain_rating !== null && r.domain_rating !== undefined) dr += 1;
    if (r.referring_domains !== null && r.referring_domains !== undefined) rd += 1;
    if (r.backlinks !== null && r.backlinks !== undefined) bl += 1;
  }
  const pct = (n: number) => total > 0 ? Number((n / total).toFixed(4)) : 0;
  return {
    total,
    with_ur: ur,
    with_dr: dr,
    with_rd: rd,
    with_bl: bl,
    pct_ur: pct(ur),
    pct_dr: pct(dr),
    pct_rd: pct(rd),
    pct_bl: pct(bl),
  };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bounded concurrency runner. Executes `worker(item)` for every item with at
 * most `limit` in-flight promises. Errors propagate; callers handle failure.
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const n = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await worker(items[idx]);
      }
    })());
  }
  await Promise.all(workers);
}
