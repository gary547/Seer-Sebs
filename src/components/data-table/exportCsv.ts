import type { Column, FetchPageArgs, SortState } from "./types";

const escape = (val: unknown): string => {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const headerText = (h: unknown): string => {
  if (typeof h === "string") return h;
  if (typeof h === "number") return String(h);
  return "";
};

type ExportArgs<TRow> = {
  filename: string;
  total: number;
  search: string;
  filter: string;
  sort: SortState;
  columns: Column<TRow>[];
  /** Optional per-row CSV serializer. Defaults to converting cell() output via String(). */
  rowToValues?: (row: TRow) => unknown[];
  fetchPage: (args: FetchPageArgs) => Promise<TRow[]>;
  pageSize?: number;
};

export async function exportTableCsv<TRow>({
  filename,
  total,
  search,
  filter,
  sort,
  columns,
  rowToValues,
  fetchPage,
  pageSize = 1000,
}: ExportArgs<TRow>) {
  const headers = columns.map((c) => headerText(c.header));
  const lines: string[] = [headers.map(escape).join(",")];

  for (let from = 0; from < total; from += pageSize) {
    const to = Math.min(total - 1, from + pageSize - 1);
    const rows = await fetchPage({ from, to, search, filter, sort });
    for (const row of rows) {
      const values = rowToValues
        ? rowToValues(row)
        : columns.map((c) => {
            const node = c.cell(row);
            return typeof node === "string" || typeof node === "number" ? node : "";
          });
      lines.push(values.map(escape).join(","));
    }
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
