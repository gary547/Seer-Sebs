import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { createDatabasePool } from "../../dist/gcp/packages/runtime/src/database.js";
import { parseCsvRows } from "../../dist/gcp/apps/api/src/gsc-workbook.js";
import { runDispatcher } from "../../dist/gcp/apps/dispatcher/src/dispatcher.js";
import { createWorkerServer } from "../../dist/gcp/apps/worker/src/server.js";
import { executeStageTask, failPipelineRun } from "../../dist/gcp/apps/worker/src/processor.js";
import { DataForSeoClient, DataForSeoAuthorityClient, LivePipelineProviderHydrator } from "../../dist/gcp/apps/worker/src/live-providers.js";
import { OPENROUTER_MODEL, OpenRouterPipelineClient } from "../../dist/gcp/apps/worker/src/openrouter.js";

const apiBaseUrl = process.env.SEER_LOCAL_API_URL ?? "http://127.0.0.1:18080";
assert.equal(new URL(apiBaseUrl).hostname, "127.0.0.1", "Acceptance harness must target loopback only.");
const directory = process.env.SEER_ACCEPTANCE_DIRECTORY;
assert(directory, "SEER_ACCEPTANCE_DIRECTORY must be an explicit scratch directory.");
const liveAi = process.env.SEER_ACCEPTANCE_AI === "live";
if (liveAi) assert(process.env.OPENROUTER_API_KEY, "Inject the approved OpenRouter key via hush.");
const liveSeo = process.env.SEER_ACCEPTANCE_SEO === "live";
const seoCredential = process.env.DATAFORSEO_CREDENTIALS?.trim().replace(/^Basic\s+/i, "");
if (liveSeo) assert(seoCredential, "Inject the DataForSEO test credential via hush.");
const databasePort = Number(process.env.SEER_ACCEPTANCE_DATABASE_PORT ?? 25432);
const workerPort = Number(process.env.SEER_ACCEPTANCE_WORKER_PORT ?? 19082);
assert([25432, 25433].includes(databasePort));
assert([19082, 19092].includes(workerPort));
if (liveSeo) assert.equal(databasePort, 25433, "Live SEO acceptance requires the isolated cold-cache database.");
const sourcePath = new URL("../fixtures/control-data/pilltime/Pilltime SAFS Export - 21.03.2025 - 01.08.2026 - SAS_2026-08-03_17-49-45.csv", import.meta.url);
const sourceRows = parseCsvRows(await readFile(sourcePath, "utf8"));
const queryOffset = Number(process.env.SEER_ACCEPTANCE_QUERY_OFFSET ?? 0);
const queryLimit = Number(process.env.SEER_ACCEPTANCE_QUERY_LIMIT ?? 20);
assert(Number.isInteger(queryOffset) && queryOffset >= 0);
assert(Number.isInteger(queryLimit) && queryLimit >= 1 && queryLimit <= 20, "Acceptance datasets are capped at 20 queries.");
const selectedQueries = [...new Set(sourceRows.slice(1).map((row) => row[0]))].slice(queryOffset, queryOffset + queryLimit);
assert.equal(selectedQueries.length, queryLimit);
const datasetFilename = `pilltime-safs-${queryLimit}-queries.csv`;
const selectedRows = sourceRows.slice(1).filter((row) => selectedQueries.includes(row[0]));
const csvText = [sourceRows[0], ...selectedRows].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/${datasetFilename}`, csvText);
const calls = [];
const tasks = new Map();
const history = Array.from({ length: 24 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 8 + index, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, search_volume: 500 + index * 10 };
});
const response = (results) => Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result: results }] });
const pageFor = (keyword) => `https://pilltime.co.uk/${encodeURIComponent(keyword.replaceAll(" ", "-"))}`;

async function providerFetch(input, init = {}) {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.dataforseo.com");
  const body = init.body ? JSON.parse(init.body) : [];
  const task = body[0] ?? {};
  if (liveSeo) {
    assert.equal(url.origin, "https://api.dataforseo.com");
    assert(url.pathname.startsWith("/v3/"));
    const audit = { provider: "dataforseo", transport: "live", method: init.method ?? "GET", endpoint: url.pathname, targets: task.targets?.length ?? task.keywords?.length ?? body.length, startedAt: new Date().toISOString() };
    calls.push(audit);
    const reply = await fetch(input, { ...init, redirect: "error" });
    audit.httpStatus = reply.status;
    try {
      const result = await reply.clone().json();
      audit.statusCode = result.status_code;
      audit.tasks = (result.tasks ?? []).map((item) => ({ id: item.id, statusCode: item.status_code, resultCount: item.result_count }));
    } catch { audit.validJson = false; }
    await writeFile(`${directory}/provider-calls.json`, JSON.stringify(calls, null, 2));
    console.log(JSON.stringify({ provider: audit.provider, endpoint: audit.endpoint, httpStatus: audit.httpStatus, statusCode: audit.statusCode, taskCodes: audit.tasks?.map((item) => item.statusCode) }));
    return reply;
  }
  calls.push({ provider: "dataforseo", transport: "controlled", endpoint: url.pathname, targets: task.targets?.length ?? task.keywords?.length ?? body.length });
  if (url.pathname.endsWith("/backlinks/summary/live")) {
    return response([{ target: task.target, rank: 52, backlinks: 4200, referring_domains: 230 }]);
  }
  if (url.pathname.endsWith("/backlinks/bulk_pages_summary/live")) {
    assert.equal(task.rank_scale, "one_hundred");
    return response([{ items: task.targets.map((target) => ({
      target, url: target, rank: target.includes("domain-fallback") ? null : 38,
      main_domain_rank: target.includes("domain-fallback") ? null : 60,
      backlinks: target.includes("domain-fallback") ? null : 320,
      referring_domains: target.includes("domain-fallback") ? null : 40,
    })).reverse() }]);
  }
  if (url.pathname.endsWith("/search_volume/live")) return response(task.keywords.map((keyword) => ({ keyword, search_volume: 730, monthly_searches: history })));
  if (url.pathname.endsWith("/historical_search_volume/live")) return response([{ items: task.keywords.map((keyword) => ({ keyword, keyword_info: { search_volume: 730, monthly_searches: history } })) }]);
  if (url.pathname.endsWith("/bulk_keyword_difficulty/live")) return response([{ items: task.keywords.map((keyword) => ({ keyword, keyword_difficulty: 25 })) }]);
  if (url.pathname.endsWith("/search_intent/live")) return response([{ items: task.keywords.map((keyword) => ({ keyword, keyword_intent: { label: "commercial" } })) }]);
  if (url.pathname.endsWith("/ranked_keywords/live")) {
    const keywords = task.filters[2];
    return response([{ items: keywords.filter((keyword) => selectedQueries.indexOf(keyword) % 2 === 0).map((keyword) => ({
      keyword_data: { keyword }, ranked_serp_element: { serp_item: { url: pageFor(keyword), rank_group: 7 } },
    })) }]);
  }
  if (url.pathname.endsWith("/task_post")) {
    return Response.json({ status_code: 20000, tasks: body.map((item) => {
      const id = randomUUID(); tasks.set(id, item);
      return { id, status_code: 20100, data: { tag: item.tag } };
    }) });
  }
  if (url.pathname.endsWith("/tasks_ready")) return response([...tasks.keys()].map((id) => ({ id })));
  if (url.pathname.includes("/task_get/advanced/")) {
    const original = tasks.get(url.pathname.split("/").at(-1));
    assert(original, "Unknown controlled SERP task.");
    const items = Array.from({ length: 10 }, (_, index) => ({
      type: "organic", rank_absolute: index + 1, domain: "comparison.example",
      url: `https://comparison.example/${index === 2 ? "domain-fallback" : "page"}/${index + 1}/${encodeURIComponent(original.keyword)}`,
    }));
    if (selectedQueries.indexOf(original.keyword) % 2 === 0) items[6] = { type: "organic", rank_absolute: 7, domain: "pilltime.co.uk", url: pageFor(original.keyword) };
    return response([{ items: [...items, { type: "people_also_ask" }] }]);
  }
  throw new Error(`Unexpected controlled provider endpoint: ${url.pathname}`);
}

async function aiFetch(input, init) {
  assert.equal(String(input), "https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(init.body);
  assert.equal(body.model, OPENROUTER_MODEL);
  assert.equal(body.models, undefined);
  const rows = JSON.parse(body.messages[1].content).items;
  const instruction = body.messages[0].content;
  const operation = instruction.includes("decision (keep/remove/review)") ? "detox" : instruction.includes("relevancyScore") ? "content-fit" : "categorisation";
  const audit = { provider: "openrouter", transport: liveAi ? "live" : "controlled", model: body.model, operation, rows: rows.length };
  calls.push(audit);
  if (liveAi) {
    const reply = await fetch(input, { ...init, redirect: "error" });
    audit.httpStatus = reply.status;
    if (reply.ok) {
      const result = await reply.clone().json();
      audit.returnedModel = result.model;
      audit.requestId = result.id;
    }
    await writeFile(`${directory}/provider-calls.json`, JSON.stringify(calls, null, 2));
    return reply;
  }
  return Response.json({ model: OPENROUTER_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: rows.map((row) => ({
    index: row.index,
    ...(operation === "detox" ? { decision: "keep", reason: "Relevant to the configured pharmacy offering." }
      : operation === "content-fit" ? { relevancyScore: row.scope === "domain_fallback" ? 55 : 85, contentStatus: "amber", tacticalStatus: row.scope === "domain_fallback" ? "create_content" : "optimise_content" }
        : { category: row.keyword.includes("pill") ? "Pharmacy services" : "Weight management", intent: row.keyword.includes("pill") ? "navigational" : "commercial", tags: ["Pharmacy"] }),
  })) }) } }] });
}

const workerPool = createDatabasePool(`postgresql://seer_worker_local:local-worker-only@127.0.0.1:${databasePort}/seer`);
const dispatchPool = createDatabasePool(`postgresql://seer_dispatcher_local:local-dispatcher-only@127.0.0.1:${databasePort}/seer`);
const pending = await workerPool.query("SELECT count(*)::int AS count FROM pipeline_runs WHERE status IN ('pending', 'running')");
assert.equal(pending.rows[0].count, 0, "Finish existing local runs before starting isolated acceptance.");
const hydrator = new LivePipelineProviderHydrator(new DataForSeoClient(liveSeo ? seoCredential : "controlled:fixture", providerFetch), new DataForSeoAuthorityClient(liveSeo ? seoCredential : "controlled:fixture", providerFetch), new OpenRouterPipelineClient(process.env.OPENROUTER_API_KEY ?? "controlled-fixture", aiFetch));
const internalToken = "seer-local-internal-token";
const server = createWorkerServer({ internalToken, pool: workerPool,
  failRun: (failure) => failPipelineRun(workerPool, failure),
  processTask: (task) => executeStageTask(workerPool, task, { providerHydrator: hydrator }),
});
await new Promise((resolve) => server.listen(workerPort, "127.0.0.1", resolve));
const controller = new AbortController();
const dispatch = runDispatcher({ pool: dispatchPool, internalToken, workerUrl: `http://127.0.0.1:${workerPort}`, pollMilliseconds: 100 }, controller.signal);
let token;
async function request(path, method = "GET", body) {
  const result = await fetch(`${apiBaseUrl}${path}`, { method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const value = await result.json();
  assert(result.ok, `${path}: ${result.status} ${JSON.stringify(value)}`);
  return value;
}
async function close() {
  controller.abort(); await dispatch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([workerPool.end(), dispatchPool.end()]);
}
try {
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ event: "acceptance_runtime_ready", dataforseo: liveSeo ? "live" : "controlled", openrouter: liveAi ? "live" : "controlled" }));
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
  const email = `seer-provider-${Date.now()}@example.dev`;
  const registration = await request("/v1/local-auth/register", "POST", { email, password: "Local-provider-acceptance-2026", role: "super_admin" });
  token = registration.token;
  const clients = await request("/v1/clients");
  const client = clients.clients?.find((candidate) => candidate.domain === "pilltime.co.uk" && candidate.company_name === "Pilltime — small provider acceptance")
    ?? await request("/v1/clients", "POST", { companyName: "Pilltime — small provider acceptance", domain: "pilltime.co.uk", industry: "Online pharmacy, NHS prescription delivery and weight management", brandTerms: ["pilltime", "pill time"] });
  if (!liveSeo) await request(`/v1/clients/${client.id}`, "PATCH", { companyName: "Pilltime — small provider acceptance", domain: "pilltime.co.uk", industry: "Online pharmacy, NHS prescription delivery and weight management", brandTerms: ["pilltime", "pill time"], competitors: [{ competitorDomain: "comparison.example", competitorName: "Controlled comparison domain", verified: true }] });
  const project = await request(`/v1/clients/${client.id}/projects`, "POST", {
    name: `${queryLimit}-query SAFS · ${liveAi ? "live GLM" : "controlled AI"} / ${liveSeo ? "live DFS" : "controlled DFS"} · ${Date.now()}`,
    categoryFocus: "Pharmacy services and weight management", country: "GB", language: "en", currency: "GBP",
    economics: { conversionRate: 0.03, averageOrderValue: 50 },
  });
  const metadata = { projectId: project.id, clientId: client.id, email, dataset: `Pilltime SAFS, ${queryLimit} distinct queries at offset ${queryOffset}, all matching device rows`, queryCount: selectedQueries.length, sourceRows: selectedRows.length,
    apiBaseUrl, databasePort, providers: { openrouter: liveAi ? "live" : "controlled", dataforseo: liveSeo ? "live" : "controlled" }, model: OPENROUTER_MODEL };
  await writeFile(`${directory}/acceptance-project.json`, JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
  if (!process.argv.includes("--browser")) {
    const upload = await request(`/v1/projects/${project.id}/gsc-workbook`, "POST", { format: "csv_text", filename: datasetFilename, csvText, dateRangeStart: "2025-03-21", dateRangeEnd: "2026-08-01" });
    const started = await request(`/v1/projects/${project.id}/pipeline-runs`, "POST", { mode: "full" });
    metadata.runId = started.id;
    await writeFile(`${directory}/acceptance-project.json`, JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify({ uploaded: upload, runId: started.id }));
    const deadline = Date.now() + 20 * 60_000;
    let previous;
    let succeeded = false;
    while (Date.now() < deadline) {
      const run = await request(`/v1/pipeline-runs/${started.id}`);
      const active = run.stages.filter((stage) => stage.state === "running").map((stage) => `${stage.id}: ${stage.progress.message}`).join(" | ");
      if (active !== previous) { console.log(JSON.stringify({ status: run.status, active })); previous = active; }
      if (run.status === "failed") throw new Error(JSON.stringify({ runId: run.id, failure: run.failure }));
      if (run.status === "succeeded") {
        assert.equal(run.stages.filter((stage) => stage.state === "succeeded").length, 24);
        const [details, control, lps, inspector] = await Promise.all([
          request(`/v1/projects/${project.id}`), request(`/v1/projects/${project.id}/calculation-control`),
          request(`/v1/projects/${project.id}/link-power-inspector?limit=50`), request(`/v1/projects/${project.id}/calculation-inspector?limit=50`),
        ]);
        const kept = details.keywords.filter((keyword) => keyword.detox.status === "keep").length;
        assert(kept > 0);
        assert.equal(details.calculationCounts.siteArchitecture, kept);
        assert.equal(details.calculationCounts.harForecasts, kept * 3);
        assert.equal(details.calculationCounts.revenueForecasts, kept * 3);
        assert.equal(control.contentFit.missing, 0);
        assert.equal(lps.clientAuthority.metricSource, "dataforseo");
        const report = { ...metadata, status: run.status, completedStages: 24, kept, calculationCounts: details.calculationCounts, control, lps, inspector, calls };
        await writeFile(`${directory}/acceptance-report.json`, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ status: "passed", runId: run.id, kept, calculationCounts: details.calculationCounts, contentFit: control.contentFit, providerCalls: calls.length }));
        succeeded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert(succeeded, `Acceptance run ${started.id} did not finish before the deadline.`);
  }
  if (process.argv.includes("--browser")) {
    console.log("Acceptance runtime ready for browser upload and pipeline start.");
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  }
  }
} finally {
  await writeFile(`${directory}/provider-calls.json`, JSON.stringify(calls, null, 2));
  await close();
}
