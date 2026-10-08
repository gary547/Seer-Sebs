import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createDatabasePool, withTransaction } from "../../dist/gcp/packages/runtime/src/database.js";
import { PIPELINE_STAGES } from "../../dist/gcp/packages/pipeline/src/definition.js";
import { projectCheckpoint, recoverPipelineRun } from "../../dist/gcp/apps/api/src/pipeline-recovery.js";
import { DataForSeoClient, LivePipelineProviderHydrator } from "../../dist/gcp/apps/worker/src/live-providers.js";
import { executeStageTask, failPipelineRun } from "../../dist/gcp/apps/worker/src/processor.js";
import { OpenRouterPipelineClient, OPENROUTER_MODEL } from "../../dist/gcp/apps/worker/src/openrouter.js";
import { withProviderRun } from "../../dist/gcp/apps/worker/src/run-control.js";

const url = new URL(process.env.SEER_CHECKPOINT_DATABASE_URL ?? "postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Recovery regression must use a local database.");
const owner = createDatabasePool(url.toString());
const schema = `recovery_test_${randomUUID().replaceAll("-", "")}`;
url.searchParams.set("options", `-c search_path=${schema},public`);
const pool = createDatabasePool(url.toString());
const projectId = randomUUID();
const clientId = randomUUID();
const runId = randomUUID();
const duplicateId = randomUUID();
const userId = randomUUID();
const completed = new Set(["intake", "gsc-promotion", "detox", "categorisation", "preflight", "brand-classification", "keyword-enrichment", "clustering", "historical-volume", "ranking-url", "gsc-intent", "demand-signals", "ctr-curves"]);
const checkpointRows = () => pool.query("SELECT stage_id, output FROM pipeline_stage_runs WHERE run_id = $1 AND state = 'succeeded' ORDER BY stage_id", [runId]);
try {
  await owner.query(`CREATE SCHEMA ${schema}`);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO seer_api`);
  for (const table of ["pipeline_runs", "pipeline_stage_runs", "provider_work_items", "clients", "navigator_projects", "gsc_uploads", "keywords", "keyword_clusters", "project_serp_features", "local_provider_serp_keywords", "local_provider_serp_results", "local_provider_site_architecture_inputs"]) {
    await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query(`GRANT SELECT ON ${schema}.${table} TO seer_api`);
  }
  await pool.query("GRANT UPDATE ON pipeline_runs, pipeline_stage_runs TO seer_api");
  await pool.query("GRANT UPDATE (state, last_error, attempt_offset, updated_at) ON provider_work_items TO seer_api");
  await pool.query("INSERT INTO clients (id, company_name, domain) VALUES ($1, 'Recovery test', 'recovery.test')", [clientId]);
  await pool.query("INSERT INTO navigator_projects (id, client_id, project_name, country, language) VALUES ($1, $2, 'Recovery test', 'GB', 'en')", [projectId, clientId]);
  await pool.query("INSERT INTO pipeline_runs (id, user_id, status, input) VALUES ($1, $2, 'failed', $3), ($4, $2, 'failed', $3)", [runId, userId, JSON.stringify({ projectId, mode: "resume" }), duplicateId]);
  for (const stage of PIPELINE_STAGES) {
    await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id, state, output) VALUES ($1, $2, $3, $4)", [runId, stage.id, completed.has(stage.id) ? "succeeded" : "failed", JSON.stringify({ saved: stage.id, providerProgress: { completedBatches: 2 } })]);
    await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id, state, output) VALUES ($1, $2, $3, $4)", [duplicateId, stage.id, ["intake", "gsc-promotion"].includes(stage.id) ? "succeeded" : "failed", JSON.stringify({ saved: stage.id })]);
  }
  const frozen = { domain: "recovery.test", keywords: Array.from({ length: 61 }, (_, index) => ({ keyword: `frozen query ${index}`, normalised_keyword: `frozen query ${index}`, ranking_url: "https://recovery.test/original" })) };
  await pool.query(`INSERT INTO provider_work_items (pipeline_run_id, project_id, stage_id, item_key, provider, state, provider_task_id, attempt_count, result)
    VALUES ($1, $2, 'detox', 'completed-batch', 'openrouter', 'succeeded', NULL, 2, '{"items":[{"index":0}]}'),
           ($1, $2, 'site-architecture', 'content-fit-inputs-v1', 'input_snapshot', 'succeeded', NULL, 0, $3),
           ($1, $2, 'site-architecture', 'remaining-batch', 'openrouter', 'pending', NULL, 30, NULL),
           ($1, $2, 'serp-collection', 'empty query', 'dataforseo', 'submitted', 'task-empty', 1, NULL),
           ($1, $2, 'serp-collection', 'found query', 'dataforseo', 'submitted', 'task-found', 1, NULL)`, [runId, projectId, JSON.stringify(frozen)]);
  const before = (await checkpointRows()).rows;
  const checkpoint = await withTransaction(pool, client => projectCheckpoint(client, projectId));
  const blocker = await pool.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`${runId}:serp-collection`]);
  await assert.rejects(withTransaction(pool, client => recoverPipelineRun(client, projectId, checkpoint, runId)), { code: "pipeline_still_stopping" });
  blocker.release(true);
  const recovered = await withTransaction(pool, async client => {
    await client.query("SET LOCAL ROLE seer_api");
    return recoverPipelineRun(client, projectId, checkpoint);
  });
  assert.equal(recovered.id, runId, "Prefer the original's 13 completed stages over the duplicate's two.");
  assert.equal(recovered.generation, 1);
  assert.equal(recovered.recoveredStageCount, 13);
  assert.deepEqual((await checkpointRows()).rows, before, "Completed output must remain immutable.");
  const saved = (await pool.query("SELECT * FROM provider_work_items WHERE pipeline_run_id = $1", [runId])).rows;
  assert.deepEqual(saved.find(item => item.provider === "input_snapshot").result, frozen);
  assert.equal(saved.find(item => item.item_key === "remaining-batch").attempt_count, 30);
  assert.equal(saved.find(item => item.item_key === "remaining-batch").attempt_offset, 30);
  assert.equal(saved.find(item => item.item_key === "completed-batch").attempt_offset, 0);
  assert.deepEqual(saved.filter(item => item.provider_task_id).map(item => item.provider_task_id).sort(), ["task-empty", "task-found"]);
  const provider = { hydrate: async () => { throw new Error("A stale delivery must never call a provider"); } };
  await assert.rejects(executeStageTask(pool, { runId, stageId: "serp-collection", taskId: "stale", generation: 0 }, { providerHydrator: provider }), { code: "pipeline_stopped" });
  assert.equal((await failPipelineRun(pool, { runId, stageId: "detox", reason: "stale failure", generation: 0 })).idempotent, true);
  assert.equal((await pool.query("SELECT status FROM pipeline_runs WHERE id = $1", [runId])).rows[0].status, "pending");

  await pool.query("UPDATE pipeline_stage_runs SET state = 'running' WHERE run_id = $1 AND stage_id = 'site-architecture'", [runId]);
  let aiCalls = 0;
  let bothStarted;
  let stopCommitted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  const stopped = new Promise(resolve => { stopCommitted = resolve; });
  const aiFetch = async (_endpoint, init) => {
    const call = ++aiCalls;
    const inputs = JSON.parse(JSON.parse(init.body).messages[1].content).items;
    if (call === 2) bothStarted();
    if (call <= 2) await started;
    if (call === 1) {
      await pool.query("UPDATE pipeline_runs SET status = 'failed', input = input || jsonb_build_object('stopRequestedAt', now()) WHERE id = $1", [runId]);
      await pool.query("UPDATE pipeline_stage_runs SET state = 'failed', output = output || jsonb_build_object('reason', 'pipeline_cancelled', 'message', 'Stopped by operator.') WHERE run_id = $1 AND stage_id = 'site-architecture'", [runId]);
      stopCommitted();
    }
    if (call <= 2) await stopped;
    return Response.json({ model: OPENROUTER_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      items: inputs.map(({ index }) => ({ index, relevancyScore: 75, contentStatus: "green", tacticalStatus: "no_action_needed" })),
    }) } }] });
  };
  const aiHydrator = new LivePipelineProviderHydrator({}, {}, new OpenRouterPipelineClient("test-only", aiFetch, async () => {}, 2));
  await assert.rejects(withProviderRun(pool, runId, 1, () => aiHydrator.hydrate(pool, projectId, runId, "site-architecture")), { code: "pipeline_stopped" });
  assert.equal(aiCalls, 2);
  const stoppedProgress = (await pool.query("SELECT output FROM pipeline_stage_runs WHERE run_id = $1 AND stage_id = 'site-architecture'", [runId])).rows[0].output;
  assert.equal(stoppedProgress.message, "Stopped by operator.");
  assert.equal(stoppedProgress.providerProgress.completedBatches, 2);
  assert.equal(stoppedProgress.providerProgress.activeBatches, 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM provider_work_items WHERE pipeline_run_id = $1 AND stage_id = 'site-architecture' AND provider = 'openrouter' AND state = 'succeeded'", [runId])).rows[0].count), 2, "In-flight AI batches must survive stopping in PostgreSQL.");
  const resumed = await withTransaction(pool, client => recoverPipelineRun(client, projectId, checkpoint, runId));
  assert.equal(resumed.generation, 2);
  await pool.query("UPDATE pipeline_stage_runs SET state = 'running' WHERE run_id = $1 AND stage_id = 'site-architecture'", [runId]);
  await withProviderRun(pool, runId, 2, () => aiHydrator.hydrate(pool, projectId, runId, "site-architecture"));
  assert.equal(aiCalls, 4, "Only two missing AI batches may be requested after resume.");
  assert.equal(Number((await pool.query("SELECT count(*) FROM local_provider_site_architecture_inputs WHERE project_id = $1", [projectId])).rows[0].count), 61);
  assert.deepEqual((await checkpointRows()).rows, before);

  for (const query of ["empty query", "found query"]) {
    const keywordId = randomUUID();
    await pool.query("INSERT INTO keywords (id, project_id, keyword, normalised_keyword, detox_status) VALUES ($1, $2, $3, $3, 'keep')", [keywordId, projectId, query]);
    await pool.query("INSERT INTO keyword_clusters (project_id, pipeline_run_id, cluster_key, canonical_keyword_id, canonical_basis, member_count) VALUES ($1, $2, $3, $4, 'alphabetical', 1)", [projectId, runId, query, keywordId]);
  }
  await pool.query("UPDATE pipeline_stage_runs SET state = 'running' WHERE run_id = $1 AND stage_id = 'serp-collection'", [runId]);
  const calls = [];
  const fetcher = async (endpoint, init) => {
    assert.equal(init.body, undefined, "Submitted tasks must be collected through GET.");
    calls.push(String(endpoint));
    if (String(endpoint).endsWith("tasks_ready")) return Response.json({ status_code: 20000, tasks: [{ result: [{ id: "task-empty" }, { id: "task-found" }] }] });
    return Response.json({ status_code: 20000, tasks: [{ status_code: String(endpoint).endsWith("task-empty") ? 40102 : 20000,
      result: [{ items: [{ type: "organic", rank_absolute: 1, domain: "competitor.test", url: "https://competitor.test/page" }] }] }] });
  };
  const hydrator = new LivePipelineProviderHydrator(new DataForSeoClient("test-only", fetcher), {}, {});
  await assert.rejects(withProviderRun(pool, runId, 2, () => hydrator.hydrate(pool, projectId, runId, "serp-collection")), { code: "dataforseo_no_search_results", statusCode: 422 });
  const terminal = (await pool.query("SELECT item_key, provider_task_id, state, result FROM provider_work_items WHERE stage_id = 'serp-collection' AND pipeline_run_id = $1 ORDER BY item_key", [runId])).rows;
  assert.equal(terminal[0].result.outcome, "no_results");
  assert.equal(terminal[0].state, "succeeded");
  assert.equal(terminal[1].state, "succeeded");
  assert.equal(Number((await pool.query("SELECT count(*) FROM local_provider_serp_results WHERE normalised_keyword = 'empty query'")).rows[0].count), 0, "No-result searches must not manufacture SERP rows.");
  const diagnostics = (await pool.query("SELECT output->'providerDiagnostics' AS diagnostics FROM pipeline_stage_runs WHERE run_id = $1 AND stage_id = 'serp-collection'", [runId])).rows[0].diagnostics;
  assert.deepEqual(diagnostics.sampleKeywords, ["empty query"]);
  assert.equal(diagnostics.noResultCount, 1);
  const callCount = calls.length;
  await assert.rejects(withProviderRun(pool, runId, 2, () => hydrator.hydrate(pool, projectId, runId, "serp-collection")), { code: "dataforseo_no_search_results" });
  assert.equal(calls.length, callCount, "A terminal search must not be polled or submitted again.");
  await failPipelineRun(pool, { runId, stageId: "serp-collection", reason: "dataforseo_no_search_results", generation: 2 });
  await pool.query("UPDATE navigator_projects SET last_dirty_at = now() WHERE id = $1", [projectId]);
  const changed = await withTransaction(pool, client => projectCheckpoint(client, projectId));
  await assert.rejects(withTransaction(pool, client => recoverPipelineRun(client, projectId, changed, runId)), { code: "pipeline_resume_unavailable" });
  assert.deepEqual((await checkpointRows()).rows, before);
  console.log("PostgreSQL recovery passed: 13 immutable completed stages, source selection, active-lock protection, API column grants, frozen inputs, retained task IDs/attempt totals, stale delivery rejection and changed-input rejection.");
  console.log("PostgreSQL AI stop/resume passed: in-flight responses saved, new batches blocked, original frozen inputs reused and only missing requests executed.");
  console.log("PostgreSQL SERP outcomes passed: 40102 persisted once, sibling collected, no resubmissions/repeated polling, bounded keyword diagnostics and no invented SERP rows.");
} finally {
  await pool.end();
  await owner.query(`DROP SCHEMA ${schema} CASCADE`);
  await owner.end();
}
