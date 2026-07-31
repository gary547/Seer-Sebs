import { describe, expect, it } from "vitest";
import {
  categorisationProgressDetail,
  type CategorisationJobSnapshot,
  waitForCategorisationJob,
} from "./categorisation-job";

const job = (patch: Partial<CategorisationJobSnapshot>): CategorisationJobSnapshot => ({
  status: "queued",
  total: 4,
  processed: 0,
  last_error: null,
  from_rules: 0,
  from_cache: 0,
  from_fast_path: 0,
  from_ai: 0,
  from_fallback: 0,
  heartbeat_at: null,
  next_run_at: null,
  rate_limited_until: null,
  ...patch,
});

const pollingHarness = (snapshots: CategorisationJobSnapshot[], stepMilliseconds = 1_000) => {
  let currentTime = 0;
  let index = 0;
  return {
    loadJob: async () => snapshots[Math.min(index++, snapshots.length - 1)],
    sleep: async () => {
      currentTime += stepMilliseconds;
    },
    now: () => currentTime,
  };
};

describe("waitForCategorisationJob", () => {
  it("waits through queued and running states until the job is truly complete", async () => {
    const harness = pollingHarness([
      job({ status: "queued" }),
      job({ status: "running", processed: 2 }),
      job({ status: "done", processed: 4 }),
    ]);
    const progress: string[] = [];

    const result = await waitForCategorisationJob({
      ...harness,
      onProgress: (snapshot) => progress.push(snapshot.status),
      pollMilliseconds: 1_000,
    });

    expect(result.status).toBe("done");
    expect(progress).toEqual(["queued", "running"]);
  });

  it("does not treat a provider rate limit as completion", async () => {
    const harness = pollingHarness([
      job({
        status: "rate_limited",
        next_run_at: new Date(5_000).toISOString(),
        rate_limited_until: new Date(5_000).toISOString(),
      }),
      job({ status: "running", processed: 2 }),
      job({ status: "done", processed: 4 }),
    ], 2_000);

    const result = await waitForCategorisationJob({
      ...harness,
      onProgress: () => undefined,
      pollMilliseconds: 2_000,
      stallMilliseconds: 3_000,
    });

    expect(result.processed).toBe(4);
  });

  it("surfaces a terminal worker error", async () => {
    const harness = pollingHarness([
      job({ status: "error", last_error: "No claimable keywords remain" }),
    ]);

    await expect(waitForCategorisationJob({
      ...harness,
      onProgress: () => undefined,
    })).rejects.toThrow("No claimable keywords remain");
  });

  it("detects a stalled job from real progress even when heartbeats change", async () => {
    const harness = pollingHarness([
      job({ status: "running", heartbeat_at: new Date(1_000).toISOString() }),
      job({ status: "running", heartbeat_at: new Date(2_000).toISOString() }),
      job({ status: "running", heartbeat_at: new Date(3_000).toISOString() }),
      job({ status: "running", heartbeat_at: new Date(4_000).toISOString() }),
    ]);

    await expect(waitForCategorisationJob({
      ...harness,
      onProgress: () => undefined,
      stallMilliseconds: 2_000,
    })).rejects.toThrow("no keyword progress");
  });

  it("rejects a false done state with unresolved work", async () => {
    const harness = pollingHarness([
      job({ status: "done", processed: 3 }),
    ]);

    await expect(waitForCategorisationJob({
      ...harness,
      onProgress: () => undefined,
    })).rejects.toThrow("1 keyword(s) unresolved");
  });
});

describe("categorisationProgressDetail", () => {
  it("shows the provider retry window while rate limited", () => {
    expect(categorisationProgressDetail(job({
      status: "rate_limited",
      processed: 1,
      rate_limited_until: new Date(5_000).toISOString(),
    }), 2_000)).toBe("Categorisation paused by the provider… retrying in 3s (3 remaining)");
  });
});
