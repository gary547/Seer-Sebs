// Regression test: compute-forecasts-v2 must UPDATE scenario rows by id,
// never .upsert() on them. Upserting sends an INSERT that violates NOT NULL
// on project_id / keyword_id / scenario / calc_run_id.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("compute-forecasts-v2 flush uses update().eq('id'), not upsert", async () => {
  const src = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );

  // The flush() block must contain an update+eq('id') call.
  assert(
    /\.update\(\s*fields\s*\)\s*\.eq\(\s*"id"\s*,\s*id\s*\)/.test(src),
    "flush() must call .update(fields).eq('id', id) on keyword_forecast_scenarios",
  );

  // And it must NOT upsert onto the id conflict target — that path caused
  // 'null value in column \"project_id\"' failures in production.
  assert(
    !/keyword_forecast_scenarios[\s\S]{0,200}\.upsert\([^)]*onConflict:\s*"id"/.test(src),
    "flush() must not upsert keyword_forecast_scenarios on id",
  );

  assertEquals(true, true);
});
