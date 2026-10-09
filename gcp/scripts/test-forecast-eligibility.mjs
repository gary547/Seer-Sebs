import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabasePool, withTransaction } from "../../dist/gcp/packages/runtime/src/database.js";
import { PIPELINE_STAGES } from "../../dist/gcp/packages/pipeline/src/definition.js";
import { parseRepresentativeProjectFixture } from "../../dist/gcp/packages/fixtures/src/representative-project.js";
import { executeDataDrivenStage } from "../../dist/gcp/packages/pipeline/src/stage-handlers.js";
import { executeStageTask } from "../../dist/gcp/apps/worker/src/processor.js";
import { persistForecastExclusions, loadForecastExclusions } from "../../dist/gcp/apps/worker/src/forecast-eligibility.js";

const url = new URL(process.env.SEER_CHECKPOINT_DATABASE_URL ?? "postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer");
assert(["127.0.0.1", "localhost"].includes(url.hostname), "Eligibility integration requires a local database.");
const owner = createDatabasePool(url.toString());
const schema = `eligibility_test_${randomUUID().replaceAll("-", "")}`;
url.searchParams.set("options", `-c search_path=${schema},public`);
const pool = createDatabasePool(url.toString());
const runId = randomUUID();
try {
  await owner.query(`CREATE SCHEMA ${schema}`);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO seer_worker`);
  for (const table of ["pipeline_runs", "pipeline_stage_runs", "pipeline_stage_output_chunks", "pipeline_forecast_exclusions", "outbox_events", "provider_work_items"]) {
    await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query("GRANT SELECT, UPDATE ON pipeline_runs, pipeline_stage_runs TO seer_worker");
  await pool.query("GRANT SELECT, INSERT ON pipeline_forecast_exclusions TO seer_worker");
  await pool.query("GRANT SELECT, INSERT, DELETE ON pipeline_stage_output_chunks TO seer_worker");
  await pool.query("GRANT INSERT ON outbox_events TO seer_worker");
  await pool.query("GRANT USAGE ON SEQUENCE public.outbox_events_id_seq TO seer_worker");
  const raw = JSON.parse(await readFile(new URL("../fixtures/representative-project.json", import.meta.url), "utf8"));
  const fixture = parseRepresentativeProjectFixture(raw);
  const outputs = {};
  for (const stage of PIPELINE_STAGES.slice(0, 18)) outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, outputs);
  const enrichment = outputs["keyword-enrichment"];
  Object.assign(enrichment.keywords[0].enrichment, { avgMonthlyVolume: null, competitiveEligible: false, competitiveEligibilityReason: "missing_volume" });
  const search = outputs["serp-collection"].keywords.find(row => row.id === enrichment.keywords[1].id);
  Object.assign(search, { status: "no-result", results: [], features: ["ai_overview"] });
  await pool.query("INSERT INTO pipeline_runs (id, user_id, input) VALUES ($1, $2, $3)", [runId, randomUUID(), JSON.stringify({ fixture: raw, forecastEligibilityPolicy: "automatic-v1", generation: 4, recoveredStageCount: 18 })]);
  for (const stage of PIPELINE_STAGES) await pool.query(
    "INSERT INTO pipeline_stage_runs (run_id, stage_id, state, output, attempts) VALUES ($1, $2, $3, $4, $5)",
    [runId, stage.id, outputs[stage.id] ? "succeeded" : "pending", outputs[stage.id] ? JSON.stringify(outputs[stage.id]) : null, outputs[stage.id] ? 3 : 0]);
  const checkpoint = () => pool.query("SELECT stage_id, output, attempts, started_at, completed_at FROM pipeline_stage_runs WHERE run_id = $1 AND stage_id = ANY($2) ORDER BY stage_id", [runId, PIPELINE_STAGES.slice(0, 18).map(stage => stage.id)]);
  const before = (await checkpoint()).rows;
  const workerPool = { query: async (...args) => { const client = await pool.connect(); try { await client.query("SET ROLE seer_worker"); return await client.query(...args); } finally { client.release(true); } },
    connect: async () => { const client = await pool.connect(); await client.query("SET ROLE seer_worker"); return { query: (...args) => client.query(...args), release: () => client.release(true) }; } };
  for (const stage of PIPELINE_STAGES.slice(18)) {
    const response = await executeStageTask(workerPool, { runId, stageId: stage.id, generation: 4, taskId: randomUUID() });
    assert.equal(response.status, "succeeded");
  }
  assert.deepEqual((await checkpoint()).rows, before, "All 18 saved stages remain byte-for-byte unchanged.");
  const run = (await pool.query("SELECT status, input FROM pipeline_runs WHERE id = $1", [runId])).rows[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.input.forecastEligibility.excludedKeywordCount, 2);
  assert.equal(run.input.forecastEligibility.calculatedKeywordCount, enrichment.keywords.length - 2);
  const exclusions = await loadForecastExclusions(pool, runId);
  assert.equal(exclusions.length, 2);
  await withTransaction(pool, client => persistForecastExclusions(client, runId, [...exclusions].reverse()));
  await assert.rejects(withTransaction(pool, client => persistForecastExclusions(client, runId, [{ ...exclusions[0], reason: "no_organic_results" }, exclusions[1]])), /differs/);
  assert.deepEqual(await loadForecastExclusions(pool, runId), exclusions);
  assert.deepEqual(await loadForecastExclusions(pool, randomUUID()), []);
  const revenue = (await pool.query("SELECT output FROM pipeline_stage_runs WHERE run_id = $1 AND stage_id = 'revenue-v2'", [runId])).rows[0].output;
  assert.equal(revenue.keywords.length, enrichment.keywords.length - 2);
  assert(revenue.keywords.every(keyword => keyword.scenarios.every(row => Number.isFinite(row.expectedIncrementalAnnual))));
  const delivered = await executeStageTask(workerPool, { runId, stageId: "har-readiness", generation: 4, taskId: randomUUID() });
  assert.equal(delivered.idempotent, true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM outbox_events")).rows[0].count, 6);
  console.log(JSON.stringify({ automaticEligibility: "passed", savedStagesPreserved: 18, succeededStages: 24, exclusions: 2, realWorkerRole: true }));
} finally {
  await pool.end();
  await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await owner.end();
}
