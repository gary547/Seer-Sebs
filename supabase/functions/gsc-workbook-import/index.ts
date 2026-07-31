// gsc-workbook-import
// Parses a standard Google Search Console Excel export (.xlsx) and
// persists it as a single gsc_uploads row (source='gsc_workbook_v1')
// plus one gsc_upload_keywords row per Queries entry, and optional
// gsc_upload_pages rows if a Pages sheet is present.
//
// v1.1 (Prompt 2.1):
//   - Optional per-row Device column on Queries/Pages sheets.
//     When present, per-row device is captured and gsc_uploads.device
//     is set to "mixed"; when absent, upload-level device stays "all".
//   - Real-world numeric parsing: quoted thousands separators, "34.5%"
//     CTR, comma decimals ("3,7" → 3.7).
//   - Additive: legacy workbooks without a Device column import
//     byte-identically to v1.
//
// No CTR curve logic, no CSV upload changes. Downstream consumers
// (ctr-curves-from-gsc, resolvers) do not read per-row device yet.
// Auth: caller's Authorization header is used so RLS enforces project access.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import * as XLSX from "https://esm.sh/xlsx@0.18.5?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHUNK_SIZE = 500;
// Span bounds — reject outside, warn softly inside SHORT_WINDOW_DAYS.
const MIN_SPAN_DAYS = 28;
const MAX_SPAN_DAYS = 550;
const SHORT_WINDOW_DAYS = 90;

type Warning = string;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, error: string) {
  return jsonResponse(status, { code, error });
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function normalizeHeader(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (candidates.some((c) => h.includes(c))) return i;
  }
  return -1;
}

function sheetToRows(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: null,
    raw: true,
  }) as unknown[][];
}

function findHeaderRow(
  rows: unknown[][],
  required: string[][],
): { headerRowIndex: number; headers: string[] } | null {
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const headers = rows[r].map(normalizeHeader);
    const allMatched = required.every((cands) =>
      headers.some((h) => cands.some((c) => h.includes(c))),
    );
    if (allMatched) return { headerRowIndex: r, headers };
  }
  return null;
}

function coerceDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- Numeric parsing (v1.1) ---------------------------------------------
//
// Tolerates real-world Excel/CSV formatting:
//   "2,074"      → 2074       (thousands separator, group of 3)
//   "1,234,567"  → 1234567
//   "12,5"       → 12.5       (locale decimal comma; trailing 1–2 digit group)
//   "3,7"        → 3.7
//   "34.5"       → 34.5
//
// Rules:
//   1. Strip percent sign and surrounding whitespace.
//   2. If a "." exists, treat "," as thousands separator (strip all).
//   3. Else, if a "," is followed by 1–2 digits at end of string, treat as
//      decimal separator; every other "," is a thousands separator.
export function parseNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/%/g, "").trim();
  if (s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // Trailing comma-group of 1–2 digits → decimal comma.
    if (/,\d{1,2}$/.test(s) && !/,\d{3}$/.test(s)) {
      const idx = s.lastIndexOf(",");
      const intPart = s.slice(0, idx).replace(/,/g, "");
      const decPart = s.slice(idx + 1);
      s = `${intPart}.${decPart}`;
    } else {
      s = s.replace(/,/g, "");
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseInteger(v: unknown): number {
  return Math.round(parseNumber(v));
}

// Accepts "34.5%", "0.345", 34.5, 0.345, "34,5%". Clamps to [0, 1].
export function parseCtr(v: unknown): number {
  if (v == null || v === "") return 0;
  const hadPercent = typeof v === "string" && v.trim().endsWith("%");
  const n = parseNumber(v);
  if (!Number.isFinite(n) || n <= 0) return Math.max(0, n || 0);
  const decimal = hadPercent || n > 1 ? n / 100 : n;
  if (decimal < 0) return 0;
  if (decimal > 1) return 1;
  return decimal;
}

// Normalise device strings. Tablet is folded into desktop as standard
// practice for GSC modelling (small share, similar SERP behaviour).
export function normaliseDevice(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (s === "DESKTOP") return "desktop";
  if (s === "MOBILE") return "mobile";
  if (s === "TABLET") return "desktop";
  return null;
}

// ---- Sheet extractors ---------------------------------------------------

function extractChartDates(
  ws: XLSX.WorkSheet,
): { start: string; end: string; count: number } | { error: string; code: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [["date"]]);
  if (!header) return { code: "chart_date_column_missing", error: "Chart sheet has no Date column." };

  const dateIdx = header.headers.findIndex((h) => h.includes("date"));
  const dates: Date[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const cell = rows[r][dateIdx];
    const d = coerceDate(cell);
    if (d) dates.push(d);
  }
  if (!dates.length) {
    return { code: "chart_date_column_missing", error: "Chart sheet Date column has no valid dates." };
  }

  const min = new Date(Math.min(...dates.map((d) => d.getTime())));
  const max = new Date(Math.max(...dates.map((d) => d.getTime())));
  const spanDays = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;

  if (spanDays < MIN_SPAN_DAYS || spanDays > MAX_SPAN_DAYS) {
    return {
      code: "date_range_out_of_bounds",
      error:
        `Workbook date range is ${spanDays} days. Standard GSC exports cover ` +
        `${MIN_SPAN_DAYS}–${MAX_SPAN_DAYS} days. A future UI phase will let you enter dates manually.`,
    };
  }

  return { start: toISODate(min), end: toISODate(max), count: dates.length };
}

export interface QueryRow {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  device: string | null;
}

export function extractQueries(
  ws: XLSX.WorkSheet,
): { rows: QueryRow[]; hasDeviceColumn: boolean } | { error: string; code: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [
    ["top queries", "query", "keyword"],
    ["position"],
  ]);
  if (!header) {
    return {
      code: "queries_columns_missing",
      error: "Queries sheet must have a Query/Top queries column and a Position column.",
    };
  }

  const kwIdx = findColumnIndex(header.headers, ["top queries", "query", "keyword"]);
  const clicksIdx = findColumnIndex(header.headers, ["clicks"]);
  const imprIdx = findColumnIndex(header.headers, ["impressions"]);
  const ctrIdx = findColumnIndex(header.headers, ["ctr"]);
  const posIdx = findColumnIndex(header.headers, ["position"]);
  const devIdx = findColumnIndex(header.headers, ["device"]);
  const hasDeviceColumn = devIdx >= 0;

  if (kwIdx < 0 || posIdx < 0) {
    return {
      code: "queries_columns_missing",
      error: "Queries sheet is missing required columns (keyword / position).",
    };
  }

  const out: QueryRow[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const kw = String(row[kwIdx] ?? "").trim();
    if (!kw) continue;
    const position = parseNumber(row[posIdx]);
    if (!(position > 0)) continue;
    out.push({
      keyword: kw,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : 0,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : 0,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : 0,
      position,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }

  return { rows: out, hasDeviceColumn };
}

export interface PageRow {
  page_url: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  device: string | null;
}

export function extractPages(
  ws: XLSX.WorkSheet,
): { rows: PageRow[]; hasDeviceColumn: boolean } | { skipped: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [["top pages", "page", "url"]]);
  if (!header) return { skipped: "no recognisable Page column" };

  const urlIdx = findColumnIndex(header.headers, ["top pages", "page", "url"]);
  const clicksIdx = findColumnIndex(header.headers, ["clicks"]);
  const imprIdx = findColumnIndex(header.headers, ["impressions"]);
  const ctrIdx = findColumnIndex(header.headers, ["ctr"]);
  const posIdx = findColumnIndex(header.headers, ["position"]);
  const devIdx = findColumnIndex(header.headers, ["device"]);
  const hasDeviceColumn = devIdx >= 0;

  const out: PageRow[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const url = String(row[urlIdx] ?? "").trim();
    if (!url) continue;
    out.push({
      page_url: url,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : null,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : null,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : null,
      position: posIdx >= 0 ? parseNumber(row[posIdx]) : null,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }
  return { rows: out, hasDeviceColumn };
}

// ---- CSV parsing --------------------------------------------------------
//
// Tolerant CSV row splitter that respects double-quoted fields (so a value
// like `"2,074"` isn't split on its embedded comma). GSC exports quote any
// value containing a comma or newline; we accept both the quoted and the
// unquoted forms here.
export function parseCsvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      if (row.some((v) => v !== "")) out.push(row);
      row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) out.push(row);
  }
  return out;
}

export function extractQueriesFromCsv(
  text: string,
): { rows: QueryRow[]; hasDeviceColumn: boolean } | { error: string; code: string } {
  const grid = parseCsvRows(text);
  if (!grid.length) {
    return { code: "queries_columns_missing", error: "CSV is empty." };
  }
  const header = grid[0].map((v) => String(v ?? "").trim().toLowerCase());
  const kwIdx = findColumnIndex(header, ["top queries", "query", "keyword"]);
  const clicksIdx = findColumnIndex(header, ["clicks"]);
  const imprIdx = findColumnIndex(header, ["impressions"]);
  const ctrIdx = findColumnIndex(header, ["ctr"]);
  const posIdx = findColumnIndex(header, ["position"]);
  const devIdx = findColumnIndex(header, ["device"]);
  const hasDeviceColumn = devIdx >= 0;
  if (kwIdx < 0 || posIdx < 0) {
    return {
      code: "queries_columns_missing",
      error: "CSV must include Query/Top queries and Position columns.",
    };
  }
  const out: QueryRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const kw = String(row[kwIdx] ?? "").trim();
    if (!kw) continue;
    const position = parseNumber(row[posIdx]);
    if (!(position > 0)) continue;
    // NB: NO dedupe on keyword — a query legitimately appears once per device.
    out.push({
      keyword: kw,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : 0,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : 0,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : 0,
      position,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }
  return { rows: out, hasDeviceColumn };
}

function isoDateOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return toISODate(d);
}

// ---- Handler ------------------------------------------------------------


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return errorResponse(500, "misconfigured", "Missing Supabase env vars.");
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return errorResponse(401, "unauthorized", "Missing Authorization header.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: {
    project_id?: string;
    format?: "xlsx_base64" | "csv_text";
    file_base64?: string;
    csv_text?: string;
    filename?: string;
    date_range_start?: string;
    date_range_end?: string;
    device?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, "invalid_payload", "Body must be JSON.");
  }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return errorResponse(400, "invalid_payload", "project_id is required.");
  }
  // Format resolution: explicit `format`, else infer from which body is set.
  const format: "xlsx_base64" | "csv_text" =
    payload.format ??
    (payload.csv_text ? "csv_text" : payload.file_base64 ? "xlsx_base64" : "xlsx_base64");

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return errorResponse(401, "unauthorized", "Invalid or expired token.");
  }

  const { data: proj, error: projErr } = await supabase
    .from("navigator_projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return errorResponse(500, "db_error", projErr.message);
  if (!proj) return errorResponse(403, "forbidden_project", "Project not visible.");

  const warnings: Warning[] = [];
  let queryRows: QueryRow[] = [];
  let pageRows: PageRow[] = [];
  let pagesHasDevice = false;
  let queriesHasDevice = false;
  let dateStart: string;
  let dateEnd: string;
  let source: "gsc_workbook_v1" | "gsc_csv_v2";
  let sheetsSeen: string[] = [];

  if (format === "csv_text") {
    source = "gsc_csv_v2";
    if (!payload.csv_text || typeof payload.csv_text !== "string") {
      return errorResponse(400, "invalid_payload", "csv_text is required for format=csv_text.");
    }
    const start = isoDateOrNull(payload.date_range_start);
    const end = isoDateOrNull(payload.date_range_end);
    if (!start || !end) {
      return errorResponse(
        400,
        "missing_date_range",
        "date_range_start and date_range_end are required for CSV uploads.",
      );
    }
    if (new Date(end).getTime() < new Date(start).getTime()) {
      return errorResponse(400, "missing_date_range", "date_range_end must be on or after date_range_start.");
    }
    dateStart = start;
    dateEnd = end;

    const csvResult = extractQueriesFromCsv(payload.csv_text);
    if ("error" in csvResult) return errorResponse(400, csvResult.code, csvResult.error);
    queryRows = csvResult.rows;
    queriesHasDevice = csvResult.hasDeviceColumn;
    if (!queryRows.length) {
      return errorResponse(400, "queries_columns_missing", "CSV has no valid keyword rows.");
    }
  } else {
    source = "gsc_workbook_v1";
    const fileB64 = payload.file_base64;
    if (!fileB64 || typeof fileB64 !== "string") {
      return errorResponse(400, "invalid_payload", "file_base64 is required for format=xlsx_base64.");
    }

    let workbook: XLSX.WorkBook;
    try {
      const bytes = base64ToBytes(fileB64);
      workbook = XLSX.read(bytes, { type: "array", cellDates: true });
    } catch (e) {
      return errorResponse(400, "invalid_workbook", `Could not parse xlsx: ${(e as Error).message}`);
    }
    const sheetsByLower = new Map<string, string>();
    for (const name of workbook.SheetNames) sheetsByLower.set(name.toLowerCase(), name);
    sheetsSeen = workbook.SheetNames;
    const chartName = sheetsByLower.get("chart");
    const queriesName = sheetsByLower.get("queries");
    const pagesName = sheetsByLower.get("pages");
    const devicesName = sheetsByLower.get("devices");
    if (!chartName) return errorResponse(400, "chart_sheet_missing", "Workbook has no Chart sheet.");
    if (!queriesName) return errorResponse(400, "queries_sheet_missing", "Workbook has no Queries sheet.");

    const chartResult = extractChartDates(workbook.Sheets[chartName]);
    if ("error" in chartResult) return errorResponse(400, chartResult.code, chartResult.error);
    dateStart = chartResult.start;
    dateEnd = chartResult.end;

    const queriesResult = extractQueries(workbook.Sheets[queriesName]);
    if ("error" in queriesResult) return errorResponse(400, queriesResult.code, queriesResult.error);
    queryRows = queriesResult.rows;
    queriesHasDevice = queriesResult.hasDeviceColumn;
    if (!queryRows.length) {
      return errorResponse(400, "queries_columns_missing", "Queries sheet has no valid keyword rows.");
    }
    if (pagesName) {
      const pagesResult = extractPages(workbook.Sheets[pagesName]);
      if ("rows" in pagesResult) {
        pageRows = pagesResult.rows;
        pagesHasDevice = pagesResult.hasDeviceColumn;
      } else {
        warnings.push(`Pages sheet skipped: ${pagesResult.skipped}.`);
      }
    }
    if (devicesName) warnings.push("Devices sheet ignored in v1.");
  }

  // Span guard applied to BOTH paths.
  const spanDays = Math.round(
    (new Date(dateEnd).getTime() - new Date(dateStart).getTime()) / 86400000,
  ) + 1;
  if (spanDays < MIN_SPAN_DAYS || spanDays > MAX_SPAN_DAYS) {
    return errorResponse(
      400,
      "date_range_out_of_bounds",
      `Date range is ${spanDays} days. Accepted: ${MIN_SPAN_DAYS}–${MAX_SPAN_DAYS} days.`,
    );
  }
  if (spanDays < SHORT_WINDOW_DAYS) {
    warnings.push(`short window (${spanDays} days) — calibration will be noisier.`);
  }

  const perRowDevice = queriesHasDevice || pagesHasDevice;
  let uploadDevice: string;
  if (perRowDevice) {
    uploadDevice = "mixed";
    warnings.push('Per-row Device column detected — upload marked "mixed".');
  } else {
    const callerDev = normaliseDevice(payload.device) ??
      (payload.device && String(payload.device).trim().toLowerCase() === "all" ? "all" : null);
    if (!callerDev) {
      return errorResponse(
        400,
        "invalid_payload",
        "device is required when the file has no per-row Device column (all | mobile | desktop).",
      );
    }
    uploadDevice = callerDev;
  }

  const { data: uploadData, error: uploadErr } = await supabase
    .from("gsc_uploads")
    .insert({
      project_id: projectId,
      device: uploadDevice,
      source,
      date_range_start: dateStart,
      date_range_end: dateEnd,
      row_count: queryRows.length,
    })
    .select("id")
    .single();
  if (uploadErr || !uploadData) {
    return errorResponse(500, "db_error", uploadErr?.message ?? "Failed to insert gsc_uploads.");
  }
  const uploadId = (uploadData as { id: string }).id;

  for (let i = 0; i < queryRows.length; i += CHUNK_SIZE) {
    const chunk = queryRows.slice(i, i + CHUNK_SIZE).map((r) => ({
      upload_id: uploadId,
      keyword: r.keyword,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      device: r.device,
    }));
    const { error: kwErr } = await supabase.from("gsc_upload_keywords").insert(chunk);
    if (kwErr) {
      await supabase.from("gsc_uploads").delete().eq("id", uploadId);
      return errorResponse(500, "db_error", `Keyword insert failed: ${kwErr.message}`);
    }
  }

  let pagesInserted = 0;
  if (pageRows.length) {
    for (let i = 0; i < pageRows.length; i += CHUNK_SIZE) {
      const chunk = pageRows.slice(i, i + CHUNK_SIZE).map((r) => ({
        upload_id: uploadId,
        ...r,
      }));
      const { error: pgErr } = await supabase.from("gsc_upload_pages").insert(chunk);
      if (pgErr) {
        warnings.push(`Pages insert stopped after ${pagesInserted} rows: ${pgErr.message}`);
        break;
      }
      pagesInserted += chunk.length;
    }
  }

  return jsonResponse(200, {
    upload_id: uploadId,
    date_range_start: dateStart,
    date_range_end: dateEnd,
    row_count: queryRows.length,
    pages_inserted: pagesInserted,
    sheets_seen: sheetsSeen,
    upload_device: uploadDevice,
    source,
    warnings,
  });
});
