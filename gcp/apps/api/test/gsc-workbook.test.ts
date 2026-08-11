import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  parseCsvRows,
  parseGscWorkbookImport,
  parseNumber,
} from "../src/gsc-workbook.js";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function column(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function worksheet(rows: Array<Array<string | number>>): string {
  const body = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((value, columnIndex) => {
            const reference = `${column(columnIndex)}${rowIndex + 1}`;
            return typeof value === "number"
              ? `<c r="${reference}"><v>${value}</v></c>`
              : `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function workbookBase64(): string {
  const workbook =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Chart" sheetId="1" r:id="rId1"/><sheet name="Queries" sheetId="2" r:id="rId2"/><sheet name="Pages" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const relationships =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`;
  const archive = zipSync({
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(relationships),
    "xl/worksheets/sheet1.xml": strToU8(
      worksheet([
        ["Date", "Clicks"],
        ["2026-01-01", 1],
        ["2026-04-01", 2],
      ]),
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      worksheet([
        ["Top queries", "Clicks", "Impressions", "CTR", "Position", "Device"],
        ["television offers", 25, 1000, "2.5%", 8.2, "mobile"],
      ]),
    ),
    "xl/worksheets/sheet3.xml": strToU8(
      worksheet([
        ["Top pages", "Clicks", "Impressions", "CTR", "Position", "Device"],
        ["https://example.com/tv", 20, 800, "2.5%", 6.4, "desktop"],
      ]),
    ),
  });
  return Buffer.from(archive).toString("base64");
}

describe("GSC workbook parsing", () => {
  it("parses quoted CSV values and locale-formatted numbers", () => {
    expect(parseCsvRows('Query,Clicks\n"tv, offers","2,074"\n')).toEqual([
      ["Query", "Clicks"],
      ["tv, offers", "2,074"],
    ]);
    expect(parseNumber("2,074")).toBe(2074);
    expect(parseNumber("3,7")).toBe(3.7);
  });

  it("normalises a Search Console CSV import", () => {
    const parsed = parseGscWorkbookImport({
      csvText:
        "Query,Clicks,Impressions,CTR,Position\ntelevision offers,25,1000,2.5%,8.2",
      dateRangeEnd: "2026-04-01",
      dateRangeStart: "2026-01-01",
      device: "mobile",
      filename: "queries.csv",
      format: "csv_text",
    });

    expect(parsed.sourceName).toBe("gsc_csv_v2");
    expect(parsed.device).toBe("mobile");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        clicks: 25,
        ctr: 0.025,
        device: "mobile",
        query: "television offers",
      }),
    ]);
  });

  it("skips oversized SAFS queries without rejecting the complete import", () => {
    const parsed = parseGscWorkbookImport({
      csvText: [
        "Query,Clicks,Impressions,CTR,Position",
        "television offers,25,1000,2.5%,8.2",
        `${"x".repeat(201)},1,10,10%,20`,
      ].join("\n"),
      dateRangeEnd: "2026-04-01",
      dateRangeStart: "2026-01-01",
      device: "mobile",
      filename: "Pilltime SAFS Export.csv",
      format: "csv_text",
    });

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.query).toBe("television offers");
    expect(parsed.warnings).toContain(
      "1 query was skipped because it exceeded 200 characters.",
    );
  });

  it("parses Chart, Queries and Pages from an XLSX archive", () => {
    const parsed = parseGscWorkbookImport({
      fileBase64: workbookBase64(),
      filename: "search-console.xlsx",
      format: "xlsx_base64",
    });

    expect(parsed.dateRangeStart).toBe("2026-01-01");
    expect(parsed.dateRangeEnd).toBe("2026-04-01");
    expect(parsed.device).toBe("mixed");
    expect(parsed.rows[0]).toMatchObject({
      device: "mobile",
      impressions: 1000,
      position: 8.2,
      query: "television offers",
    });
    expect(parsed.pages[0]).toMatchObject({
      device: "desktop",
      pageUrl: "https://example.com/tv",
    });
  });
});
