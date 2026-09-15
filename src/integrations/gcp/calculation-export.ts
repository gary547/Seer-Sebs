import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export type ExportScenario = "conservative" | "realistic" | "stretch";

/** Bounds for one downloadable CSV part. Parts hold the export Jake designed, unchanged: the
 *  same columns in the same order, the same rows, and the header repeated. Only the row count
 *  per file changes, so each part stays importable into Google Drive and Sheets. */
const MAX_PART_ROWS = 50_000;
const MAX_PART_BYTES = 45 * 1024 * 1024;
const PART_DOWNLOAD_INTERVAL_MS = 150;

interface CalculationExportPage {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  runId: string;
  nextAfter: string | null;
  filename: string;
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

function downloadCsv(contents: string, filename: string): void {
  const blob = new Blob(["\uFEFF", contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadCalculationResults(projectId: string, scenario?: ExportScenario): Promise<CalculationExportSummary> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  const parts: string[][] = [];
  const seenCursors = new Set<string>();
  let header = "";
  let current: string[] = [];
  let currentBytes = 0;
  let totalRows = 0;
  let runId: string | undefined;
  let after: string | null = null;
  let filename: string;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (scenario) params.set("scenario", scenario);
    if (runId) params.set("runId", runId);
    if (after) params.set("after", after);
    const page: CalculationExportPage = await seerApiRequest(`/v1/projects/${projectId}/calculation-export?${params}`, {}, token);
    if (runId && page.runId !== runId) throw new Error("The completed run changed. Restart the export.");
    if (!runId) header = page.columns.map(calculationCsvCell).join(",");
    runId = page.runId;
    filename = page.filename;
    const lines = page.rows.map((row) => page.columns.map((column) => calculationCsvCell(row[column])).join(","));
    const bytes = lines.reduce((total, line) => total + line.length + 2, 0);
    // Parts break on page boundaries only, so every scenario row of a keyword stays in one file.
    if (current.length && (current.length + lines.length > MAX_PART_ROWS || currentBytes + bytes > MAX_PART_BYTES)) {
      parts.push(current); current = []; currentBytes = 0;
    }
    current.push(...lines);
    currentBytes += bytes;
    totalRows += lines.length;
    after = page.nextAfter;
    if (after && seenCursors.has(after)) throw new Error("The export did not advance. Please retry.");
    if (after) seenCursors.add(after);
  } while (after);
  if (current.length) parts.push(current);
  if (!totalRows) throw new Error("No completed keyword results are available.");
  for (const [index, lines] of parts.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, PART_DOWNLOAD_INTERVAL_MS));
    downloadCsv([header, ...lines].join("\r\n"), calculationPartFilename(filename, index + 1, parts.length));
  }
  return { parts: parts.length, rows: totalRows };
}
