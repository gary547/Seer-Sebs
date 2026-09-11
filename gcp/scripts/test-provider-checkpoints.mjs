import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabasePool } from "../../dist/gcp/packages/runtime/src/database.js";
import { DataForSeoAuthorityClient, LivePipelineProviderHydrator } from "../../dist/gcp/apps/worker/src/live-providers.js";
import { failPipelineRun, executeStageTask } from "../../dist/gcp/apps/worker/src/processor.js";
import { StageContinuation } from "../../dist/gcp/apps/worker/src/stage-continuation.js";
import { classificationCache } from "../../dist/gcp/apps/worker/src/classification-cache.js";
import { OPENROUTER_MODEL } from "../../dist/gcp/apps/worker/src/openrouter.js";

const url = new URL(process.env.SEER_CHECKPOINT_DATABASE_URL ?? "postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Checkpoint regression must use a local database.");
const schema = `checkpoint_test_${randomUUID().replaceAll("-", "")}`;
const owner = createDatabasePool(url.toString());
url.searchParams.set("options", `-c search_path=${schema},public`);
const pool = createDatabasePool(url.toString());
const projectId = randomUUID();
const runId = randomUUID();
const clientId = randomUUID();
const urls = Array.from({ length: 201 }, (_, i) => `https://checkpoint.test/page-${String(i).padStart(3, "0")}`);
let requests = [];
let failing = true;
const fetcher = async (endpoint, init) => {
  const [task] = JSON.parse(init.body);
  requests.push({ endpoint: String(endpoint), task });
  if (task.targets && task.targets.includes(urls[100]) && failing) return new Response("Unavailable", { status: 503 });
  const result = task.targets
    ? [{ items: task.targets.filter(url => url === urls[0]).map(url => ({ url, rank: 0, main_domain_rank: 45, backlinks: 0, referring_domains: 0 })) }]
    : [{ target: task.target, rank: 45, backlinks: 200, referring_domains: 30 }];
  return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result }] });
};
const hydrator = () => new LivePipelineProviderHydrator({}, new DataForSeoAuthorityClient("local-test-only", fetcher, async () => {}), {});
try {
  await owner.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["pipeline_runs", "pipeline_stage_runs", "provider_work_items", "clients", "navigator_projects", "keywords", "authority_url_cache", "authority_domain_cache", "local_provider_serp_results", "local_provider_site_architecture_inputs", "keyword_intent_cache"]) {
    await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query("INSERT INTO clients (id, company_name, domain) VALUES ($1, 'Checkpoint regression', 'checkpoint.test')", [clientId]);
  await pool.query("INSERT INTO navigator_projects (id, client_id, project_name, country, language) VALUES ($1, $2, 'Checkpoint regression', 'GB', 'en')", [projectId, clientId]);
  await pool.query("INSERT INTO pipeline_runs (id, user_id, status, input) VALUES ($1, $2, 'running', $3)", [runId, randomUUID(), JSON.stringify({ projectId, mode: "full" })]);
  await pool.query("INSERT INTO pipeline_stage_runs (run_id, stage_id, state, output) VALUES ($1, 'backlinks', 'running', '{}'), ($1, 'site-architecture', 'running', '{}'), ($1, 'detox', 'succeeded', '{\"preserved\":true}')", [runId]);
  await pool.query("INSERT INTO local_provider_serp_results (project_id, normalised_keyword, rank_absolute, url, domain) SELECT $1, 'query ' || ordinality, 1, url, 'checkpoint.test' FROM unnest($2::text[]) WITH ORDINALITY AS input(url, ordinality)", [projectId, urls]);
  await assert.rejects(hydrator().hydrate(pool, projectId, runId, "backlinks"), { code: "dataforseo_backlinks_unavailable" });
  assert.equal(Number((await pool.query("SELECT count(*) FROM authority_url_cache")).rows[0].count), 100);
  assert.equal(Number((await pool.query("SELECT count(*) FROM local_provider_serp_results WHERE metric_source = 'dataforseo'")).rows[0].count), 100);
  assert.equal(requests.filter(request => request.task.target).length, 1);
  assert.equal(requests.filter(request => request.task.targets?.includes(urls[100])).length, 5);
  await failPipelineRun(pool, { runId, stageId: "backlinks", reason: "dataforseo_backlinks_unavailable" });
  await failPipelineRun(pool, { runId, stageId: "site-architecture", reason: "stage_failed" });
  const stages = (await pool.query("SELECT stage_id, state, output FROM pipeline_stage_runs ORDER BY stage_id")).rows;
  assert.equal(stages.find(stage => stage.stage_id === "backlinks").output.failedStage, "backlinks");
  assert.match(stages.find(stage => stage.stage_id === "backlinks").output.message, /temporarily unavailable/);
  assert.equal(stages.find(stage => stage.stage_id === "site-architecture").output.reason, "pipeline_blocked");
  assert.deepEqual(stages.find(stage => stage.stage_id === "detox").output, { preserved: true });
  await pool.query("UPDATE pipeline_runs SET status = 'running', completed_at = NULL WHERE id = $1", [runId]);
  await pool.query("UPDATE pipeline_stage_runs SET state = 'running' WHERE run_id = $1 AND state <> 'succeeded'", [runId]);
  requests = [];
  failing = false;
  await hydrator().hydrate(pool, projectId, runId, "backlinks");
  assert.equal(requests.filter(request => request.task.target).length, 0, "Domain metrics must survive worker replacement.");
  assert.deepEqual(requests.flatMap(request => request.task.targets ?? []), urls.slice(100));
  assert.equal(Number((await pool.query("SELECT count(*) FROM authority_url_cache")).rows[0].count), 201);
  const zero = (await pool.query("SELECT url_rating, backlinks, authority_scope FROM authority_url_cache WHERE url = $1", [urls[0]])).rows[0];
  assert.equal(Number(zero.url_rating), 0);
  assert.equal(Number(zero.backlinks), 0);
  assert.equal(zero.authority_scope, "page");
  requests = [];
  await hydrator().hydrate(pool, projectId, runId, "backlinks");
  assert.equal(requests.length, 0, "A fully cached retry must not call DataForSEO.");

  const keywordId = randomUUID();
  await pool.query("INSERT INTO keywords (id, project_id, keyword, normalised_keyword, detox_status, ranking_url) VALUES ($1, $2, 'test keyword', 'test keyword', 'keep', $3)", [keywordId, projectId, urls[0]]);
  const seen = [];
  const ai = { score: async rows => { seen.push(rows); throw new StageContinuation(); } };
  const content = new LivePipelineProviderHydrator({}, {}, ai);
  await assert.rejects(content.hydrate(pool, projectId, runId, "site-architecture"), { code: "stage_continuation" });
  await pool.query("UPDATE keywords SET ranking_url = $1 WHERE id = $2", [urls[1], keywordId]);
  await assert.rejects(content.hydrate(pool, projectId, runId, "site-architecture"), { code: "stage_continuation" });
  assert.deepEqual(seen[0], seen[1], "Parallel SERP changes must not invalidate content-fit batch inputs.");
  assert.equal(seen[1][0].rankingUrl, urls[0]);

  const blocker = await pool.connect();
  try {
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`${runId}:backlinks`]);
    const result = await executeStageTask(pool, { runId, stageId: "backlinks", taskId: "duplicate" });
    assert.equal(result.status, "continuing");
  } finally { blocker.release(true); }
  const canonical = classificationCache(pool, clientId);
  const category = { category: "SEO", intent: "commercial", tags: ["SEO"], model: OPENROUTER_MODEL };
  await canonical.set("test-context", new Map([["seo agency", category]]));
  const winner = await canonical.set("test-context", new Map([["seo agency", { ...category, intent: "transactional" }]]));
  assert.equal(winner.get("seo agency").intent, "commercial", "A later batch must not overwrite canonical intent.");
  assert.deepEqual((await classificationCache(pool, clientId).get("test-context")).get("seo agency"), category);
  assert.equal((await classificationCache(pool, randomUUID()).get("test-context")).size, 0);
  assert.equal((await canonical.get("another-context")).size, 0);
  console.log("PostgreSQL checkpoint regression passed: durable partial Backlinks, five bounded retries, domain reuse, zero preservation, root failure, frozen content inputs and duplicate delivery exclusion.");
  console.log("PostgreSQL intent cache passed: immutable canonical intent, replacement-worker reuse, client and context isolation.");
} finally {
  await pool.end();
  await owner.query(`DROP SCHEMA ${schema} CASCADE`);
  await owner.end();
}
