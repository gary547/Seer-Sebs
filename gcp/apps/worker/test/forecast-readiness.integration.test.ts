import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { PIPELINE_STAGES, type PipelineStageId } from "../../../packages/pipeline/src/definition.js";
import { executeDataDrivenStage, type LinkPowerScoreStageData, type RevenueV2StageData, type SerpCollectionStageData } from "../../../packages/pipeline/src/stage-handlers.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { executeStageTask } from "../src/processor.js";
import { createWorkerServer } from "../src/server.js";

describe("forecast completeness task delivery", () => {
  it.each([
    { stageId: "har-readiness", failure: "serp" },
    { stageId: "har-readiness", failure: "authority" },
    { stageId: "har-v2", failure: "authority" },
    { stageId: "rollup-output", failure: "revenue" },
  ] as const)("rejects incomplete $failure inputs at $stageId without marking success", async ({ stageId, failure }) => {
    const fixture = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
    const outputs: Partial<Record<PipelineStageId, unknown>> = {};
    for (const stage of PIPELINE_STAGES) {
      outputs[stage.id] = executeDataDrivenStage(stage.id, fixture,
        Object.fromEntries(stage.dependencies.map(id => [id, outputs[id]])));
    }
    if (failure === "serp") (outputs["serp-collection"] as SerpCollectionStageData).keywords.shift();
    else if (failure === "authority") {
      const row = (outputs["link-power-score"] as LinkPowerScoreStageData).keywords[0]!.results[0]!;
      Object.assign(row, { urlRating: null, domainRating: null, referringDomains: null, backlinks: null,
        metricSource: "missing-provider", score: 0 });
    }
    else (outputs["revenue-v2"] as RevenueV2StageData).keywords[0]!.scenarios[0]!.expectedIncrementalAnnual = null;
    const definition = PIPELINE_STAGES.find(stage => stage.id === stageId)!;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
      if (sql.includes("SELECT state")) return { rows: [{ state: "pending" }], rowCount: 1 };
      if (sql.includes("SELECT stage_id, state")) return { rows: definition.dependencies.map(id => ({ stage_id: id, state: "succeeded" })), rowCount: definition.dependencies.length };
      if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }], rowCount: 1 };
      if (sql.includes("SELECT input")) return { rows: [{ input: { fixture } }], rowCount: 1 };
      if (sql.includes("SELECT stage_id, output")) return { rows: definition.dependencies.map(id => ({ stage_id: id, output: outputs[id] })), rowCount: definition.dependencies.length };
      return { rows: [], rowCount: 1 };
    });
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as DatabasePool;
    const server = createWorkerServer({ internalToken: "integration-token", processTask: task => executeStageTask(pool, task) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/tasks`, {
        method: "POST", headers: { authorization: "Bearer integration-token", "content-type": "application/json" },
        body: JSON.stringify({ runId: "00000000-0000-4000-8000-000000000001", stageId, taskId: "1" }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "pipeline_inputs_incomplete" } });
      expect(query.mock.calls.some(([sql]) => /SET (?:state|status) = 'succeeded'/.test(sql))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO outbox_events"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
