export interface CategorisationJobSnapshot {
  status: string;
  total: number | null;
  processed: number | null;
  last_error: string | null;
  from_rules: number | null;
  from_cache: number | null;
  from_fast_path: number | null;
  from_ai: number | null;
  from_fallback: number | null;
  heartbeat_at: string | null;
  next_run_at: string | null;
  rate_limited_until: string | null;
}

interface WaitForCategorisationJobOptions {
  loadJob: () => Promise<CategorisationJobSnapshot | null>;
  onProgress: (job: CategorisationJobSnapshot) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  pollMilliseconds?: number;
  stallMilliseconds?: number;
  maxWaitMilliseconds?: number;
}

const ACTIVE_STATUSES = new Set(["queued", "running", "rate_limited"]);

const numericCount = (value: number | null) => Math.max(0, value ?? 0);

const timestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

export function categorisationProgressDetail(job: CategorisationJobSnapshot, now = Date.now()) {
  const total = numericCount(job.total);
  const processed = numericCount(job.processed);
  const remaining = Math.max(0, total - processed);

  if (job.status === "rate_limited") {
    const resumeAt = timestamp(job.rate_limited_until) ?? timestamp(job.next_run_at);
    if (resumeAt && resumeAt > now) {
      const waitSeconds = Math.max(1, Math.ceil((resumeAt - now) / 1000));
      return `Categorisation paused by the provider… retrying in ${waitSeconds}s (${remaining} remaining)`;
    }
  }

  return `Categorisation running… ${processed}/${total} done (${remaining} remaining)`;
}

export async function waitForCategorisationJob({
  loadJob,
  onProgress,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  pollMilliseconds = 2_000,
  stallMilliseconds = 3 * 60_000,
  maxWaitMilliseconds = 60 * 60_000,
}: WaitForCategorisationJobOptions): Promise<CategorisationJobSnapshot> {
  const startedAt = now();
  let lastProcessed = -1;
  let lastProgressAt = startedAt;

  while (true) {
    await sleep(pollMilliseconds);
    const job = await loadJob();
    const checkedAt = now();

    if (!job) {
      throw new Error("Categorisation job disappeared");
    }

    const processed = numericCount(job.processed);
    const total = numericCount(job.total);
    if (processed > lastProcessed) {
      lastProcessed = processed;
      lastProgressAt = checkedAt;
    }

    if (job.status === "done") {
      if (processed < total) {
        throw new Error(`Categorisation reported completion with ${total - processed} keyword(s) unresolved`);
      }
      return job;
    }

    if (job.status === "error") {
      throw new Error(job.last_error || "Categorisation job failed");
    }

    if (!ACTIVE_STATUSES.has(job.status)) {
      throw new Error(`Categorisation entered an unknown state: ${job.status}`);
    }

    onProgress(job);

    const rateLimitDeadline =
      job.status === "rate_limited"
        ? timestamp(job.rate_limited_until) ?? timestamp(job.next_run_at)
        : null;
    const progressDeadline = Math.max(
      lastProgressAt + stallMilliseconds,
      rateLimitDeadline ? rateLimitDeadline + stallMilliseconds : 0,
    );

    if (checkedAt > progressDeadline) {
      throw new Error(
        `Categorisation stalled at ${processed}/${total} — no keyword progress for ${Math.round(stallMilliseconds / 1000)}s`,
      );
    }

    if (checkedAt - startedAt > maxWaitMilliseconds) {
      throw new Error("Categorisation took longer than 1h");
    }
  }
}
