import { describe, expect, it } from "vitest";

import {
  PIPELINE_STAGE_IDS,
  PIPELINE_STAGES,
  type PipelineStageId,
} from "../src/definition.js";

function collectAncestors(stageId: PipelineStageId): Set<PipelineStageId> {
  const byId = new Map(PIPELINE_STAGES.map((stage) => [stage.id, stage]));
  const ancestors = new Set<PipelineStageId>();

  function visit(currentId: PipelineStageId): void {
    const stage = byId.get(currentId);

    if (!stage) {
      throw new Error(`Unknown pipeline stage: ${currentId}`);
    }

    for (const dependency of stage.dependencies) {
      if (ancestors.has(dependency)) {
        continue;
      }

      ancestors.add(dependency);
      visit(dependency);
    }
  }

  visit(stageId);
  return ancestors;
}

describe("canonical pipeline definition", () => {
  it("defines every stage exactly once", () => {
    const definedIds = PIPELINE_STAGES.map((stage) => stage.id);

    expect(definedIds).toHaveLength(PIPELINE_STAGE_IDS.length);
    expect(new Set(definedIds).size).toBe(PIPELINE_STAGE_IDS.length);
    expect(new Set(definedIds)).toEqual(new Set(PIPELINE_STAGE_IDS));
  });

  it("contains no unknown dependency or cycle", () => {
    const knownIds = new Set<PipelineStageId>(PIPELINE_STAGE_IDS);

    for (const stage of PIPELINE_STAGES) {
      for (const dependency of stage.dependencies) {
        expect(knownIds.has(dependency)).toBe(true);
        expect(collectAncestors(dependency).has(stage.id)).toBe(false);
      }
    }
  });

  it("requires all calculation inputs before HAR v2", () => {
    const harAncestors = collectAncestors("har-v2");

    expect([...harAncestors]).toEqual(
      expect.arrayContaining([
        "gsc-promotion",
        "detox",
        "preflight",
        "keyword-enrichment",
        "ranking-url",
        "serp-collection",
        "authority",
        "backlinks",
        "site-architecture",
        "link-power-score",
        "clustering",
        "har-readiness",
      ]),
    );
    expect(harAncestors.has("categorisation")).toBe(false);
  });

  it("orders Revenue v2 and calibration after their full dependency chain", () => {
    const revenueAncestors = collectAncestors("revenue-v2");
    const calibrationAncestors = collectAncestors("calibration");

    expect(revenueAncestors.has("har-v2")).toBe(true);
    expect(revenueAncestors.has("demand-signals")).toBe(true);
    expect(revenueAncestors.has("ctr-curves")).toBe(true);
    expect(calibrationAncestors.has("revenue-v2")).toBe(true);
    expect(calibrationAncestors.has("har-v2")).toBe(true);
  });
});
