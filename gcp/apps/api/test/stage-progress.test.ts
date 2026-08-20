import { describe, expect, it } from "vitest";

import { buildStageProgress, formatElapsed } from "../src/stage-progress.js";

const now = new Date("2026-08-20T07:50:00.000Z");

describe("stage progress", () => {
  it("formats elapsed durations for the operator log line", () => {
    expect(
      formatElapsed(new Date("2026-08-20T07:49:54.000Z"), now),
    ).toBe("6s");
    expect(
      formatElapsed(new Date("2026-08-20T07:47:48.000Z"), now),
    ).toBe("2.2m");
    expect(
      formatElapsed(new Date("2026-08-20T06:20:00.000Z"), now),
    ).toBe("1.5h");
  });

  it("explains pending stages with unmet dependencies", () => {
    expect(
      buildStageProgress({
        attempts: 0,
        completedAt: null,
        id: "har-v2",
        now,
        outputMessage: null,
        startedAt: null,
        state: "pending",
        waitingOn: ["site-architecture", "link-power-score"],
        work: null,
      }),
    ).toMatchObject({
      message: "Waiting on site-architecture, link-power-score",
      percent: 0,
    });
  });

  it("reports live SERP work-item percentage and counts", () => {
    const progress = buildStageProgress({
      attempts: 11,
      completedAt: null,
      id: "serp-collection",
      now,
      outputMessage: null,
      startedAt: new Date("2026-08-20T07:32:00.000Z"),
      state: "running",
      waitingOn: [],
      work: {
        failed: 0,
        lastError: null,
        pending: 120,
        submitted: 400,
        succeeded: 4200,
        total: 8839,
      },
    });
    expect(progress.percent).toBe(48);
    expect(progress.message).toBe(
      "4,200 of 8,839 items done · 400 in flight · 18m elapsed · attempt 11",
    );
  });

  it("uses a precise running hint when a stage has no work items", () => {
    expect(
      buildStageProgress({
        attempts: 3,
        completedAt: null,
        id: "site-architecture",
        now,
        outputMessage: null,
        startedAt: new Date("2026-08-20T07:20:00.000Z"),
        state: "running",
        waitingOn: [],
        work: null,
      }).message,
    ).toBe(
      "Scoring content-fit for ranking URLs · 30m elapsed · attempt 3",
    );
  });

  it("marks succeeded stages complete with duration", () => {
    expect(
      buildStageProgress({
        attempts: 2,
        completedAt: new Date("2026-08-20T07:49:30.000Z"),
        id: "backlinks",
        now,
        outputMessage: null,
        startedAt: new Date("2026-08-20T07:15:48.000Z"),
        state: "succeeded",
        waitingOn: [],
        work: null,
      }),
    ).toMatchObject({
      message: "Completed in 34m",
      percent: 100,
    });
  });
});
