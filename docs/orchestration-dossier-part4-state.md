# Orchestration Dossier — Part 4: State & Runtime Evidence

Live evidence captured 2026-07-21 (~12:38 UTC). All figures produced by the SQL blocks shown below; nothing paraphrased.

## 4.1 Active pg_cron jobs

```sql
SELECT jobid, jobname, schedule, active, command FROM cron.job ORDER BY jobid;
```

| jobid | jobname | schedule | active | target function |
|-------|---------|----------|--------|-----------------|
| 1 | `url-monitor-tick-every-5-min` | `*/5 * * * *` | true | `url-monitor-tick` |
| 2 | `detox-jobs-tick` | `* * * * *` | true | `keyword-detox` (per detox job with stale heartbeat, mode=`tick`) |
| 4 | `categorisation-worker-tick` | `* * * * *` | true | `categorisation-deferred-tick` |
| 7 | `categorisation-live-resume` | `* * * * *` | true | `keyword-categorisation` (per **live**-tier job past `next_run_at` with stale heartbeat) |
| 8 | `har-worker-tick` | `* * * * *` | true | `har-calculation` (mode=`tick`) |

**Absent from cron entirely** — nothing wakes these functions after a browser tab closes:
- `keyword-enrichment` — user-triggered only.
- `gsc-workbook-import`, `gsc-intent-enrichment` — upload-driven only.
- `brand-classification` — kicked off by `BrandClassificationCard`, has heartbeat but no cron resume.
- `ctr-curves-from-gsc` — admin-triggered synchronous run.
- `keyword-cluster-recompute` — admin/panel-triggered.
- `dfs-core-keyword-backfill`, `base-rank-backfill`, `lps-authority-backfill` — admin backfills.
- `site-architecture` — client loop (`useNavigatorSync`) is the only driver.
- `har-calculation-v2` (**Revenue-facing HAR path**) — no cron equivalent to jobid 8; **v2 has no self-continuation**.
- `compute-forecasts-v2` — synchronous, single-invocation.
- `demand-signals-compute`, `link-power-score-compute` — synchronous, single-invocation, capped at `MAX_LIMIT = 5000` rows.
- `calibration-compute` — admin-triggered gate check.

## 4.2 Recent cron run outcomes

```sql
SELECT jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
ORDER BY start_time DESC LIMIT 30;
```

All 30 most-recent invocations returned `status='succeeded'`. Nothing failed; but jobid 2 has consistently returned `0 rows` (no detox jobs with stale heartbeat) while jobids 4/7/8 have been firing every minute and *finding work* (1–2 rows each). This is the mechanism that keeps the two zero-progress categorisation jobs' heartbeats fresh — see §4.3.

## 4.3 The stuck categorisation jobs — live snapshot

```sql
SELECT id, project_id, tier, status, processed, total,
       heartbeat_at, started_at, last_error, next_run_at, updated_at
FROM categorisation_jobs
WHERE status IN ('queued','running','rate_limited')
ORDER BY created_at ASC;
```

| id | project_id | tier | status | processed | total | started_at | heartbeat_at (2026-07-21) | last_error |
|----|-----------|------|--------|-----------|-------|-----------|---------------------------|------------|
| `8658e4c6-24fd-40dd-bf08-e08da076d115` | `91ce5998-3f04-44f3-b421-406a35ad4141` | live | queued | **0** | 36 | **2026-06-05 14:03:51 UTC** | **12:37:01 UTC** | NULL |
| `a3352949-1712-487b-9cc8-c88c91c7d2fd` | `2621b93f-d297-4e56-9837-50d3c5c2bb97` | live | queued | **0** | 36 | **2026-06-05 14:22:53 UTC** | **12:38:03 UTC** | NULL |
| `f8fb6408-f949-4d9d-a039-683608cd87ba` | `bf1a48b0-bffb-4647-a151-b64377a7bf1b` | live | queued | 927 | 970 | 2026-05-06 12:23:45 UTC | 12:38:03 UTC | NULL |

**Interpretation for the advisor:**

- The two 36-keyword jobs have been "queued" for **46 days** with `processed=0` and no recorded `last_error`. Cron jobid 7 (`categorisation-live-resume`) invokes `keyword-categorisation` for them every minute; the function updates `heartbeat_at` on entry but returns 0 processed rows and sets a fresh `next_run_at`. The queue-liveness dashboard (`useBackgroundJobs.ts`) therefore renders them as *active* rather than *stalled*: `heartbeat_at` never crosses the 5-minute `STALE_HEARTBEAT_S` threshold. This is the root of "queued forever with no error surface".
- The 970-keyword job is 95.6% complete (927/970) and still ticking. Its 43-keyword remainder is the mirror-image failure mode: those 43 rows have hit `categorisation_attempts >= 5` and are excluded by `claim_categorisation_batch`, so the job never finishes.
- No `detox_jobs` and no `har_jobs` are currently in a running/queued state.

```sql
SELECT id, project_id, status, phase, ... FROM har_jobs WHERE status NOT IN ('completed','error');
-- 0 rows
SELECT id, project_id, status, processed, total, heartbeat_at, last_error FROM detox_jobs WHERE status IN ('queued','running');
-- 0 rows
```

## 4.4 Table schemas (verbatim `information_schema`)

```sql
SELECT table_name, string_agg(column_name || ' ' || data_type ||
       CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END ||
       CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
       E'\n  ' ORDER BY ordinal_position) AS cols
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('detox_jobs','categorisation_jobs','har_jobs',
                     'har_serp_tasks','har_ahrefs_queue','har_backlinks_queue',
                     'brand_classification_jobs','content_plan_jobs',
                     'gsc_upload_keywords','gsc_uploads','keywords')
GROUP BY table_name ORDER BY table_name;
```

### `brand_classification_jobs`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
project_id uuid NOT NULL
status text NOT NULL DEFAULT 'queued'::text
total_keywords integer NOT NULL DEFAULT 0
processed_keywords integer NOT NULL DEFAULT 0
branded_count integer NOT NULL DEFAULT 0
non_branded_count integer NOT NULL DEFAULT 0
uncertain_resolved_count integer NOT NULL DEFAULT 0
ai_calls integer NOT NULL DEFAULT 0
brand_tokens jsonb
last_error text
heartbeat_at timestamptz
started_at timestamptz
finished_at timestamptz
created_at timestamptz NOT NULL DEFAULT now()
updated_at timestamptz NOT NULL DEFAULT now()
```

### `categorisation_jobs`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
project_id uuid NOT NULL
tier text NOT NULL DEFAULT 'live'::text        -- CHECK IN ('live','deferred')
status text NOT NULL DEFAULT 'queued'::text    -- CHECK IN ('queued','running','rate_limited','done','error')
total integer NOT NULL DEFAULT 0
processed integer NOT NULL DEFAULT 0
started_at timestamptz
finished_at timestamptz
heartbeat_at timestamptz
last_error text
created_at timestamptz NOT NULL DEFAULT now()
updated_at timestamptz NOT NULL DEFAULT now()
from_rules integer NOT NULL DEFAULT 0
from_cache integer NOT NULL DEFAULT 0
from_fast_path integer NOT NULL DEFAULT 0
from_ai integer NOT NULL DEFAULT 0
rate_limited_count integer NOT NULL DEFAULT 0
attempts integer NOT NULL DEFAULT 0
next_run_at timestamptz NOT NULL DEFAULT now()
rate_limited_until timestamptz
```

### `content_plan_jobs`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
plan_id uuid
client_id uuid NOT NULL
project_id uuid NOT NULL
status text NOT NULL DEFAULT 'queued'::text
total integer NOT NULL DEFAULT 0
processed integer NOT NULL DEFAULT 0
last_error text
started_at timestamptz
finished_at timestamptz
created_at timestamptz NOT NULL DEFAULT now()
updated_at timestamptz NOT NULL DEFAULT now()
```

### `detox_jobs`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
project_id uuid NOT NULL
status text NOT NULL DEFAULT 'queued'::text
total integer NOT NULL DEFAULT 0
processed integer NOT NULL DEFAULT 0
kept integer NOT NULL DEFAULT 0
removed integer NOT NULL DEFAULT 0
last_error text
heartbeat_at timestamptz
started_at timestamptz
finished_at timestamptz
created_at timestamptz NOT NULL DEFAULT now()
updated_at timestamptz NOT NULL DEFAULT now()
block_reason text
```

### `har_ahrefs_queue`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
job_id uuid NOT NULL              -- FK → har_jobs(id) ON DELETE CASCADE
project_id uuid NOT NULL          -- FK → navigator_projects
target_url text NOT NULL
target_mode text NOT NULL DEFAULT 'exact'
status text NOT NULL DEFAULT 'pending'
attempts integer NOT NULL DEFAULT 0
locked_at timestamptz
url_rating numeric
domain_rating numeric
ahrefs_rank integer
last_error text
created_at timestamptz NOT NULL DEFAULT now()
```

### `har_backlinks_queue`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
job_id uuid NOT NULL              -- FK → har_jobs
project_id uuid NOT NULL
target_url text NOT NULL
status text NOT NULL DEFAULT 'pending'
attempts integer NOT NULL DEFAULT 0
locked_at timestamptz
referring_domains integer
backlinks bigint
last_error text
created_at timestamptz NOT NULL DEFAULT now()
```

### `har_jobs`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
project_id uuid NOT NULL
status text NOT NULL DEFAULT 'pending'
phase text                          -- post_serp | poll_serp | fetch_ahrefs | fetch_backlinks | compute
total_keywords integer NOT NULL DEFAULT 0
serp_tasks_total integer NOT NULL DEFAULT 0
serp_tasks_posted integer NOT NULL DEFAULT 0
serp_tasks_done integer NOT NULL DEFAULT 0
ahrefs_targets_total integer NOT NULL DEFAULT 0
ahrefs_targets_done integer NOT NULL DEFAULT 0
backlinks_targets_total integer NOT NULL DEFAULT 0
backlinks_targets_done integer NOT NULL DEFAULT 0
backlinks_skipped boolean NOT NULL DEFAULT false
har_rows_done integer NOT NULL DEFAULT 0
attempts integer NOT NULL DEFAULT 0
next_run_at timestamptz NOT NULL DEFAULT now()
locked_at timestamptz
last_error text
started_at timestamptz
completed_at timestamptz
created_at timestamptz NOT NULL DEFAULT now()
updated_at timestamptz NOT NULL DEFAULT now()
```

Uniqueness: `uniq_har_jobs_active_per_project` (partial `WHERE status NOT IN ('completed','error')`) forbids two concurrent v1 HAR jobs on the same project.

### `har_serp_tasks`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
job_id uuid NOT NULL               -- FK → har_jobs
project_id uuid NOT NULL
keyword_id uuid NOT NULL           -- FK → keywords
keyword text NOT NULL
dfs_task_id text
status text NOT NULL DEFAULT 'queued'      -- queued → posted → done|error
attempts integer NOT NULL DEFAULT 0
locked_at timestamptz
posted_at timestamptz
fetched_at timestamptz
last_error text
created_at timestamptz NOT NULL DEFAULT now()
```

### `gsc_uploads`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
project_id uuid NOT NULL
uploaded_at timestamptz NOT NULL DEFAULT now()
device text NOT NULL DEFAULT 'mobile'
row_count integer NOT NULL DEFAULT 0
date_range_start date
date_range_end date
source text NOT NULL DEFAULT 'legacy_csv'
```

### `gsc_upload_keywords`
```
id uuid NOT NULL DEFAULT gen_random_uuid()
upload_id uuid NOT NULL       -- FK → gsc_uploads(id) ON DELETE CASCADE
keyword text NOT NULL
clicks integer NOT NULL DEFAULT 0
impressions integer NOT NULL DEFAULT 0
ctr numeric NOT NULL DEFAULT 0
position numeric NOT NULL DEFAULT 0
search_intent text
device text
is_branded boolean
brand_confidence numeric
```

### `keywords` (excerpt — 53 columns)
Full list produced by the query in §4.4 above. Fields relevant to orchestration:
```
detox_status text NOT NULL DEFAULT 'pending'    -- CHECK IN ('pending','keep','flagged_remove','removed')
categorisation_status text NOT NULL DEFAULT 'pending'  -- CHECK IN ('pending','processing','done','error','skipped')
categorisation_tier text                        -- 'live' | 'deferred'
categorisation_attempts integer NOT NULL DEFAULT 0
categorisation_locked_at timestamptz
tag_1..tag_5 text                               -- populated by categorisation
cluster_key text, cluster_canonical_keyword_id uuid, cluster_source text, cluster_member_count integer, cluster_computed_at timestamptz
base_rank integer, base_rank_source text        -- 'serp_results' | 'dfs_labs'
volume_fetched_at timestamptz, ranking_lookup_checked_at timestamptz
```

Unique constraint: `keywords_project_keyword_unique (project_id, keyword)`.

## 4.5 Indexes on orchestration tables

```sql
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('har_jobs','har_serp_tasks','detox_jobs','categorisation_jobs',
                    'har_ahrefs_queue','har_backlinks_queue',
                    'brand_classification_jobs','content_plan_jobs')
ORDER BY tablename, indexname;
```

Key partial indexes powering the cron dispatch:

- `idx_categorisation_jobs_due` — `(status, next_run_at)` WHERE status IN ('queued','running','rate_limited'). Matches jobid 7 predicate.
- `uniq_categorisation_jobs_active` — one active row per `(project_id, tier)`; prevents duplicate categorisation launches.
- `idx_detox_jobs_status_heartbeat` — `(status, heartbeat_at)` for jobid 2 detection.
- `idx_har_jobs_runnable` — `next_run_at` WHERE status NOT IN ('completed','error'); enables jobid 8 to select runnable jobs cheaply.
- `idx_har_ahrefs_locked`, `idx_har_serp_tasks_locked` — WHERE status='processing'|'posted' for `release_stale_har_claims()`.
- `uniq_har_ahrefs_job_target`, `uniq_har_backlinks_job_target` — idempotent target enqueue.
- `idx_har_serp_tasks_job_status`, `idx_har_serp_tasks_dfs_id` — powers `claim_har_serp_*` RPCs and DFS polling by task id.

## 4.6 RLS policies on orchestration tables

Full query is in §4 heading. Every policy is `roles=authenticated`. There is no `service_role` bypass policy — edge functions rely on the SUPABASE_SERVICE_ROLE_KEY grant + `SECURITY DEFINER` RPCs (`claim_*_batch`, `bulk_update_*`, `release_stale_*`) which set `search_path` and side-step RLS by definition.

Sample (categorisation_jobs):
```
Internal users full access to categorisation_jobs | ALL | roles=authenticated
  USING = get_user_role(auth.uid()) IN ('super_admin','admin')
          OR (get_user_role(auth.uid()) = 'user' AND is_visible_project(project_id))
View-only see assigned categorisation_jobs | SELECT | roles=authenticated
  USING = get_user_role(auth.uid()) = 'view_only' AND project_id IN (…user's assigned projects…)
```

`har_ahrefs_queue`, `har_backlinks_queue`, `har_serp_tasks` all carry an *additional* legacy "Internal scoped access …" ALL policy on top of the newer "Internal users full access …" one. Both are visible in `pg_policies`. This is redundant, not conflicting (Postgres RLS uses OR across policies) and is not the cause of the stuck jobs.

## 4.7 Constraints (CHECK / FK) worth naming

Selected from `pg_constraint` (see query in Part 1 §1.6):

- `categorisation_jobs_status_check` — status ∈ {queued, running, rate_limited, done, error}.
- `categorisation_jobs_tier_check` — tier ∈ {live, deferred}.
- `keywords_detox_status_check` — detox_status ∈ {pending, keep, flagged_remove, removed}.
- `keywords_categorisation_status_check` — includes `skipped`.
- `keywords_source_check` — source ∈ {dataforseo, ahrefs, gsc, all, manual}.
- `keywords_base_rank_source_check` — ∈ {serp_results, dfs_labs}.
- `keywords_project_keyword_unique` — one row per (project_id, keyword).
- All *_project_id_fkey → navigator_projects(id) ON DELETE CASCADE. All *_job_id_fkey → parent job ON DELETE CASCADE.

## 4.8 Row-count / caps ceiling summary

| Function | Cap | Source |
|----------|-----|--------|
| `demand-signals-compute` | `MAX_LIMIT = 5000` | `supabase/functions/demand-signals-compute/index.ts:36` |
| `link-power-score-compute` | `MAX_LIMIT = 5000` | `supabase/functions/link-power-score-compute/index.ts:37` |
| `site-architecture` | `AI_BATCH_SIZE = 30`, retry `AI_RETRY_BATCH_SIZE = 10`; client caps 40 invocations per Sync-Now button press (see Part 3 `useNavigatorSync.ts`) | Part 2 §site-architecture / Part 3 useNavigatorSync |
| `keyword-categorisation` `claim_categorisation_batch` | `attempts < 5` — permanently skipped past that | Part 1 §1.7 RPC |
| `har_ahrefs_queue` / `har_backlinks_queue` `claim_*` | `attempts < 3` — permanently skipped past that | Part 1 §1.7 |
| `har_serp_tasks` post RPC | `attempts < 4`; fetch RPCs `attempts < 6` | Part 1 §1.7 |

**Implication at 18k keywords:**
- 18,000 exceeds the 5,000 caps for demand-signals and LPS by 3.6×; three sequential invocations minimum, and neither function has resume/cursor logic.
- 18,000 keywords through `site-architecture` at 30 per invocation is 600 AI batches; the client will exhaust its 40-invocation ceiling after ~1,200 keywords.
- 18,000 SERP tasks × 4 attempts is the theoretical retry ceiling; the actual invocation ceiling comes from the pg_cron once-per-minute cadence of jobid 8. Empirically a single HAR run of 970 kept keywords currently completes; extrapolating to 18k gives no reason to believe throughput remains linear because `har-calculation-v2` (the Revenue-facing path) is not on cron at all.
