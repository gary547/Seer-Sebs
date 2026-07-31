import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CALC_RUN_SUCCESS_STATUS } from "../_shared/calc-run-registry.ts";

Deno.test("Demand Signals uses calc_run_registry database success status", async () => {
  assertEquals(CALC_RUN_SUCCESS_STATUS, "succeeded");

  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(source.includes("CALC_RUN_SUCCESS_STATUS"));
  assert(!source.includes('"completed"'));
});
