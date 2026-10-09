import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabasePool, withTransaction } from "../../dist/gcp/packages/runtime/src/database.js";
import { loadStageOutput, storeStageOutput, STAGE_OUTPUT_CHUNK_BYTES } from "../../dist/gcp/packages/runtime/src/stage-output.js";
import { executeDataDrivenStage } from "../../dist/gcp/packages/pipeline/src/stage-handlers.js";
import { persistProjectStageData } from "../../dist/gcp/apps/worker/src/project-data.js";
import { PIPELINE_STAGES } from "../../dist/gcp/packages/pipeline/src/definition.js";
import { parseRepresentativeProjectFixture } from "../../dist/gcp/packages/fixtures/src/representative-project.js";

const url = new URL(process.env.SEER_STAGE_OUTPUT_DATABASE_URL ?? "postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer");
assert(["127.0.0.1", "localhost"].includes(url.hostname), "Stage-output scale tests require an isolated local database.");
const schema = `stage_output_test_${randomUUID().replaceAll("-", "")}`;
const owner = createDatabasePool(url.toString());
url.searchParams.set("options", `-c search_path=${schema},public`);
const pool = createDatabasePool(url.toString());
const runId = randomUUID();
const otherRun = randomUUID();
const hashItems = values => {
  const hash = createHash("sha256");
  for (const value of values) hash.update(JSON.stringify(value));
  return hash.digest("hex");
};
try {
  await owner.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["pipeline_stage_runs", "pipeline_stage_output_chunks", "pipeline_rollups"]) {
    await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query("CREATE TABLE effects (run_id uuid PRIMARY KEY, value integer NOT NULL)");
  await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id) VALUES ($1, 'har-v2'), ($1, 'revenue-v2'), ($2, 'har-v2')", [runId, otherRun]);
  const indexes = await pool.query("SELECT indisready, indisvalid FROM pg_index WHERE indrelid = 'pipeline_stage_output_chunks'::regclass");
  assert(indexes.rows.length > 0 && indexes.rows.every(row => row.indisready && row.indisvalid));
  await assert.rejects(pool.query("SELECT jsonb_agg(jsonb_build_object('explanation', repeat('x', 1048576))) FROM generate_series(1, 260)"),
    error => error.code === "54000" && error.message.includes("total size of jsonb array elements"));
  console.log(JSON.stringify({ phase: "original-jsonb-limit-reproduced", code: "54000", dataMiB: 260 }));

  const keywords = Array.from({ length: 260 }, (_, id) => ({ id, baseRank: null, scenarios: [{ scenario: "realistic", score: 0, explanation: { source: "scale-fixture", text: "x".repeat(1048576) } }] }));
  const original = { handlerVersion: "har-v2.1", modelVersion: "unchanged", scenarioCount: 260, keywords };
  const expected = hashItems(keywords);
  const save = async output => withTransaction(pool, async client => {
    await client.query("SET LOCAL statement_timeout = '600s'");
    await client.query("SELECT state FROM pipeline_stage_runs WHERE run_id = $1 AND stage_id = 'har-v2' FOR UPDATE", [runId]);
    const stored = await storeStageOutput(client, runId, "har-v2", output);
    await client.query("UPDATE pipeline_stage_runs SET output = $2, state = 'succeeded' WHERE run_id = $1 AND stage_id = 'har-v2'", [runId, JSON.stringify(stored)]);
    return stored;
  });
  const stored = await save(original);
  assert(Buffer.byteLength(JSON.stringify(stored)) < 2048);
  let restored = await loadStageOutput(pool, runId, "har-v2", stored);
  assert.equal(restored.keywords.length, 260);
  assert.equal(hashItems(restored.keywords), expected);
  assert.equal(restored.keywords[0].scenarios[0].score, 0);
  assert.equal(restored.keywords[0].baseRank, null);
  restored = null;
  const chunks = await pool.query("SELECT count(*)::int AS count, max(octet_length(payload)) AS max_bytes FROM pipeline_stage_output_chunks WHERE run_id = $1", [runId]);
  assert(chunks.rows[0].max_bytes <= STAGE_OUTPUT_CHUNK_BYTES);
  const plan = (await pool.query("EXPLAIN (ANALYZE, FORMAT JSON) SELECT chunk_index, payload FROM pipeline_stage_output_chunks WHERE run_id = $1 AND stage_id = 'har-v2' AND field_name = 'keywords' AND chunk_index >= 0 ORDER BY chunk_index LIMIT 2", [runId])).rows[0]["QUERY PLAN"];
  assert(JSON.stringify(plan).includes("Index"));
  await save(original);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM pipeline_stage_output_chunks WHERE run_id = $1", [runId])).rows[0].count, chunks.rows[0].count);
  await assert.rejects(loadStageOutput(pool, otherRun, "har-v2", stored), { code: "pipeline_output_storage_failed" });
  await assert.rejects(loadStageOutput(pool, runId, "revenue-v2", stored), { code: "pipeline_output_storage_failed" });
  await assert.rejects(withTransaction(pool, async client => {
    await client.query("INSERT INTO effects VALUES ($1, 1)", [runId]);
    await storeStageOutput(client, runId, "har-v2", { stageOutputStorage: {} });
  }), { code: "pipeline_output_storage_failed" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM effects")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM pipeline_stage_output_chunks WHERE run_id = $1", [runId])).rows[0].count, chunks.rows[0].count);
  await pool.query("DELETE FROM pipeline_stage_output_chunks WHERE run_id = $1 AND chunk_index = 0", [runId]);
  await assert.rejects(loadStageOutput(pool, runId, "har-v2", stored), { code: "pipeline_output_storage_failed" });
  const rollupRun = randomUUID();
  const projectId = randomUUID();
  await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id) VALUES ($1, 'rollup-output')", [rollupRun]);
  const clusterRollup = Array.from({ length: 107926 }, (_, index) => ({
    canonicalKeywordId: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    clusterKey: `canonical keyword ${index} ${"🧪".repeat(20)}`,
    expectedIncrementalAnnual: 0,
    memberCount: 1,
  }));
  const rollup = { handlerVersion: "rollup-output-v1", keywords: [{ id: "unchanged", normalisedText: "unchanged" }],
    cannibalisationFlags: [], confidenceDistribution: { high: 107926, medium: 0, low: 0 },
    scenarios: ["conservative", "realistic", "stretch"].map(scenario => ({ scenario, clusterRollup,
      categoryRollup: [{ category: "Uncategorised", expectedIncrementalAnnual: 0, keywordCount: 107926 }],
      quarterRollup: [], trendRollup: [], clusterDedupedExpectedIncrementalAnnual: 0,
      naiveExpectedIncrementalAnnual: 0, doubleCountAnnual: 0 })) };
  assert(Buffer.byteLength(JSON.stringify(rollup.scenarios[0])) > STAGE_OUTPUT_CHUNK_BYTES);
  const expectedRollupHash = hashItems(rollup.scenarios);
  const saveRollup = () => withTransaction(pool, async client => {
    await client.query("SET LOCAL statement_timeout = '600s'");
    await persistProjectStageData(client, projectId, rollupRun, rollup);
    const summary = await storeStageOutput(client, rollupRun, "rollup-output", rollup);
    await client.query("UPDATE pipeline_stage_runs SET state='succeeded', output=$2 WHERE run_id=$1 AND stage_id='rollup-output'", [rollupRun, JSON.stringify(summary)]);
    return summary;
  });
  const rollupSummary = await saveRollup();
  assert.equal(rollupSummary.stageOutputStorage.version, 2);
  const restoredRollup = await loadStageOutput(pool, rollupRun, "rollup-output", rollupSummary);
  assert.deepEqual(restoredRollup, rollup);
  assert.equal(hashItems(restoredRollup.scenarios), expectedRollupHash);
  await saveRollup();
  const rollupRows = await pool.query("SELECT scenario, cluster_deduped_expected_incremental_annual, jsonb_array_length(cluster_rollup) AS clusters FROM pipeline_rollups WHERE pipeline_run_id=$1 ORDER BY scenario", [rollupRun]);
  assert.equal(rollupRows.rows.length, 3);
  assert(rollupRows.rows.every(row => row.clusters === 107926 && Number(row.cluster_deduped_expected_incremental_annual) === 0));
  const fragmentRows = await pool.query("SELECT count(*)::int AS count, max(octet_length(payload)) AS max_bytes FROM pipeline_stage_output_chunks WHERE run_id=$1", [rollupRun]);
  assert(fragmentRows.rows[0].max_bytes <= STAGE_OUTPUT_CHUNK_BYTES);
  await assert.rejects(loadStageOutput(pool, otherRun, "rollup-output", rollupSummary), { code: "pipeline_output_storage_failed" });
  await pool.query("DELETE FROM pipeline_stage_output_chunks WHERE run_id=$1 AND field_name='scenarios' AND chunk_index=0", [rollupRun]);
  await assert.rejects(loadStageOutput(pool, rollupRun, "rollup-output", rollupSummary), { code: "pipeline_output_storage_failed" });
  console.log(JSON.stringify({ phase: "nested-rollup-output-verified", keywords: 107926, scenarios: 3, chunks: fragmentRows.rows[0].count, maxChunkBytes: fragmentRows.rows[0].max_bytes, unchangedValues: true, replay: true, isolation: true, corruptionRejected: true }));
  const fixture = parseRepresentativeProjectFixture(JSON.parse(await readFile(new URL("../fixtures/representative-project.json", import.meta.url), "utf8")));
  const baseline = {};
  const reconstructed = {};
  const parityRun = randomUUID();
  for (const stage of PIPELINE_STAGES) {
    const dependencies = outputs => Object.fromEntries(stage.dependencies.map(id => [id, outputs[id]]));
    const expectedOutput = executeDataDrivenStage(stage.id, fixture, dependencies(baseline));
    const actualOutput = executeDataDrivenStage(stage.id, fixture, dependencies(reconstructed));
    assert.deepEqual(actualOutput, expectedOutput, `Calculation parity changed at ${stage.id}`);
    if (stage.id === "har-v2") {
      for (const output of [actualOutput, expectedOutput]) {
        for (const keyword of output.keywords) for (const scenario of keyword.scenarios) scenario.explanation.scaleFixture = "x".repeat(50_000);
      }
    }
    baseline[stage.id] = expectedOutput;
    await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id) VALUES ($1, $2)", [parityRun, stage.id]);
    const summary = await withTransaction(pool, client => storeStageOutput(client, parityRun, stage.id, actualOutput));
    if (stage.id === "har-v2") assert(summary.stageOutputStorage, "HAR-to-Revenue test must use chunked inputs.");
    reconstructed[stage.id] = await loadStageOutput(pool, parityRun, stage.id, summary);
    assert.deepEqual(reconstructed[stage.id], expectedOutput);
  }
  console.log(JSON.stringify({ phase: "chunked-stage-output-verified", dataMiB: 260, chunks: chunks.rows[0].count, maxChunkBytes: chunks.rows[0].max_bytes, lossless: true, idempotent: true, rollback: true, isolation: true, indexed: true, corruptionRejected: true }));
  console.log(JSON.stringify({ phase: "pipeline-calculation-parity-verified", stages: PIPELINE_STAGES.length, chunkedHarToRevenue: true, unchangedCalculations: true }));
} finally {
  await pool.end();
  await owner.query(`DROP SCHEMA ${schema} CASCADE`);
  await owner.end();
}
