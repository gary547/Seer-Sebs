import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

interface CalculationExportPage {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  runId: string;
  nextAfter: string | null;
  filename: string;
}

export function calculationCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/.test(value) ? `'${value}` : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function downloadCalculationResults(projectId: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  const lines: string[] = [];
  const seenCursors = new Set<string>();
  let runId: string | undefined;
  let after: string | null = null;
  let filename = "seer-results.csv";
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (runId) params.set("runId", runId);
    if (after) params.set("after", after);
    const page: CalculationExportPage = await seerApiRequest(`/v1/projects/${projectId}/calculation-export?${params}`, {}, token);
    if (runId && page.runId !== runId) throw new Error("The completed run changed. Restart the export.");
    if (!runId) lines.push(page.columns.map(calculationCsvCell).join(","));
    runId = page.runId;
    filename = page.filename;
    lines.push(...page.rows.map((row) => page.columns.map((column) => calculationCsvCell(row[column])).join(",")));
    after = page.nextAfter;
    if (after && seenCursors.has(after)) throw new Error("The export did not advance. Please retry.");
    if (after) seenCursors.add(after);
  } while (after);
  if (lines.length < 2) throw new Error("No completed keyword results are available.");
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}
