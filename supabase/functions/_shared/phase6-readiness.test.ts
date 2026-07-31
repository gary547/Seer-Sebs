import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  classifyReadiness,
  DEFAULT_READINESS_THRESHOLDS,
  type CoverageSummary,
} from "./phase6-readiness.ts";

const base: CoverageSummary = {
  keywords_with_history: 0,
  kept_keywords_total: 0,
  min_months: 0,
  median_months: 0,
  max_months: 0,
  percent_keywords_at_or_above_24_months: 0,
  percent_keywords_at_or_above_12_months: 0,
};

Deno.test("no history -> no_history", () => {
  const r = classifyReadiness({ ...base });
  assertEquals(r.status, "no_history");
  assertEquals(r.thresholds_used, DEFAULT_READINESS_THRESHOLDS);
});

Deno.test("100% at 12mo, 0% at 24mo -> fallback_12_month", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 10,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 100,
    percent_keywords_at_or_above_24_months: 0,
  });
  assertEquals(r.status, "fallback_12_month");
});

Deno.test("50% at 24mo -> partial_24_month", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 10,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 100,
    percent_keywords_at_or_above_24_months: 50,
  });
  assertEquals(r.status, "partial_24_month");
});

Deno.test("80% at 24mo -> ready_24_month", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 10,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 100,
    percent_keywords_at_or_above_24_months: 80,
  });
  assertEquals(r.status, "ready_24_month");
});

Deno.test("boundary: 40% at 24mo -> partial", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 5,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 60,
    percent_keywords_at_or_above_24_months: 40,
  });
  assertEquals(r.status, "partial_24_month");
});

Deno.test("boundary: 39.99% at 24mo, 50% at 12mo -> fallback", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 5,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 50,
    percent_keywords_at_or_above_24_months: 39.99,
  });
  assertEquals(r.status, "fallback_12_month");
});

Deno.test("below all thresholds but some history -> no_history", () => {
  const r = classifyReadiness({
    ...base,
    keywords_with_history: 3,
    kept_keywords_total: 10,
    percent_keywords_at_or_above_12_months: 30,
    percent_keywords_at_or_above_24_months: 10,
  });
  assertEquals(r.status, "no_history");
});
