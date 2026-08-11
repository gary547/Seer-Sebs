import { unzipSync } from "fflate";

import { HttpError } from "../../../packages/runtime/src/http.js";

const MINIMUM_SPAN_DAYS = 28;
const MAXIMUM_SPAN_DAYS = 550;
const SHORT_WINDOW_DAYS = 90;
const MAXIMUM_UNCOMPRESSED_BYTES = 50 * 1_024 * 1_024;
const MAXIMUM_QUERY_LENGTH = 200;

type Device = "all" | "desktop" | "mobile" | "tablet";

interface GscMetricRow {
  clicks: number;
  ctr: number;
  device: Device | null;
  impressions: number;
  position: number;
}

interface QueryRow extends GscMetricRow {
  page: string;
  query: string;
}

interface PageRow extends GscMetricRow {
  pageUrl: string;
}

export interface ParsedGscWorkbook {
  dateRangeEnd: string;
  dateRangeStart: string;
  device: "all" | "desktop" | "mixed" | "mobile" | "tablet";
  originalFilename: string;
  pages: PageRow[];
  rows: QueryRow[];
  sheetsSeen: string[];
  sourceName: "gsc_csv_v2" | "gsc_workbook_v1";
  warnings: string[];
}

interface SheetGrid {
  name: string;
  rows: unknown[][];
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_payload", "The import payload is invalid.");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new HttpError(400, "invalid_payload", `${field} is invalid.`);
  }
  return value.trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of value.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)) {
    const name = match[1];
    const attributeValue = match[2];
    if (name !== undefined && attributeValue !== undefined) {
      result.set(name, decodeXml(attributeValue));
    }
  }
  return result;
}

function textNodes(value: string): string {
  return [...value.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "";
  let index = 0;
  for (const character of letters) {
    index = index * 26 + character.charCodeAt(0) - 64;
  }
  return Math.max(0, index - 1);
}

function parseSheet(xml: string, sharedStrings: string[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const rowMatch of xml.matchAll(
    /<(?:\w+:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>/g,
  )) {
    const row: unknown[] = [];
    let sequentialColumn = 0;
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<(?:\w+:)?c(\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?c>/g,
    )) {
      const cellAttributes = attributes(cellMatch[1] ?? "");
      const reference = cellAttributes.get("r");
      const index = reference ? columnIndex(reference) : sequentialColumn;
      sequentialColumn = index + 1;
      const type = cellAttributes.get("t") ?? "";
      const content = cellMatch[2] ?? "";
      const rawValue = content.match(
        /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/,
      )?.[1];
      let value: unknown = null;
      if (type === "inlineStr") {
        value = textNodes(content);
      } else if (rawValue !== undefined) {
        const decoded = decodeXml(rawValue);
        if (type === "s") {
          value = sharedStrings[Number(decoded)] ?? "";
        } else if (type === "str") {
          value = decoded;
        } else {
          const numeric = Number(decoded);
          value = Number.isFinite(numeric) ? numeric : decoded;
        }
      }
      row[index] = value;
    }
    rows.push(row);
  }
  return rows;
}

function parseXlsx(base64: string): SheetGrid[] {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  } catch {
    throw new HttpError(400, "invalid_workbook", "The workbook encoding is invalid.");
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new HttpError(400, "invalid_workbook", "The XLSX archive is invalid.");
  }
  const totalBytes = Object.values(files).reduce(
    (total, file) => total + file.byteLength,
    0,
  );
  if (totalBytes > MAXIMUM_UNCOMPRESSED_BYTES) {
    throw new HttpError(413, "workbook_too_large", "The workbook is too large.");
  }
  const readXml = (path: string): string | null => {
    const file = files[path];
    return file ? Buffer.from(file).toString("utf8") : null;
  };
  const workbookXml = readXml("xl/workbook.xml");
  const relationshipsXml = readXml("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relationshipsXml) {
    throw new HttpError(400, "invalid_workbook", "The workbook structure is incomplete.");
  }
  const sharedStringsXml = readXml("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml
    ? [...sharedStringsXml.matchAll(
        /<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g,
      )].map((match) => textNodes(match[1] ?? ""))
    : [];
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(
    /<(?:\w+:)?Relationship(\s[^>]*?)\/?>/g,
  )) {
    const values = attributes(match[1] ?? "");
    const id = values.get("Id");
    const target = values.get("Target");
    if (id && target) {
      relationships.set(
        id,
        target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
      );
    }
  }
  const sheets: SheetGrid[] = [];
  for (const match of workbookXml.matchAll(
    /<(?:\w+:)?sheet(\s[^>]*?)\/?>/g,
  )) {
    const values = attributes(match[1] ?? "");
    const name = values.get("name");
    const relationId = values.get("r:id");
    const target = relationId ? relationships.get(relationId) : null;
    const sheetXml = target ? readXml(target) : null;
    if (name && sheetXml) {
      sheets.push({ name, rows: parseSheet(sheetXml, sharedStrings) });
    }
  }
  return sheets;
}

export function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let input = String(value).trim().replaceAll("%", "");
  if (input.includes(".")) {
    input = input.replaceAll(",", "");
  } else if (input.includes(",")) {
    if (/,\d{1,2}$/.test(input) && !/,\d{3}$/.test(input)) {
      const separator = input.lastIndexOf(",");
      input = `${input.slice(0, separator).replaceAll(",", "")}.${input.slice(separator + 1)}`;
    } else {
      input = input.replaceAll(",", "");
    }
  }
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value: unknown): number {
  return Math.max(0, Math.round(parseNumber(value)));
}

function parseCtr(value: unknown): number {
  const percent = typeof value === "string" && value.trim().endsWith("%");
  const number = parseNumber(value);
  return Math.min(1, Math.max(0, percent || number > 1 ? number / 100 : number));
}

function normaliseDevice(value: unknown): Device | null {
  const device = String(value ?? "").trim().toLowerCase();
  if (device === "all" || device === "desktop" || device === "mobile") {
    return device;
  }
  if (device === "tablet") return "desktop";
  return null;
}

function header(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function findColumn(headers: string[], candidates: string[]): number {
  return headers.findIndex((value) =>
    candidates.some((candidate) => value.includes(candidate)),
  );
}

function findHeaderRow(
  rows: unknown[][],
  required: string[][],
): { headers: string[]; index: number } | null {
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const headers = (rows[index] ?? []).map(header);
    if (
      required.every((candidates) =>
        headers.some((value) =>
          candidates.some((candidate) => value.includes(candidate)),
        ),
      )
    ) {
      return { headers, index };
    }
  }
  return null;
}

function metricColumns(headers: string[]) {
  return {
    clicks: findColumn(headers, ["clicks"]),
    ctr: findColumn(headers, ["ctr"]),
    device: findColumn(headers, ["device"]),
    impressions: findColumn(headers, ["impressions"]),
    position: findColumn(headers, ["position"]),
  };
}

function queryRows(rows: unknown[][]): {
  hasDevice: boolean;
  rows: QueryRow[];
  skippedLongQueries: number;
} {
  const found = findHeaderRow(rows, [
    ["top queries", "query", "keyword"],
    ["position"],
  ]);
  if (!found) {
    throw new HttpError(
      400,
      "queries_columns_missing",
      "Queries must include Query and Position columns.",
    );
  }
  const columns = metricColumns(found.headers);
  const query = findColumn(found.headers, ["top queries", "query", "keyword"]);
  const output: QueryRow[] = [];
  let skippedLongQueries = 0;
  for (const row of rows.slice(found.index + 1)) {
    const value = String(row[query] ?? "").trim();
    const position = parseNumber(row[columns.position]);
    if (!value || position <= 0) continue;
    if (value.length > MAXIMUM_QUERY_LENGTH) {
      skippedLongQueries += 1;
      continue;
    }
    output.push({
      clicks: columns.clicks >= 0 ? parseInteger(row[columns.clicks]) : 0,
      ctr: columns.ctr >= 0 ? parseCtr(row[columns.ctr]) : 0,
      device: columns.device >= 0 ? normaliseDevice(row[columns.device]) : null,
      impressions:
        columns.impressions >= 0 ? parseInteger(row[columns.impressions]) : 0,
      page: "",
      position,
      query: value,
    });
  }
  if (output.length === 0) {
    throw new HttpError(
      400,
      "queries_columns_missing",
      "The Queries input has no valid rows.",
    );
  }
  return {
    hasDevice: columns.device >= 0,
    rows: output,
    skippedLongQueries,
  };
}

function pageRows(rows: unknown[][]): { hasDevice: boolean; rows: PageRow[] } {
  const found = findHeaderRow(rows, [["top pages", "page", "url"]]);
  if (!found) return { hasDevice: false, rows: [] };
  const columns = metricColumns(found.headers);
  const page = findColumn(found.headers, ["top pages", "page", "url"]);
  const output: PageRow[] = [];
  for (const row of rows.slice(found.index + 1)) {
    const value = String(row[page] ?? "").trim();
    if (!value) continue;
    output.push({
      clicks: columns.clicks >= 0 ? parseInteger(row[columns.clicks]) : 0,
      ctr: columns.ctr >= 0 ? parseCtr(row[columns.ctr]) : 0,
      device: columns.device >= 0 ? normaliseDevice(row[columns.device]) : null,
      impressions:
        columns.impressions >= 0 ? parseInteger(row[columns.impressions]) : 0,
      pageUrl: value,
      position: columns.position >= 0 ? parseNumber(row[columns.position]) : 0,
    });
  }
  return { hasDevice: columns.device >= 0, rows: output };
}

function excelDate(value: unknown): Date | null {
  if (typeof value === "number") {
    const date = new Date(Math.round((value - 25_569) * 86_400_000));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function chartDates(rows: unknown[][]): { end: string; start: string } {
  const found = findHeaderRow(rows, [["date"]]);
  if (!found) {
    throw new HttpError(400, "chart_date_column_missing", "Chart has no Date column.");
  }
  const column = findColumn(found.headers, ["date"]);
  const dates = rows
    .slice(found.index + 1)
    .map((row) => excelDate(row[column]))
    .filter((date): date is Date => date !== null);
  if (dates.length === 0) {
    throw new HttpError(
      400,
      "chart_date_column_missing",
      "Chart has no valid dates.",
    );
  }
  return {
    end: isoDate(new Date(Math.max(...dates.map((date) => date.getTime())))),
    start: isoDate(new Date(Math.min(...dates.map((date) => date.getTime())))),
  };
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function strictIsoDate(value: unknown, field: string): string {
  const input = requiredString(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new HttpError(400, "missing_date_range", `${field} is invalid.`);
  }
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== input) {
    throw new HttpError(400, "missing_date_range", `${field} is invalid.`);
  }
  return input;
}

function applyDevice<T extends GscMetricRow>(
  rows: T[],
  fallback: Device,
): T[] {
  return rows.map((row) => ({ ...row, device: row.device ?? fallback }));
}

export function parseGscWorkbookImport(body: unknown): ParsedGscWorkbook {
  const record = bodyRecord(body);
  const format = requiredString(record.format, "format", 32);
  if (format !== "csv_text" && format !== "xlsx_base64") {
    throw new HttpError(400, "invalid_payload", "format is invalid.");
  }
  const originalFilename = requiredString(record.filename, "filename", 255);
  let rows: QueryRow[];
  let pages: PageRow[] = [];
  let dateRangeStart: string;
  let dateRangeEnd: string;
  let hasPerRowDevice: boolean;
  let sheetsSeen: string[] = [];
  const warnings: string[] = [];
  const sourceName =
    format === "csv_text" ? "gsc_csv_v2" : "gsc_workbook_v1";

  if (format === "csv_text") {
    const parsed = queryRows(
      parseCsvRows(requiredString(record.csvText, "csvText", 20 * 1_024 * 1_024)),
    );
    rows = parsed.rows;
    hasPerRowDevice = parsed.hasDevice;
    if (parsed.skippedLongQueries > 0) {
      warnings.push(
        `${parsed.skippedLongQueries} quer${parsed.skippedLongQueries === 1 ? "y was" : "ies were"} skipped because it exceeded ${MAXIMUM_QUERY_LENGTH} characters.`,
      );
    }
    dateRangeStart = strictIsoDate(record.dateRangeStart, "dateRangeStart");
    dateRangeEnd = strictIsoDate(record.dateRangeEnd, "dateRangeEnd");
  } else {
    const workbook = parseXlsx(
      requiredString(record.fileBase64, "fileBase64", 28 * 1_024 * 1_024),
    );
    sheetsSeen = workbook.map((sheet) => sheet.name);
    const byName = new Map(
      workbook.map((sheet) => [sheet.name.trim().toLowerCase(), sheet]),
    );
    const chart = byName.get("chart");
    const queries = byName.get("queries");
    if (!chart) {
      throw new HttpError(400, "chart_sheet_missing", "Workbook has no Chart sheet.");
    }
    if (!queries) {
      throw new HttpError(
        400,
        "queries_sheet_missing",
        "Workbook has no Queries sheet.",
      );
    }
    const dates = chartDates(chart.rows);
    dateRangeStart = dates.start;
    dateRangeEnd = dates.end;
    const parsedQueries = queryRows(queries.rows);
    rows = parsedQueries.rows;
    hasPerRowDevice = parsedQueries.hasDevice;
    if (parsedQueries.skippedLongQueries > 0) {
      warnings.push(
        `${parsedQueries.skippedLongQueries} quer${parsedQueries.skippedLongQueries === 1 ? "y was" : "ies were"} skipped because it exceeded ${MAXIMUM_QUERY_LENGTH} characters.`,
      );
    }
    const pageSheet = byName.get("pages");
    if (pageSheet) {
      const parsedPages = pageRows(pageSheet.rows);
      pages = parsedPages.rows;
      hasPerRowDevice ||= parsedPages.hasDevice;
    }
    if (byName.has("devices")) {
      warnings.push("Devices sheet ignored; row-level devices take precedence.");
    }
  }

  const start = new Date(`${dateRangeStart}T00:00:00.000Z`).getTime();
  const end = new Date(`${dateRangeEnd}T00:00:00.000Z`).getTime();
  const spanDays = Math.round((end - start) / 86_400_000) + 1;
  if (spanDays < MINIMUM_SPAN_DAYS || spanDays > MAXIMUM_SPAN_DAYS) {
    throw new HttpError(
      400,
      "date_range_out_of_bounds",
      `Date range is ${spanDays} days. Accepted: ${MINIMUM_SPAN_DAYS}-${MAXIMUM_SPAN_DAYS} days.`,
    );
  }
  if (spanDays < SHORT_WINDOW_DAYS) {
    warnings.push(`Short window (${spanDays} days); calibration will be noisier.`);
  }

  const requestedDevice = normaliseDevice(record.device);
  if (!hasPerRowDevice && !requestedDevice) {
    throw new HttpError(
      400,
      "invalid_payload",
      "device is required when the file has no Device column.",
    );
  }
  const fallbackDevice = requestedDevice ?? "all";
  const device = hasPerRowDevice ? "mixed" : fallbackDevice;
  if (hasPerRowDevice) {
    warnings.push("Per-row Device column detected; upload marked mixed.");
  }

  return {
    dateRangeEnd,
    dateRangeStart,
    device,
    originalFilename,
    pages: applyDevice(pages, fallbackDevice),
    rows: applyDevice(rows, fallbackDevice),
    sheetsSeen,
    sourceName,
    warnings,
  };
}
