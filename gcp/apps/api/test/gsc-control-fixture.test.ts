import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseCsvRows,
  parseGscWorkbookImport,
} from "../src/gsc-workbook.js";

const filename =
  "Pilltime SAFS Export - 21.03.2025 - 01.08.2026 - SAS_2026-08-03_17-49-45.csv";
const fixture = new URL(
  `../../../fixtures/control-data/pilltime/${filename}`,
  import.meta.url,
);

describe("Pilltime SAFS control fixture", () => {
  it("passes the production CSV import contract without losing device data", async () => {
    const csvText = await readFile(fixture, "utf8");
    const rawRows = parseCsvRows(csvText);
    const parsed = parseGscWorkbookImport({
      csvText,
      dateRangeEnd: "2026-08-01",
      dateRangeStart: "2025-03-21",
      filename,
      format: "csv_text",
    });

    expect(rawRows[0]).toEqual([
      "Query",
      "Device",
      "Clicks",
      "Impressions",
      "CTR",
      "Position",
    ]);
    expect(rawRows).toHaveLength(25_001);
    expect(parsed.dateRangeStart).toBe("2025-03-21");
    expect(parsed.dateRangeEnd).toBe("2026-08-01");
    expect(parsed.device).toBe("mixed");
    expect(parsed.originalFilename).toBe(filename);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((row) => row.device !== "all")).toBe(true);
    expect(parsed.warnings).toContain(
      "Per-row Device column detected; upload marked mixed.",
    );
  });
});
