import { describe, expect, it } from "vitest";
import { parseGscWorkbookImport } from "../src/gsc-workbook.js";

const file = (name: string, rows: string, extra = {}) => ({
  filename: `${name}.csv`, format: "csv_text", device: "all",
  dateRangeStart: "2025-04-28", dateRangeEnd: "2026-09-07",
  csvText: `Query,Page,Clicks,Impressions,CTR,Position\n${rows}`, ...extra,
});
const tv = file("tv", "tv,https://example.com/tv,10,100,10%,8");
const oven = file("oven", "oven,https://example.com/oven,5,200,2.5%,12");
const fridge = file("fridge", "fridge,https://example.com/fridge,4,40,10%,6");

describe("atomic GSC batches", () => {
  it("combines all category files into one logical input with provenance", () => {
    const parsed = parseGscWorkbookImport({ files: [tv, oven, fridge] });
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows.reduce((sum, row) => sum + row.impressions, 0)).toBe(340);
    expect(parsed.sourceName).toBe("gsc_batch_v1");
    expect(parsed.sourceFiles.map((source) => source.filename)).toEqual(["tv.csv", "oven.csv", "fridge.csv"]);
    expect(parsed.sourceFiles.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
    expect(parsed.rows).toEqual(parseGscWorkbookImport({ files: [fridge, tv, oven] }).rows);
  });
  it("counts identical overlapping exports once, including a repeated file", () => {
    const parsed = parseGscWorkbookImport({ files: [tv, tv, oven] });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.reduce((sum, row) => sum + row.clicks, 0)).toBe(15);
    expect(parsed.warnings.at(-1)).toContain("1 identical overlapping observations");
  });
  it("rejects conflicting aggregates without guessing their overlap", () => {
    expect(() => parseGscWorkbookImport({ files: [tv, file("conflict", "tv,https://example.com/tv,11,100,11%,8")] }))
      .toThrow("different metrics");
  });
  it("rejects mixed export periods", () => {
    expect(() => parseGscWorkbookImport({ files: [tv, { ...oven, dateRangeEnd: "2026-09-08" }] })).toThrow("same export period");
  });
  it("rejects all-device totals overlapping per-device observations", () => {
    expect(() => parseGscWorkbookImport({ files: [tv, { ...tv, device: "mobile" }] })).toThrow("All-device totals");
  });
  it("preserves distinct device observations", () => {
    const parsed = parseGscWorkbookImport({ files: [{ ...tv, device: "mobile" }, { ...tv, device: "tablet" }] });
    expect(parsed.device).toBe("mixed");
    expect(parsed.rows).toHaveLength(2);
  });
  it("rejects query totals mixed with query-page detail", () => {
    expect(() => parseGscWorkbookImport({ files: [tv, file("query-total", "tv,,10,100,10%,8")] })).toThrow("query totals");
  });
  it.each([[], Array(11).fill(tv), [{ files: [tv] }], [tv, { ...oven, csvText: "invalid" }]])("rejects invalid batches atomically", (files) => {
    expect(() => parseGscWorkbookImport({ files })).toThrow();
  });
});
