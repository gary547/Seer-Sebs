// Shared DataForSEO auth helper.
//
// Behaviourally identical to the inline `buildBasicAuth` used in
// `keyword-enrichment/index.ts` (and duplicated in ctr-benchmark,
// ranking-url-lookup, content-plan-generate, gsc-intent-enrichment).
//
// Contract:
// - If the secret contains ":", treat it as raw "login:password" and
//   base64-encode it.
// - Otherwise, treat it as an already-base64 token and return it unchanged.
// - Callers set the Authorization header as `Basic ${result}`.
// - Never log the secret or the return value.
export function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret);
  return secret;
}

// Google Ads finalises search-volume data on a lag of roughly 4-6 weeks.
// Empirically, DataForSEO's Standard Google Ads Search Volume endpoint has
// finalised data through `current_month - GOOGLE_ADS_LAG_MONTHS`, so any
// window whose `date_to` extends past that will be trimmed by DataForSEO
// server-side. Used as the fallback ceiling when the Status endpoint cannot
// be parsed.
export const GOOGLE_ADS_LAG_MONTHS = 2;

// Compute an inclusive month window anchored to UTC month starts.
// Returns ISO YYYY-MM-DD strings for the first day of `date_from`'s month
// through the first day of the effective ceiling month (current UTC month
// minus `GOOGLE_ADS_LAG_MONTHS`).
//
// Contract:
// - `requestedMonths` is clamped to [1, 48].
// - `date_to`   = first day of month `(current UTC month) - GOOGLE_ADS_LAG_MONTHS`.
// - `date_from` = `date_to` minus (clamped requestedMonths - 1) whole months.
// - Used by the DataForSEO backfill/probe to request the standard Google Ads
//   Search Volume Live endpoint's full monthly history window when the
//   Google Ads Status endpoint cannot be read.
export function computeMonthRange(
  requestedMonths: number,
  now: Date = new Date(),
): { date_from: string; date_to: string; requested_months: number } {
  const clamped = Math.max(
    1,
    Math.min(48, Number.isFinite(requestedMonths) ? Math.floor(requestedMonths) : 24),
  );
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  // Apply the Google Ads finalisation lag to the ceiling.
  const totalTo = y * 12 + m - GOOGLE_ADS_LAG_MONTHS;
  const toY = Math.floor(totalTo / 12);
  const toM = ((totalTo % 12) + 12) % 12;
  const totalFrom = totalTo - (clamped - 1);
  const fromY = Math.floor(totalFrom / 12);
  const fromM = ((totalFrom % 12) + 12) % 12;
  const fmt = (yy: number, mm0: number) =>
    `${String(yy).padStart(4, "0")}-${String(mm0 + 1).padStart(2, "0")}-01`;
  return {
    date_from: fmt(fromY, fromM),
    date_to: fmt(toY, toM),
    requested_months: clamped,
  };
}

// Shift a YYYY-MM-01 UTC month-start string back by one month.
// Handles year rollover (2026-01-01 → 2025-12-01).
export function previousMonthStart(monthStart: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(monthStart);
  if (!m) return monthStart;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1; // 1..12 → 0..11
  mo -= 1;
  if (mo < 0) { mo = 11; y -= 1; }
  return `${String(y).padStart(4, "0")}-${String(mo + 1).padStart(2, "0")}-01`;
}

// Recognised field names on a Google Ads Status result row that carry the
// latest available month indicator. Kept broad on purpose — DataForSEO's
// schema has drifted historically (year/month tuple → latest_available_month
// string → nested timestamp). Any string here is checked for either a
// `YYYY-MM` prefix or a full ISO date/timestamp.
const STATUS_MONTH_STRING_KEYS = [
  "latest_available_month",
  "date",
  "last_updated",
  "actual_data_date",
  "date_to",
  "search_volume_last_updated_time",
  "keyword_data_last_updated_time",
  "date_update",
] as const;

// Parse a DataForSEO Google Ads Status latest-finalised-month indicator
// from any of the recognised shapes and return a YYYY-MM-01 UTC month-start,
// or null if none of them are usable. Also traverses one level of nested
// sub-objects (e.g. `google_ads_data`, `search_partners_data`) which
// DataForSEO has used in the past.
export function parseStatusMonth(row: any): string | null {
  if (!row || typeof row !== "object") return null;

  // Primary signal on today's DataForSEO Google Ads Status response.
  const readLastMonthPair = (obj: any): string | null => {
    const y = Number(obj.last_year_in_monthly_searches);
    const m = Number(obj.last_month_in_monthly_searches);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    }
    return null;
  };

  // Legacy {year, month} tuple.
  const readYearMonth = (obj: any): string | null => {
    const y = Number(obj.year);
    const m = Number(obj.month);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    }
    return null;
  };

  const readStrings = (obj: any): string | null => {
    for (const key of STATUS_MONTH_STRING_KEYS) {
      const v = obj[key];
      if (typeof v !== "string") continue;
      const iso = /^(\d{4})-(\d{2})/.exec(v);
      if (iso) return `${iso[1]}-${iso[2]}-01`;
    }
    return null;
  };

  const direct = readLastMonthPair(row) ?? readYearMonth(row) ?? readStrings(row);
  if (direct) return direct;

  // Traverse one level of nested objects.
  for (const key of Object.keys(row)) {
    const child = row[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const nested = readLastMonthPair(child) ?? readYearMonth(child) ?? readStrings(child);
    if (nested) return nested;
  }
  return null;
}

// Bounded snapshot of an arbitrary object, safe to attach to admin
// diagnostics. Truncates strings and skips deep nesting.
function snapshotForDiagnostics(row: any, maxChars = 2000): unknown {
  if (row == null) return null;
  try {
    const seen = new WeakSet();
    const clip = (v: any, depth: number): any => {
      if (v == null || typeof v !== "object") {
        if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
        return v;
      }
      if (depth > 3) return "[…]";
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 8).map((x) => clip(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).slice(0, 24)) out[k] = clip(v[k], depth + 1);
      return out;
    };
    const clipped = clip(row, 0);
    const s = JSON.stringify(clipped);
    if (s.length <= maxChars) return clipped;
    return { _truncated: true, _preview: s.slice(0, maxChars) + "…", _keys: Object.keys(row) };
  } catch {
    return { _keys: Object.keys(row ?? {}) };
  }
}

export type GoogleAdsStatusResult =
  | {
      ok: true;
      actual_data: boolean;
      latest_finalised_month: string; // YYYY-MM-01
      http_status: number | null;
      api_status_code: number | null;
      raw_snapshot: unknown;
    }
  | {
      ok: false;
      reason: string;
      http_status: number | null;
      api_status_code: number | null;
      raw_snapshot: unknown;
    };

// Free DataForSEO endpoint that reports whether the latest available
// Google Ads month is finalised ("actual_data") for a given location/language.
// Never throws; never logs the secret. On any recognisable failure returns
// `{ ok: false, reason }` so callers can fall back gracefully. On both success
// and failure, a bounded snapshot of the matched Status row (or the top-level
// response payload if no row matched) is attached as `raw_snapshot` for
// admin-only diagnosis of schema drift.
export async function fetchGoogleAdsStatus(
  apiKey: string,
  opts: { locationCode: number; languageCode: string; timeoutMs?: number },
): Promise<GoogleAdsStatusResult> {
  const url = "https://api.dataforseo.com/v3/keywords_data/google_ads/status";
  let httpStatus: number | null = null;
  let apiCode: number | null = null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${buildBasicAuth(apiKey)}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    httpStatus = res.status;
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    if (!body) {
      return { ok: false, reason: "non_json_body", http_status: httpStatus, api_status_code: null, raw_snapshot: null };
    }
    apiCode = Number(body?.status_code ?? 0) || null;
    if (apiCode !== 20000) {
      return {
        ok: false,
        reason: `api_status_${apiCode ?? "unknown"}`,
        http_status: httpStatus,
        api_status_code: apiCode,
        raw_snapshot: snapshotForDiagnostics({ status_message: body?.status_message, tasks: body?.tasks }),
      };
    }
    const result: any[] = body?.tasks?.[0]?.result ?? [];
    const match = result.find((r: any) =>
      Number(r?.location_code) === opts.locationCode &&
      String(r?.language_code ?? "").toLowerCase() === opts.languageCode.toLowerCase()
    ) ?? result[0] ?? null;
    if (!match) {
      return { ok: false, reason: "no_matching_status_row", http_status: httpStatus, api_status_code: apiCode, raw_snapshot: snapshotForDiagnostics({ result_len: result.length, first: result[0] ?? null }) };
    }
    const month = parseStatusMonth(match);
    if (!month) {
      const keys = Object.keys(match);
      return { ok: false, reason: `no_recognised_month_field:${keys.slice(0, 12).join(",")}`, http_status: httpStatus, api_status_code: apiCode, raw_snapshot: snapshotForDiagnostics(match) };
    }
    return {
      ok: true,
      actual_data: !!match.actual_data,
      latest_finalised_month: month,
      http_status: httpStatus,
      api_status_code: apiCode,
      raw_snapshot: snapshotForDiagnostics(match),
    };
  } catch (e) {
    return { ok: false, reason: `network_error:${(e as Error).message}`, http_status: httpStatus, api_status_code: apiCode, raw_snapshot: null };
  }
}

// Decide the effective (date_from, date_to) window from a Google Ads Status
// result and the caller's fallback window (typically from computeMonthRange).
// Keeps the requested window length: when date_to shifts, date_from shifts
// back by the same number of whole months.
//
// If Status reports a `date_to` later than the caller's lag-adjusted fallback
// (e.g. a transient Status blip claiming a month DataForSEO Search Volume
// has not actually finalised), the effective `date_to` is capped at the
// fallback and the source is suffixed with `_capped`.
export function resolveStatusDrivenDateTo(
  status: GoogleAdsStatusResult,
  fallback: { date_from: string; date_to: string },
): {
  date_from: string;
  date_to: string;
  source:
    | "status_actual"
    | "status_previous_finalised"
    | "status_actual_capped"
    | "status_previous_finalised_capped"
    | "fallback_computed";
  warning?: string;
} {
  const fromParts = /^(\d{4})-(\d{2})-01$/.exec(fallback.date_from);
  const toParts = /^(\d{4})-(\d{2})-01$/.exec(fallback.date_to);
  const monthDiff = (a: string, b: string) => {
    const A = /^(\d{4})-(\d{2})-01$/.exec(a)!;
    const B = /^(\d{4})-(\d{2})-01$/.exec(b)!;
    return (Number(A[1]) * 12 + Number(A[2])) - (Number(B[1]) * 12 + Number(B[2]));
  };
  const shiftFromBy = (delta: number): string => {
    if (!fromParts) return fallback.date_from;
    const total = Number(fromParts[1]) * 12 + (Number(fromParts[2]) - 1) + delta;
    const y = Math.floor(total / 12);
    const m0 = ((total % 12) + 12) % 12;
    return `${String(y).padStart(4, "0")}-${String(m0 + 1).padStart(2, "0")}-01`;
  };

  if (!status.ok) {
    return { ...fallback, source: "fallback_computed", warning: status.reason };
  }

  const rawEffectiveTo = status.actual_data
    ? status.latest_finalised_month
    : previousMonthStart(status.latest_finalised_month);

  // Cap at fallback.date_to — Status must never push us past the
  // lag-adjusted ceiling we know DataForSEO Search Volume can serve.
  let capped = false;
  let effectiveTo = rawEffectiveTo;
  if (toParts && monthDiff(rawEffectiveTo, fallback.date_to) > 0) {
    effectiveTo = fallback.date_to;
    capped = true;
  }

  const baseSource = status.actual_data ? "status_actual" : "status_previous_finalised";
  const source = capped
    ? (baseSource === "status_actual" ? "status_actual_capped" : "status_previous_finalised_capped")
    : baseSource;

  if (!toParts) {
    return { date_from: fallback.date_from, date_to: effectiveTo, source };
  }

  const delta = monthDiff(effectiveTo, fallback.date_to); // <= 0 after cap
  const newFrom = delta === 0 ? fallback.date_from : shiftFromBy(delta);
  return { date_from: newFrom, date_to: effectiveTo, source };
}
