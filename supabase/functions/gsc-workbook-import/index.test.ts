// Tests for gsc-workbook-import pure helpers + sheet extractors.
// Runs under Deno (see supabase/functions/**/*_test.ts convention).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5?target=deno";
import {
  extractPages,
  extractQueries,
  extractQueriesFromCsv,
  normaliseDevice,
  parseCsvRows,
  parseCtr,
  parseInteger,
  parseNumber,
} from "./index.ts";

Deno.test("parseNumber — thousands separators", () => {
  assertEquals(parseNumber("2,074"), 2074);
  assertEquals(parseNumber("1,234,567"), 1234567);
  assertEquals(parseNumber('"2,074"'.replace(/"/g, "")), 2074);
});

Deno.test("parseNumber — comma decimal", () => {
  assertEquals(parseNumber("12,5"), 12.5);
  assertEquals(parseNumber("3,7"), 3.7);
});

Deno.test("parseNumber — plain forms", () => {
  assertEquals(parseNumber(1234.5), 1234.5);
  assertEquals(parseNumber("1234.5"), 1234.5);
  assertEquals(parseNumber(""), 0);
  assertEquals(parseNumber(null), 0);
});

Deno.test("parseInteger — rounds parsed number", () => {
  assertEquals(parseInteger("2,074"), 2074);
  assertEquals(parseInteger("2,074.6"), 2075);
});

Deno.test("parseCtr — percent, decimal, and >1 heuristic", () => {
  assertEquals(parseCtr("34.5%"), 0.345);
  assertEquals(parseCtr("0.345"), 0.345);
  assertEquals(parseCtr(34.5), 0.345);
  assertEquals(parseCtr(0.345), 0.345);
  assertEquals(parseCtr("34,5%"), 0.345);
  assertEquals(parseCtr(""), 0);
  assertEquals(parseCtr("200%"), 1); // clamp upper
});

Deno.test("normaliseDevice — mapping", () => {
  assertEquals(normaliseDevice("DESKTOP"), "desktop");
  assertEquals(normaliseDevice("desktop"), "desktop");
  assertEquals(normaliseDevice("Mobile"), "mobile");
  // Tablet is folded into desktop as standard GSC-modelling practice.
  assertEquals(normaliseDevice("TABLET"), "desktop");
  assertEquals(normaliseDevice("foo"), null);
  assertEquals(normaliseDevice(""), null);
  assertEquals(normaliseDevice(null), null);
});

function sheet(aoa: unknown[][]) {
  return XLSX.utils.aoa_to_sheet(aoa);
}

Deno.test("extractQueries — legacy sheet (no Device column) parses as before", () => {
  const ws = sheet([
    ["Top queries", "Clicks", "Impressions", "CTR", "Position"],
    ["red widgets", "2,074", "10,500", "19.75%", "3.4"],
    ["blue widgets", 500, 2000, 0.25, 5.1],
  ]);
  const res = extractQueries(ws);
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.hasDeviceColumn, false);
  assertEquals(res.rows.length, 2);
  assertEquals(res.rows[0], {
    keyword: "red widgets",
    clicks: 2074,
    impressions: 10500,
    ctr: 0.1975,
    position: 3.4,
    device: null,
  });
  assertEquals(res.rows[1].ctr, 0.25);
});

Deno.test("extractQueries — Device column present marks hasDeviceColumn + normalises rows", () => {
  const ws = sheet([
    ["Query", "Clicks", "Impressions", "CTR", "Position", "Device"],
    ["red widgets", "1,000", "5,000", "20%", "2,3", "DESKTOP"],
    ["blue widgets", 200, 1000, "0.2", 4.5, "MOBILE"],
    ["green widgets", 50, 500, "10%", 8, "TABLET"],
    ["pink widgets", 10, 100, "10%", 12, "watch"], // unknown → null, still inserted
  ]);
  const res = extractQueries(ws);
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.hasDeviceColumn, true);
  assertEquals(res.rows.length, 4);
  assertEquals(res.rows[0].device, "desktop");
  assertEquals(res.rows[0].position, 2.3); // comma decimal in Position
  assertEquals(res.rows[1].device, "mobile");
  assertEquals(res.rows[2].device, "desktop"); // tablet folded
  assertEquals(res.rows[3].device, null); // unknown string
});

Deno.test("extractPages — Device column propagates", () => {
  const ws = sheet([
    ["Top pages", "Clicks", "Impressions", "CTR", "Position", "Device"],
    ["https://x.test/a", "1,234", "9,876", "12.5%", "4.2", "MOBILE"],
    ["https://x.test/b", 10, 100, 0.1, 8, "TABLET"],
  ]);
  const res = extractPages(ws);
  if ("skipped" in res) throw new Error(res.skipped);
  assertEquals(res.hasDeviceColumn, true);
  assertEquals(res.rows.length, 2);
  assertEquals(res.rows[0].clicks, 1234);
  assertEquals(res.rows[0].ctr, 0.125);
  assertEquals(res.rows[0].device, "mobile");
  assertEquals(res.rows[1].device, "desktop");
});

Deno.test("parseCsvRows — respects quoted commas", () => {
  const grid = parseCsvRows('Query,Clicks,Position\n"red, big widgets","2,074",3.4\n');
  assertEquals(grid.length, 2);
  assertEquals(grid[1][0], "red, big widgets");
  assertEquals(grid[1][1], "2,074");
});

Deno.test("extractQueriesFromCsv — per-row device + thousands + percent CTR", () => {
  const csv =
    "Query,Clicks,Impressions,CTR,Position,Device\n" +
    'red widgets,"2,074","10,500",19.75%,3.4,DESKTOP\n' +
    "red widgets,500,3000,16%,4.1,MOBILE\n" +
    "blue widgets,10,100,10%,8,TABLET\n";
  const res = extractQueriesFromCsv(csv);
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.hasDeviceColumn, true);
  // NO dedupe — same keyword across devices yields 2 rows.
  assertEquals(res.rows.length, 3);
  assertEquals(res.rows[0].clicks, 2074);
  assertEquals(res.rows[0].impressions, 10500);
  assertEquals(res.rows[0].ctr, 0.1975);
  assertEquals(res.rows[0].device, "desktop");
  assertEquals(res.rows[1].device, "mobile");
  assertEquals(res.rows[1].keyword, "red widgets");
  assertEquals(res.rows[2].device, "desktop"); // tablet folded
});

Deno.test("extractQueriesFromCsv — legacy CSV without Device column", () => {
  const csv = "Query,Clicks,Impressions,CTR,Position\nred,10,100,10%,5\n";
  const res = extractQueriesFromCsv(csv);
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.hasDeviceColumn, false);
  assertEquals(res.rows[0].device, null);
});

Deno.test("extractQueriesFromCsv — missing required columns rejected", () => {
  const csv = "Foo,Bar\n1,2\n";
  const res = extractQueriesFromCsv(csv);
  assertEquals("error" in res, true);
});
