import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { PIPELINE_STAGES, type PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import {
  executeDataDrivenStage,
  type HarV2StageData,
  type DemandSignalsStageData,
  type RankingUrlStageData,
  type RevenueV2StageData,
} from "../../../packages/pipeline/src/stage-handlers.js";
import { executeCooperativeStage } from "../src/cooperative-stage.js";
import { createWorkerServer } from "../src/server.js";

function representativeInputs() {
  const fixture = parseRepresentativeProjectFixture(JSON.parse(readFileSync(
    new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8",
  )));
  const outputs: Partial<Record<PipelineStageId, unknown>> = {};
  for (const stage of PIPELINE_STAGES) outputs[stage.id] = executeDataDrivenStage(stage.id, fixture, outputs);
  return { fixture, outputs };
}

describe("cooperative calculation execution", () => {
  it("retains financial override precedence and all scenario values", async () => {
    const { fixture, outputs } = representativeInputs();
    const ranking = outputs["ranking-url"] as RankingUrlStageData;
    ranking.keywords.reverse();
    for (const stage of PIPELINE_STAGES) {
      expect(await executeCooperativeStage(stage.id, fixture, outputs))
        .toEqual(executeDataDrivenStage(stage.id, fixture, outputs));
    }
  });

  it("answers worker health probes during a large Revenue task", async () => {
    const { fixture, outputs } = representativeInputs();
    const har = outputs["har-v2"] as HarV2StageData;
    const ranking = outputs["ranking-url"] as RankingUrlStageData;
    const demand = outputs["demand-signals"] as DemandSignalsStageData;
    const seedHar = har.keywords[0]!;
    const seedRanking = ranking.keywords.find(row => row.id === seedHar.id)!;
    const seedDemand = demand.keywords.find(row => row.id === seedHar.id)!;
    const count = 20000;
    har.keywords = Array.from({ length: count }, (_, index) => ({ ...seedHar, id: `scale-${index}` }));
    har.scenarioCount = count * 3;
    ranking.keywords = har.keywords.map(row => ({ ...seedRanking, id: row.id })).reverse();
    demand.keywords = har.keywords.map(row => ({ ...seedDemand, id: row.id }));
    let finished = false;
    const results: RevenueV2StageData[] = [];
    const server = createWorkerServer({ internalToken: "cooperative-test-token", processTask: async () => {
      results.push(await executeCooperativeStage("revenue-v2", fixture, outputs) as RevenueV2StageData);
      finished = true;
      return { status: "succeeded" };
    } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const task = fetch(base + "/internal/tasks", { method: "POST", headers: {
        "content-type": "application/json", "x-seer-internal-token": "cooperative-test-token",
      }, body: JSON.stringify({ runId: "scale-run", stageId: "revenue-v2", taskId: "scale-task" }) });
      let probesDuringCalculation = 0;
      for (let index = 0; index < 5; index++) {
        const probe = await fetch(base + "/healthz", { signal: AbortSignal.timeout(2000) });
        expect(probe.status).toBe(200);
        expect(await probe.json()).toEqual({ service: "seer-worker", status: "ok" });
        if (!finished) probesDuringCalculation += 1;
      }
      expect(probesDuringCalculation).toBeGreaterThan(0);
      const response = await task;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ runId: "scale-run", stageId: "revenue-v2", status: "succeeded" });
      expect(results[0]).toMatchObject({ forecastCount: count * 3 });
      expect(results[0]!.keywords).toHaveLength(count);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30000);
});
