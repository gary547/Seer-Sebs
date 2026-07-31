// Deno tests for the shared DataForSEO auth helper.
// Run via supabase--test_edge_functions or
// `deno test supabase/functions/_shared/dataforseo.test.ts`.

import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildBasicAuth,
  computeMonthRange,
  GOOGLE_ADS_LAG_MONTHS,
  parseStatusMonth,
  previousMonthStart,
  resolveStatusDrivenDateTo,
} from "./dataforseo.ts";

Deno.test("buildBasicAuth base64-encodes raw login:password secrets", () => {
  const raw = "login:password";
  assertEquals(buildBasicAuth(raw), btoa(raw));
});

Deno.test("buildBasicAuth returns already-base64 secrets unchanged", () => {
  const encoded = "alreadyBase64TextWithoutColon";
  assertEquals(buildBasicAuth(encoded), encoded);
});

Deno.test("buildBasicAuth matches keyword-enrichment inline behaviour", () => {
  const inline = (secret: string) =>
    secret.includes(":") ? btoa(secret) : secret;
  for (const s of ["a:b", "user:pass:extra", "nocolon", "YWxyZWFkeQ=="]) {
    assertEquals(buildBasicAuth(s), inline(s));
  }
});

Deno.test("GOOGLE_ADS_LAG_MONTHS is 2 (Google Ads finalisation lag)", () => {
  assertEquals(GOOGLE_ADS_LAG_MONTHS, 2);
});

Deno.test("computeMonthRange default 24 months lag-adjusted (2026-07-08)", () => {
  const r = computeMonthRange(24, new Date(Date.UTC(2026, 6, 8))); // 2026-07-08
  assertEquals(r.requested_months, 24);
  // date_to = July - 2 = May 2026
  assertEquals(r.date_to, "2026-05-01");
  // date_from = May 2026 minus 23 months = June 2024
  assertEquals(r.date_from, "2024-06-01");
});

Deno.test("computeMonthRange 12-month window lag-adjusted", () => {
  const r = computeMonthRange(12, new Date(Date.UTC(2026, 6, 8))); // 2026-07-08
  assertEquals(r.date_to, "2026-05-01");
  assertEquals(r.date_from, "2025-06-01");
});

Deno.test("computeMonthRange clamps requestedMonths to [1,48]", () => {
  const hi = computeMonthRange(999, new Date(Date.UTC(2026, 6, 8)));
  assertEquals(hi.requested_months, 48);
  assertEquals(hi.date_to, "2026-05-01");
  assertEquals(hi.date_from, "2022-06-01");

  const lo = computeMonthRange(0, new Date(Date.UTC(2026, 6, 8)));
  assertEquals(lo.requested_months, 1);
  assertEquals(lo.date_to, "2026-05-01");
  assertEquals(lo.date_from, "2026-05-01");
});

Deno.test("computeMonthRange handles year rollover with lag", () => {
  // 2026-01-15 → lag 2 → date_to = 2025-11
  const r = computeMonthRange(24, new Date(Date.UTC(2026, 0, 15)));
  assertEquals(r.date_to, "2025-11-01");
  assertEquals(r.date_from, "2023-12-01");
});

Deno.test("previousMonthStart handles mid-year and year rollover", () => {
  assertEquals(previousMonthStart("2026-07-01"), "2026-06-01");
  assertEquals(previousMonthStart("2026-01-01"), "2025-12-01");
});

Deno.test("parseStatusMonth reads {year, month}", () => {
  assertEquals(parseStatusMonth({ year: 2026, month: 5 }), "2026-05-01");
});

Deno.test("parseStatusMonth reads latest_available_month as YYYY-MM", () => {
  assertEquals(parseStatusMonth({ latest_available_month: "2026-05" }), "2026-05-01");
});

Deno.test("parseStatusMonth reads latest_available_month as ISO timestamp", () => {
  assertEquals(
    parseStatusMonth({ latest_available_month: "2026-05-15 00:00:00 +00:00" }),
    "2026-05-01",
  );
});

Deno.test("parseStatusMonth reads legacy date fields", () => {
  assertEquals(parseStatusMonth({ date: "2026-05-01" }), "2026-05-01");
  assertEquals(parseStatusMonth({ last_updated: "2026-05-31T12:00:00Z" }), "2026-05-01");
});

Deno.test("parseStatusMonth traverses nested google_ads_data", () => {
  assertEquals(
    parseStatusMonth({ google_ads_data: { latest_available_month: "2026-05" } }),
    "2026-05-01",
  );
  assertEquals(
    parseStatusMonth({ search_partners_data: { year: 2026, month: 4 } }),
    "2026-04-01",
  );
});

Deno.test("parseStatusMonth reads the live DataForSEO Google Ads Status payload", () => {
  assertEquals(
    parseStatusMonth({
      actual_data: false,
      date_update: "2026-06-11",
      last_year_in_monthly_searches: 2026,
      last_month_in_monthly_searches: 5,
    }),
    "2026-05-01",
  );
});

Deno.test("parseStatusMonth prefers last_*_in_monthly_searches over {year, month}", () => {
  assertEquals(
    parseStatusMonth({
      year: 2020, month: 1,
      last_year_in_monthly_searches: 2026,
      last_month_in_monthly_searches: 5,
    }),
    "2026-05-01",
  );
});

Deno.test("parseStatusMonth falls back to date_update when no pair or tuple is present", () => {
  assertEquals(
    parseStatusMonth({ actual_data: false, date_update: "2026-06-11" }),
    "2026-06-01",
  );
});

Deno.test("parseStatusMonth returns null when no recognised field", () => {
  assertEquals(parseStatusMonth({ foo: "bar", location_code: 2826 }), null);
  assertEquals(parseStatusMonth(null), null);
});

Deno.test("resolveStatusDrivenDateTo actual_data=true within fallback ceiling", () => {
  const fallback = { date_from: "2024-06-01", date_to: "2026-05-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: true, actual_data: true, latest_finalised_month: "2026-05-01", http_status: 200, api_status_code: 20000, raw_snapshot: null },
    fallback,
  );
  assertEquals(r.source, "status_actual");
  assertEquals(r.date_to, "2026-05-01");
  assertEquals(r.date_from, "2024-06-01");
});

Deno.test("resolveStatusDrivenDateTo actual_data=false shifts to previous month", () => {
  const fallback = { date_from: "2024-06-01", date_to: "2026-05-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: true, actual_data: false, latest_finalised_month: "2026-06-01", http_status: 200, api_status_code: 20000, raw_snapshot: null },
    fallback,
  );
  // 2026-06 previous = 2026-05 which equals fallback, no cap needed.
  assertEquals(r.source, "status_previous_finalised");
  assertEquals(r.date_to, "2026-05-01");
  assertEquals(r.date_from, "2024-06-01");
});

Deno.test("resolveStatusDrivenDateTo caps status month at fallback ceiling", () => {
  const fallback = { date_from: "2024-06-01", date_to: "2026-05-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: true, actual_data: true, latest_finalised_month: "2026-07-01", http_status: 200, api_status_code: 20000, raw_snapshot: null },
    fallback,
  );
  assertEquals(r.source, "status_actual_capped");
  assertEquals(r.date_to, "2026-05-01");
  assertEquals(r.date_from, "2024-06-01");
});

Deno.test("resolveStatusDrivenDateTo year rollover on previous-finalised path", () => {
  const fallback = { date_from: "2023-12-01", date_to: "2025-11-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: true, actual_data: false, latest_finalised_month: "2026-01-01", http_status: 200, api_status_code: 20000, raw_snapshot: null },
    fallback,
  );
  // effective = 2025-12, cap ceiling 2025-11 → capped to 2025-11.
  assertEquals(r.source, "status_previous_finalised_capped");
  assertEquals(r.date_to, "2025-11-01");
  assertEquals(r.date_from, "2023-12-01");
});

Deno.test("resolveStatusDrivenDateTo falls back cleanly on !ok", () => {
  const fallback = { date_from: "2024-06-01", date_to: "2026-05-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: false, reason: "api_status_40100", http_status: 401, api_status_code: 40100, raw_snapshot: null },
    fallback,
  );
  assertEquals(r.source, "fallback_computed");
  assertEquals(r.date_to, fallback.date_to);
  assertEquals(r.date_from, fallback.date_from);
  assertEquals(r.warning, "api_status_40100");
});

Deno.test("resolveStatusDrivenDateTo source is a legal literal", () => {
  const fallback = { date_from: "2024-06-01", date_to: "2026-05-01" };
  const r = resolveStatusDrivenDateTo(
    { ok: true, actual_data: true, latest_finalised_month: "2026-04-01", http_status: 200, api_status_code: 20000, raw_snapshot: null },
    fallback,
  );
  // Earlier than fallback: no cap; window shifts back.
  assertEquals(r.source, "status_actual");
  assertEquals(r.date_to, "2026-04-01");
  assertEquals(r.date_from, "2024-05-01");
  assert(typeof r.source === "string");
});
