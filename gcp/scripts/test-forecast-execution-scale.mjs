import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { parseRepresentativeProjectFixture } from "../../dist/gcp/packages/fixtures/src/representative-project.js";
import { PIPELINE_STAGES } from "../../dist/gcp/packages/pipeline/src/definition.js";
import { executeDataDrivenStage } from "../../dist/gcp/packages/pipeline/src/stage-handlers.js";
import { executeCooperativeStage } from "../../dist/gcp/apps/worker/src/cooperative-stage.js";
import { createWorkerServer } from "../../dist/gcp/apps/worker/src/server.js";

const source = parseRepresentativeProjectFixture(JSON.parse(await readFile(
  new URL("../fixtures/representative-project.json", import.meta.url), "utf8",
)));
const outputs = {};
for (const stage of PIPELINE_STAGES) outputs[stage.id] = executeDataDrivenStage(stage.id, source, outputs);
const seed = outputs["har-v2"].keywords[0];
const ranking = outputs["ranking-url"].keywords.find(row => row.id === seed.id);
const demand = outputs["demand-signals"].keywords.find(row => row.id === seed.id);
const category = outputs.categorisation.keywords.find(row => row.id === seed.id);
const cluster = outputs.clustering.keywords.find(row => row.id === seed.id);
const count = 107926;
const keys = Array.from({ length: count }, (_, index) => `forecast-scale-${index}`);
outputs["har-v2"].keywords = keys.map(id => ({ ...seed, id, isCanonical: true }));
outputs["har-v2"].scenarioCount = count * 3;
outputs["ranking-url"].keywords = keys.map(id => ({ ...ranking, id })).reverse();
outputs["demand-signals"].keywords = keys.map(id => ({ ...demand, id }));
outputs.categorisation.keywords = keys.map(id => ({ ...category, id }));
outputs.clustering.keywords = keys.map(id => ({ ...cluster, id, canonicalKeywordId: id,
  clusterKey: id, isCanonical: true, memberCount: 1 }));
let calculating = false;
let probesDuringCalculation = 0;
let worstProbeMs = 0;
const server = createWorkerServer({ internalToken: "forecast-scale-test-token", processTask: async () => {
  calculating = true;
  outputs["revenue-v2"] = await executeCooperativeStage("revenue-v2", source, outputs);
  calculating = false;
  return { status: "succeeded" };
} });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const started = performance.now();
try {
  const task = fetch(base + "/internal/tasks", { method: "POST", signal: AbortSignal.timeout(60000), headers: {
    "content-type": "application/json", "x-seer-internal-token": "forecast-scale-test-token",
  }, body: JSON.stringify({ runId: "forecast-scale-run", stageId: "revenue-v2", taskId: "forecast-scale-task" }) });
  let taskDone = false;
  task.then(() => { taskDone = true; }, () => { taskDone = true; });
  while (!taskDone) {
    const probeStarted = performance.now();
    const probe = await fetch(base + "/healthz", { signal: AbortSignal.timeout(2000) });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).status, "ok");
    if (calculating) probesDuringCalculation += 1;
    worstProbeMs = Math.max(worstProbeMs, performance.now() - probeStarted);
  }
  const response = await task;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "succeeded");
  assert.ok(probesDuringCalculation > 0, "Health probes must respond while the calculation is active.");
  assert.equal(outputs["revenue-v2"].forecastCount, count * 3);
  assert.ok(outputs["revenue-v2"].keywords.every(row => row.scenarios.length === 3
    && row.scenarios.every(result => Number.isFinite(result.expectedIncrementalAnnual))));
  const revenueMs = performance.now() - started;
  assert.ok(revenueMs < 60000, "Revenue must finish within the calculation scale budget.");
  const rollupStarted = performance.now();
  const rollup = executeDataDrivenStage("rollup-output", source, outputs);
  const rollupMs = performance.now() - rollupStarted;
  assert.ok(rollupMs < 5000, "A shared ranking URL must not make rollups quadratic.");
  assert.equal(rollup.keywords.length, count);
  assert.equal(rollup.scenarios.length, 3);
  assert.equal(rollup.cannibalisationFlags.length, 1);
  assert.equal(rollup.cannibalisationFlags[0].keywordIds.length, count);
  assert.deepEqual(rollup.cannibalisationFlags[0].keywordIds, keys.toReversed());
  console.log(JSON.stringify({ event: "forecast-execution-scale-verified", keywords: count,
    scenarios: count * 3, probesDuringCalculation, worstProbeMs: Math.round(worstProbeMs),
    revenueMs: Math.round(revenueMs), rollupMs: Math.round(rollupMs) }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
