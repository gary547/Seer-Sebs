import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import type { DetoxStageData } from "../../../packages/pipeline/src/stage-handlers.js";

import {
  DETOX_PERSISTENCE_BATCH_SIZE,
  normaliseStoredConversionRate,
  persistProjectStageData,
  projectIdFromInput,
} from "../src/project-data.js";

describe("project-backed pipeline input", () => {
  const projectId = "32000000-0000-4000-8000-000000000001";

  it("accepts the versioned project contract", () => {
    expect(
      projectIdFromInput({
        inputVersion: "project-v1",
        projectId,
      }),
    ).toBe(projectId);
  });

  it("ignores structural and representative fixture inputs", () => {
    expect(projectIdFromInput({ purpose: "structural" })).toBeNull();
    expect(projectIdFromInput({ fixture: {} })).toBeNull();
  });

  it("rejects malformed identifiers for the project contract", () => {
    expect(() =>
      projectIdFromInput({
        inputVersion: "project-v1",
        projectId: "not-a-project",
      }),
    ).toThrow("invalid projectId");
  });

  it("normalises legacy percentage conversion rates without changing decimals", () => {
    expect(normaliseStoredConversionRate(null)).toBeNull();
    expect(normaliseStoredConversionRate("0.016")).toBe(0.016);
    expect(normaliseStoredConversionRate("1.6")).toBe(0.016);
    expect(normaliseStoredConversionRate("100")).toBe(1);
  });

  it("persists large detox runs in bounded batches with an extended statement timeout", async () => {
    const keywordCount = DETOX_PERSISTENCE_BATCH_SIZE * 2 + 501;
    const output = {
      handlerVersion: "detox-v1",
      keptKeywordCount: keywordCount,
      keywords: Array.from({ length: keywordCount }, (_, index) => ({
        detox: {
          decision: "keep",
          reason: "Allowed by qualification rules",
          rule: "whitelist",
        },
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
      removedKeywordCount: 0,
      reviewKeywordCount: 0,
    } as unknown as DetoxStageData;
    const persistedBatchSizes: number[] = [];
    const query = async (sqlValue: string, params?: unknown[]) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SET LOCAL statement_timeout")) {
        return { rowCount: null, rows: [] };
      }
      const batch = JSON.parse(String(params?.[1])) as unknown[];
      persistedBatchSizes.push(batch.length);
      return { rowCount: batch.length, rows: [] };
    };

    await persistProjectStageData(
      { query } as unknown as PoolClient,
      projectId,
      "00000000-0000-4000-8000-000000000004",
      output,
    );

    expect(persistedBatchSizes).toEqual([
      DETOX_PERSISTENCE_BATCH_SIZE,
      DETOX_PERSISTENCE_BATCH_SIZE,
      501,
    ]);
  });
});
