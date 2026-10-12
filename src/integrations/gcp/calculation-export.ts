import { getAccessToken } from "./auth";
import { SeerApiError, seerApiRequest } from "./api";

export type ExportScenario = "conservative" | "realistic" | "stretch";

/** Bounds for one downloadable CSV part. Parts hold the export Jake designed, unchanged: the
 *  same columns in the same order, the same rows, and the header repeated. Only the row count
 *  per file changes, so each part stays importable into Google Drive and Sheets. */
const MAX_PART_ROWS = 50_000;
const MAX_PART_BYTES = 45 * 1024 * 1024;
const PART_DOWNLOAD_INTERVAL_MS = 150;
const PAGE_ATTEMPTS = 5;
const PAGE_TIMEOUT_MS = 60_000;

interface CalculationExportPage {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  runId: string;
  nextAfter: string | null;
  filename: string;
  totalKeywords?: number;
}

export interface CalculationExportProgress {
  rows: number;
  totalRows?: number;
  retrying: boolean;
}

export interface CalculationExportSummary {
  parts: number;
  rows: number;
}

export function calculationCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/.test(value) ? `'${value}` : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function calculationPartFilename(filename: string, part: number, parts: number): string {
  if (parts < 2) return filename;
  const width = String(parts).length;
  const suffix = `-part-${String(part).padStart(width, "0")}-of-${String(parts).padStart(width, "0")}`;
  return filename.replace(/(\.csv)$/i, `${suffix}$1`);
}

function downloadCsv(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
}

function retryable(error: unknown): boolean {
  if (error instanceof SeerApiError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

export async function downloadCalculationResults(
  projectId: string, scenario?: ExportScenario, onProgress?: (progress: CalculationExportProgress) => void,
): Promise<CalculationExportSummary> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  const parts: Blob[] = [];
  const seenCursors = new Set<string>();
  let header = "";
  let current: Blob[] = [];
  let currentRows = 0;
  let currentBytes = 0;
  let totalRows = 0;
  let expectedRows: number | undefined;
  let columns: string[] | undefined;
  let runId: string | undefined;
  let after: string | null = null;
  let filename: string;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (scenario) params.set("scenario", scenario);
    if (runId) params.set("runId", runId);
    if (after) params.set("after", after);
    let page: CalculationExportPage | undefined;
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt += 1) {
      onProgress?.({ rows: totalRows, totalRows: expectedRows, retrying: attempt > 0 });
      try {
        page = await seerApiRequest<CalculationExportPage>(`/v1/projects/${projectId}/calculation-export?${params}`,
          { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) }, token);
        break;
      } catch (error) {
        if (!retryable(error)) throw error;
        if (attempt === PAGE_ATTEMPTS - 1) throw new Error("Results download was interrupted by repeated connection failures. Please retry the download.");
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    if (!page || !page.runId || !Array.isArray(page.columns) || !page.columns.length || !Array.isArray(page.rows)
      || !page.filename || (page.nextAfter !== null && typeof page.nextAfter !== "string")) {
      throw new Error("The results response is incomplete. Please retry the download.");
    }
    if (runId && page.runId !== runId) throw new Error("The completed run changed. Restart the export.");
    if (columns && (columns.length !== page.columns.length || columns.some((column, i) => column !== page.columns[i]))) {
      throw new Error("The export columns changed. Restart the export.");
    }
    if (!runId) {
      columns = page.columns;
      header = page.columns.map(calculationCsvCell).join(",");
      if (Number.isSafeInteger(page.totalKeywords) && Number(page.totalKeywords) > 0) {
        expectedRows = Number(page.totalKeywords) * (scenario ? 1 : 3);
      }
    }
    runId = page.runId;
    filename = page.filename;
    const lines = page.rows.map((row) => page.columns.map((column) => calculationCsvCell(row[column])).join(","));
    const chunk = new Blob(["\r\n", lines.join("\r\n")]);
    const bytes = chunk.size;
    if (bytes + new Blob(["\uFEFF", header]).size > MAX_PART_BYTES) throw new Error("A results page is too large to download. Please contact support.");
    // Parts break on page boundaries only, so every scenario row of a keyword stays in one file.
    if (current.length && (currentRows + lines.length > MAX_PART_ROWS || currentBytes + bytes > MAX_PART_BYTES)) {
      parts.push(new Blob(current, { type: "text/csv;charset=utf-8" })); current = []; currentRows = 0; currentBytes = 0;
    }
    if (!current.length) { const prefix = new Blob(["\uFEFF", header]); current.push(prefix); currentBytes = prefix.size; }
    if (lines.length) current.push(chunk);
    currentRows += lines.length;
    currentBytes += bytes;
    totalRows += lines.length;
    after = page.nextAfter;
    if (after && seenCursors.has(after)) throw new Error("The export did not advance. Please retry.");
    if (after) seenCursors.add(after);
    onProgress?.({ rows: totalRows, totalRows: expectedRows, retrying: false });
  } while (after);
  if (currentRows) parts.push(new Blob(current, { type: "text/csv;charset=utf-8" }));
  if (!totalRows) throw new Error("No completed keyword results are available.");
  if (expectedRows !== undefined && expectedRows !== totalRows) throw new Error("The results download is incomplete. No partial files were downloaded. Please retry.");
  for (const [index, blob] of parts.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, PART_DOWNLOAD_INTERVAL_MS));
    downloadCsv(blob, calculationPartFilename(filename, index + 1, parts.length));
  }
  return { parts: parts.length, rows: totalRows };
}
