import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { parseRepresentativeProjectFixture } from "../../../packages/fixtures/src/representative-project.js";
import { executeDataDrivenStage, type DetoxStageData } from "../../../packages/pipeline/src/stage-handlers.js";
import { restoreKeywordDecisions } from "../src/recalculation.js";

const fixture = parseRepresentativeProjectFixture(JSON.parse(readFileSync(new URL("../../../fixtures/representative-project.json", import.meta.url), "utf8")));
const intake = executeDataDrivenStage("intake", fixture, {})!;
const promotion = executeDataDrivenStage("gsc-promotion", fixture, { intake });
const detox = executeDataDrivenStage("detox", fixture, { "gsc-promotion": promotion }) as DetoxStageData;

describe("recalculation keyword-decision persistence", () => {
  it("restores completed AI decisions before preflight without executing an AI provider", async () => {
    const previous = { ...detox, keywords: detox.keywords.map(keyword => ({ ...keyword, detox: { decision: "keep", reason: "Approved relevance", rule: "openrouter:z-ai/glm-5.3-flash" } })) };
    const query = vi.fn(async () => ({ rows: [{ output: previous }] }));
    const result = await restoreKeywordDecisions({ query } as unknown as DatabasePool, fixture.project.id, detox);
    expect(result).toEqual(previous);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'succeeded'"), [fixture.project.id, "detox"]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, { handlerVersion: "wrong" }, { ...detox, keywords: [] }])("rejects missing, incompatible or changed baselines", async (output) => {
    const pool = { query: async () => ({ rows: output ? [{ output }] : [] }) } as unknown as DatabasePool;
    await expect(restoreKeywordDecisions(pool, fixture.project.id, detox)).rejects.toMatchObject({ statusCode: 422 });
  });
  it("does not replace computational stages with stale baseline outputs", async () => {
    const query = vi.fn();
    expect(await restoreKeywordDecisions({ query } as unknown as DatabasePool, fixture.project.id, intake)).toBe(intake);
    expect(query).not.toHaveBeenCalled();
  });
});
