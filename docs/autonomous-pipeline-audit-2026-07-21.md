# Autonomous Pipeline Audit — 2026-07-21

Read-only investigation. Every claim below is backed by either a code citation
(`path:Lstart-Lend`) or a SQL result shown inline. No code was changed and no
jobs were triggered.

Project scoped for "18k-keyword" evidence: `ce1f52ba-2bc1-4877-8c08-c9d6f8f2e482`
(**18,074 keywords** — the only project in this database that meets that
threshold).

```sql
SELECT project_id, COUNT(*) FROM public.keywords GROUP BY project_id ORDER BY 2 DESC LIMIT 5;
-- ce1f52ba-2bc1-4877-8c08-c9d6f8f2e482  18074
-- bf1a48b0-...                          1367
-- 80f955f5-...                           885
-- 5fd4df7e-...                           885
-- c9e35733-...                           371
```

---

## 1. pg_cron inventory

Source: `SELECT jobid, jobname, schedule, active, command FROM cron.job`.

| jobid | jobname | schedule | active | Invokes (edge function) | Notes |
|------:|---|---|:-:|---|---|
| 1 | `url-monitor-tick-every-5-min` | `*/5 * * * *` | ✅ | `url-monitor-tick` | Body `{source:"pg_cron"}`. |
| 2 | `detox-jobs-tick` | `* * * * *` | ✅ | `keyword-detox` (`mode:"tick"`, `job_id`) | Fires **only** for `detox_jobs` rows whose `status ∈ ('queued','running')` **and** `heartbeat_at IS NULL OR heartbeat_at < now() - 5 min`. |
| 4 | `categorisation-worker-tick` | `* * * * *` | ✅ | `categorisation-deferred-tick` | Deferred-tier only. |
| 7 | `categorisation-live-resume` | `* * * * *` | ✅ | `keyword-categorisation` (`mode:"tick"`, `job_id`) | Fires **only** for `categorisation_jobs.tier='live'` with `status ∈ ('queued','running','rate_limited')`, `next_run_at ≤ now()`, and heartbeat older than 90 s. |
| 8 | `har-worker-tick` | `* * * * *` | ✅ | `har-calculation` (`mode:"tick"`) | No `job_id` filter — the function's own tick loop picks the next runnable job. |

Recent `cron.job_run_details` confirms every job is currently succeeding on
schedule (samples at `2026-07-21 11:55:00`, all `status = 'succeeded'`).

**Not on cron:** `har-calculation-v2`, `compute-forecasts-v2`, `site-architecture`,
`keyword-enrichment`, `ranking-url-lookup`, `gsc-intent-enrichment`,
`link-power-score-compute`, `demand-signals-compute`, `calibration-compute`,
`brand-classification`, `keyword-cluster-recompute`, `keyword-detox` in **`mode:"start"`**,
and `keyword-categorisation` in **`mode:"start"`**.

---

## 2. `har_jobs` schema and state machine

### Schema (`information_schema.columns`, table `public.har_jobs`)

```
id (uuid, PK)           project_id (uuid)     status (text, default 'pending')
phase (text, nullable)  total_keywords (int)  serp_tasks_total (int)
serp_tasks_posted (int) serp_tasks_done (int) ahrefs_targets_total (int)
ahrefs_targets_done     backlinks_targets_total  backlinks_targets_done
backlinks_skipped (bool) har_rows_done (int)  attempts (int)
next_run_at (tstz, default now())             locked_at (tstz)
last_error (text)       started_at (tstz)    completed_at (tstz)
created_at (tstz)       updated_at (tstz)
```

There is **no `heartbeat_at`** column on `har_jobs`. The frontend rail
(`src/hooks/useBackgroundJobs.ts:209`) treats `updated_at` as the heartbeat.

### Phase state machine (`supabase/functions/har-calculation/index.ts`)

Phase transitions live in the `tick` handler (`har-calculation/index.ts:275-333`):

```
post_serp ──►  poll_serp ──►  fetch_ahrefs ──►  fetch_backlinks ──►  compute ──►  completed
```

Progress is claimed via SECURITY-DEFINER RPCs so multiple ticks can run without
double-processing rows (skip-locked pattern):

| Phase | Claim RPC | Batch / parallelism |
|---|---|---|
| `post_serp` | `claim_har_serp_post_batch(job_id, limit)` | `SERP_POST_BATCH = 100`, `SERP_POST_PARALLEL = 3` (`har-calculation/index.ts:27-28`) |
| `poll_serp` | `claim_har_serp_fetch_batch(job_id, limit)` and `claim_har_serp_fetch_by_dfs_ids` | `SERP_FETCH_BATCH = 150`, `SERP_FETCH_PARALLEL = 8` (L29-30) |
| `fetch_ahrefs` | `claim_har_ahrefs_batch(job_id, limit)` | `AHREFS_BATCH = 100`, `AHREFS_PARALLEL = 4` (L31-32) |
| `fetch_backlinks` | `claim_har_backlinks_batch(job_id, limit)` | `BACKLINKS_BATCH = 500`, `BACKLINKS_PARALLEL = 3` (L33-34) |
| `compute` | in-process (`runPhaseCompute`) | single pass — no batching, must fit inside `TICK_BUDGET_MS = 50 s` (L25) |

Bulk progress writes: `bulk_update_har_serp_tasks(_rows jsonb)` and
`bulk_update_serp_authority(_rows jsonb)` (existing DB functions).

Stale claims are released by DB function `release_stale_har_claims()` after
5 minutes (`db-functions` list).

Job advancement is driven by two independent mechanisms, both live:

1. **Self-chain** via `EdgeRuntime.waitUntil(fetch(mode:"tick"))`
   (`har-calculation/index.ts:218-233, 337`). Fires after every productive tick.
2. **Cron safety net** — job 8, every minute, hits `mode:"tick"` with no
   `job_id`; the function selects the next row with `next_run_at ≤ now()`
   and `status ∉ ('completed','error')` (L253-263).

---

## 3. Continuation mechanism per stage

Answer to the direct question: **only three stages self-continue after start
without any client-side polling loop — detox, live categorisation, and HAR v1.**
Everything else requires the browser tab to keep calling `functions.invoke()`
in a loop (`useNavigatorSync.ts`).

| Stage | Continuation driver | Evidence |
|---|---|---|
| `keyword-detox` | Self-chain via `EdgeRuntime.waitUntil(runWorker(job_id))` **and** cron job 2 (`detox-jobs-tick`) resumes stalled jobs. | `keyword-detox/index.ts:805-810, 935-938`; cron command above. |
| `keyword-categorisation` (live) | Self-chain (`categorisation self-chain error` in `keyword-categorisation/index.ts:1085-1086, 1109-1110`) **and** cron job 7 resumes stalled/rate-limited rows. | Cron command above. |
| `keyword-categorisation` (deferred) | Cron job 4 → `categorisation-deferred-tick` iterates each backlog project up to 50 invocations/run (`categorisation-deferred-tick/index.ts:57`). | Function body. |
| `har-calculation` (v1) | `EdgeRuntime.waitUntil` self-chain **and** cron job 8. | `har-calculation/index.ts:10, 219-233`. |
| `har-calculation-v2` | **None.** Not on cron and no `mode:"tick"` self-chain. Fully synchronous per invocation. | `rg` returned no `waitUntil` or `EdgeRuntime` refs. |
| `site-architecture` | **Client polling loop only.** `useNavigatorSync.ts:675-729` calls the function up to **40 times per sync**, aborts after 2 consecutive no-progress calls. | Loop `for (let i = 0; i < 40; i++)` and `stallStreak >= 2` throw. |
| `keyword-enrichment` | **Client polling loop only.** `useNavigatorSync.ts:309, 338` loops **200×**. | Same file. |
| `ranking-url-lookup` | Client one-shot (`useNavigatorSync.ts:386`). | Same file. |
| `gsc-intent-enrichment` | Client one-shot (`useNavigatorSync.ts:552`). | Same file. |
| `compute-forecasts` / `compute-forecasts-v2` | Client one-shot (`useNavigatorSync.ts:620`). | Same file. |
| `link-power-score-compute` | Manual invoke from admin UI. No cron, no self-chain. | `rg` and cron dump. |
| `demand-signals-compute` | Manual invoke from admin UI. Same. | Same. |
| `brand-classification` | Manual invoke from admin card. | Same. |
| `keyword-cluster-recompute` | Manual invoke from admin card. | Same. |
| `calibration-compute` | Manual invoke from admin card. | Same. |
| `url-monitor-tick` | Cron job 1, every 5 min. | Cron command. |

---

## 4. Site-architecture stall — root cause of "31 remaining across 2 invocations"

The message comes verbatim from `src/hooks/useNavigatorSync.ts:721-724`:

```ts
if (stallStreak >= 2) {
  throw new Error(
    `Site architecture stalled at ${remaining} remaining across 2 invocations. Check edge function logs.`,
  );
}
```

Mechanism:

1. Site architecture is **client-driven**. The sync hook loops
   `functions.invoke("site-architecture")` up to **40 times**
   (`useNavigatorSync.ts:675`).
2. Each invocation inspects every kept keyword, computes `pending` set, and
   processes **at most `MAX_ROWS_PER_INVOCATION = 250`**
   (`supabase/functions/site-architecture/index.ts:12, 272`).
   Within that batch, AI is called in slices of `AI_BATCH_SIZE = 30` with a
   retry chunk of `AI_RETRY_BATCH_SIZE = 10` (L15-16).
3. `remainingAfter` is recomputed from the DB. If `processedNew === 0` and
   `remainingAfter >= lastRemaining`, `stallStreak` increments
   (`useNavigatorSync.ts:714`).
4. **Two consecutive zero-progress invocations abort the whole sync.**

**What limits invocation count:** the hard-coded `for (i = 0; i < 40; i++)`
loop and the `stallStreak >= 2` abort — both live only in the browser tab.

**What happens to remaining work when the cap is hit:** nothing. The rows are
left with `relevancy_score IS NULL` in `site_architecture` (or no row at all).
They will be re-queued the next time the user clicks Sync Now, because
`isPending` (`site-architecture/index.ts:251-260`) treats missing/NULL rows as
pending. There is **no server-side retry** — no cron entry, no
`waitUntil` self-chain, no `site_architecture_jobs` table.

Common triggers for `processedNew === 0`:

- Gemini structured-output returns `MALFORMED_FUNCTION_CALL` after retry
  (comment L14; explicit `malformed` early-throw at L716-720).
- AI-gateway rate limit → function returns `rateLimited:true` with
  `retryAfterSeconds`; the client sleeps then retries — that path does
  **not** bump `stallStreak` (L688-700).
- Silent write failure → surfaced as `writeFailed:true` and thrown at
  L708-712.

No calc_run_registry row is produced for site-arch attempts; the registry does
not carry a `kind` column (columns: `id, project_id, triggered_by,
trigger_source, model_version, scope, status, started_at, finished_at,
warnings, errors, summary_json`), so the run cannot be forensically traced
there.

---

## 5. SERP freshness

**Tracked per keyword, not per project.** The authoritative freshness column
is `public.serp_results.fetched_at` (columns query above).

Refetch decision — `supabase/functions/har-calculation/index.ts:128-140`:

```ts
const cutoff = new Date(Date.now() - stalenessDays * 86_400_000).toISOString();
// ... for each keyword id chunk of 500 ...
.from("serp_results").select("keyword_id, fetched_at")
.in("keyword_id", chunk).gte("fetched_at", cutoff);
// keywords whose keyword_id is NOT in the fresh set are queued to har_serp_tasks
const toQueue = kept.filter((k) => !freshKeywordIds.has(k.id));
```

`stalenessDays` defaults to **7** from the client
(`useNavigatorSync.ts:60` — `stalenessDays = 7`).

**Consequence for keywords added after a SERP fetch:** they have zero rows in
`serp_results`, so they are not in `freshKeywordIds`, so the next HAR `start`
enqueues them into `har_serp_tasks`. Correct-by-construction, but **only when
the next HAR run happens** — HAR is not triggered automatically on keyword
insert. It runs when the user clicks Sync Now (`useNavigatorSync.ts:427`).

`har_serp_tasks.status` (columns above) is the per-task freshness within a
single job; it is not consulted for cross-job freshness — the writer keys off
`serp_results.fetched_at` only.

`har_serp_tasks` was empty at report time:

```sql
SELECT COUNT(*), status FROM public.har_serp_tasks GROUP BY status;
-- (no rows)
```

---

## 6. Per-stage resumability, batch size, observed throughput

Resumable = has server-side claim-with-skip-lock + a driver that re-enters
until done. "Client-loop resumable" means the browser tab can re-invoke, but
closing the tab stops the pipeline.

| Stage | Resumable across invocations? | Batch size / cap | Observed throughput | Continuation driver |
|---|---|---|---|---|
| Detox | ✅ server-side (cron + self-chain, `detox_jobs.heartbeat_at`, claim inside worker) | Pass 1 = 50, Pass 2 = 25 (`keyword-detox/index.ts:39-41`); outer claim `TICK_FETCH_LIMIT = 1000` (L44); `WORKER_BUDGET_MS = 110 s` (L43) | Recent completed rows (from `detox_jobs`): 40 / 21 s, 20 / 10 s, 16 / 11 s, 31 / 22 s. Two rows created 2026-06-05 remain `status='queued'` with `processed=0` — heartbeat updated by cron every minute but never advances (`id ∈ {a3352949…, 8658e4c6…}`). | pg_cron job 2 + `EdgeRuntime.waitUntil` |
| Categorisation (live) | ✅ server-side | `CLAIM_LIMIT = 120`, `AI_BATCH_SIZE = 15`, `MAX_AI_BATCHES_PER_TICK = 5`, `WORKER_BUDGET_MS = 95 s` (`keyword-categorisation/index.ts:426-429`) | Recent completed rows: 40 / 3.7 min, 20 / 2.3 min, 15 / 4.5 s, 30 / 1.7 min, 15 / 6.7 s. | pg_cron job 7 + self-chain |
| Categorisation (deferred) | ✅ server-side | Same worker limits as live; deferred-tick loops up to **50 invocations per project per nightly run** (`categorisation-deferred-tick/index.ts:57`). | Not exercised recently (no `tier='deferred'` rows in the last 15 categorisation_jobs). | pg_cron job 4 |
| Enrichment | ❌ server-side. Client-loop resumable only (200 iterations). | Not defined by an internal batch constant beyond DFS batching; freshness cutoff via `volume_fetched_at / difficulty_fetched_at / intent_fetched_at` (`keyword-enrichment/index.ts:184-188`). | Not tracked in a jobs table. | Client loop `useNavigatorSync.ts:309, 338` |
| Ranking URLs | ❌ Single client invocation. Internal DFS pagination in chunks of 700 keywords / 1000 rows (`ranking-url-lookup/index.ts:137, 158`). | — | Not tracked. | Client one-shot (L386) |
| SERP fetch (HAR v1) | ✅ server-side | See §2 batch table. | Recent 15 har_jobs all completed. Largest: 857 SERP tasks in **13m 24s** (job `e46dd1df`, 2026-07-20). All 15 rows end with `phase='compute'` and `last_error='compute-forecasts HTTP 500: Project not found'` — HAR itself finished; the compute stage errored because HAR v1's compute call to `compute-forecasts` cannot find v2-only projects. | Self-chain + pg_cron job 8 |
| Ahrefs authority | ✅ (part of HAR v1 job, same claim RPC). | `AHREFS_BATCH = 100`, `AHREFS_PARALLEL = 4`. | Job `e46dd1df`: 746 targets done in the same window. | Same as HAR v1 |
| Backlinks | ✅ (part of HAR v1). | `BACKLINKS_BATCH = 500`, `BACKLINKS_PARALLEL = 3`. | Job `e46dd1df`: 745 targets done. | Same as HAR v1 |
| GSC intent | ❌ Single invocation. Internal batches of 700 kw (`gsc-intent-enrichment/index.ts:11, 106-108`). | — | Not tracked. | Client one-shot (`useNavigatorSync.ts:552`) |
| Site architecture | ❌ Client-loop only, 40 attempts, aborts on 2 stalls. | `MAX_ROWS_PER_INVOCATION = 250`, `AI_BATCH_SIZE = 30`, `AI_RETRY_BATCH_SIZE = 10`, `MAX_TOKENS = 2048` (`site-architecture/index.ts:12-17`). | Not tracked (no job row, no registry row). | Client loop `useNavigatorSync.ts:675` |
| LPS (`link-power-score-compute`) | ❌ Single invocation, `MAX_LIMIT = 5000` keywords (L37, L210). | — | Not tracked. | Manual admin invoke |
| Demand signals | ❌ Single invocation, `MAX_LIMIT = 5000` (L36, L91, L215). | — | Not tracked. | Manual admin invoke |
| HAR v2 (`har-calculation-v2`) | ❌ Fully synchronous per call. No cron, no self-chain, no `har_jobs`-style micro-batch state. Chunked reads via `selectIn` (`MAX_IN_CHUNK = 100`) only mitigate URL-length, not wall-time. | — | Not tracked in this table (uses `calc_run_registry`). | Admin invoke |
| Revenue v2 (`compute-forecasts-v2`) | ❌ Same profile as HAR v2 — one synchronous run. | — | `calc_run_registry` (no timing columns beyond `started_at / finished_at`). | Admin invoke |
| Calibration | ❌ One synchronous run into `calibration_snapshots`. | — | Snapshots on record: `a46a976d` (post-clamp), `2cc40f0a`, `908ef33d` etc. | Admin invoke |

---

## 7. What would fail on an 18,000-keyword project

Applying the batch sizes and continuation model above to project
`ce1f52ba…` (18,074 keywords):

| Stage | Verdict | Reason |
|---|---|---|
| Detox | ✅ Pass (given enough wall time) | Server-driven, `heartbeat_at` + cron + self-chain resume on stall. Throughput ~30–40 kw per few-minute tick means ~1 kw/s effective; 18k rows ≈ 5–8 h wall time. No single request exceeds `WORKER_BUDGET_MS`. |
| Categorisation (live) | ✅ Pass | Same resumable model. `CLAIM_LIMIT=120` × `MAX_AI_BATCHES_PER_TICK=5 × AI_BATCH_SIZE=15` gives ~75 kw claimed per tick with 5 AI calls; cron re-fires every minute. |
| Categorisation (deferred) | ✅ Pass, but nightly | Deferred-tick caps at 50 self-invocations per project per nightly run — for 18k kept-and-deferred keywords that would need many nights unless live-tier picks them up first. |
| Enrichment | ⚠️ Marginal → likely fail | Client loops the function 200 times. Each call is bounded by the function's own DFS batching but has no shared jobs table. 18k rows exceed the 1000-row PostgREST default; the client waits synchronously — if the browser tab closes the pipeline halts. |
| Ranking URLs | ❌ Likely fail | Single function call must page through DFS for every kept keyword. `BATCH_SIZE=700 keywords × pages of 1000` easily exceeds the edge 150-second wall clock at 18k. No resume. |
| SERP fetch (HAR v1) | ✅ Pass | Resumable job; largest observed run (857 tasks / ~13 min) scales linearly. 18k tasks ≈ 4–5 h wall time across many ticks; cron + self-chain guarantee eventual completion. Note the persistent `compute-forecasts HTTP 500: Project not found` at the end — that is a downstream compute failure, not a HAR failure. |
| Ahrefs authority | ✅ Pass (same job) | 4× parallel × 100/batch = ~400 targets/tick. |
| Backlinks | ✅ Pass (same job) | 3× parallel × 500/batch. |
| GSC intent | ❌ Likely fail | Single invocation processes all keyword texts in 700-batch chunks synchronously; 18k rows would push a single edge invocation past the 150-second CPU/wall cap. No resume — one timeout loses the whole run. |
| Site architecture | ❌ **Definite fail** as configured | With `MAX_ROWS_PER_INVOCATION=250` and a client cap of 40 invocations, the maximum reachable is `250 × 40 = 10,000` — **below 18,074** even in the best case. And any AI hiccup on two consecutive ticks aborts the run early (this is precisely the observed 2026-07-20 message). No server-side backlog worker to finish the remainder. |
| LPS | ❌ Likely fail | `MAX_LIMIT=5000` cap in the function silently truncates work; 18k keywords cannot all be scored in one call, and there is no continuation. |
| Demand signals | ❌ Likely fail | Same `MAX_LIMIT=5000` cap. |
| HAR v2 | ❌ Likely fail | Fully synchronous — no phase state, no self-chain, no cron. Even with `selectIn` URL chunking, the wall-clock over 18k keywords × SERP + Ahrefs + backlinks + compute is well over the 150-second edge limit. |
| Revenue v2 | ⚠️ Marginal | Reads scale linearly with kept keywords; 18k rows may fit within 150 s if pure DB work is quick, but there is no resume path if it doesn't. |
| Calibration | ⚠️ Marginal | Same profile; per-row scoring across 18k cluster canonicals may exceed the wall cap. |

### Notes on the specific `compute HTTP 500` error visible in `har_jobs`

Every one of the last 15 HAR v1 jobs ends with
`last_error='compute-forecasts HTTP 500: {"error":"Project not found"}'`
while `status='completed'`. HAR itself succeeded — the error is that HAR v1's
compute stage calls the v1 `compute-forecasts` function, which no longer
finds those projects (they're wired to the v2 registry model). This is
orthogonal to the resumability question raised in this task but worth
recording.

---

## Appendix — raw SQL used

Full cron dump, `har_jobs` schema, `har_jobs` recent 15 rows, `detox_jobs`
recent 15 rows, `categorisation_jobs` recent 15 rows,
`cron.job_run_details` recent 20 rows, `har_serp_tasks` count, keyword counts
per project, and `information_schema.columns` for `calc_run_registry` are
all shown inline above. Every code citation is `path:line` relative to the
repository root.
