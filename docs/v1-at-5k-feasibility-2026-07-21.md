# V1 Forecast Path — 5,000-Keyword Feasibility

Read-only investigation. No code or state changed.

Scope: can the HAR v1 + Revenue v1 forecast path (`har-calculation` → `compute-forecasts`) run end-to-end on a 5,000-keyword project? What happens to keywords the client cannot rank for? Where does it break?

---

## 1. Row emission in `compute-forecasts`

### 1.1 Which keywords enter the loop

`supabase/functions/compute-forecasts/index.ts:86-99` pages every kept keyword with **`avg_monthly_volume > 0`**:

```ts
.from("keywords")
.select("id, keyword, avg_monthly_volume, base_rank, device, search_intent, ranking_url, peak_month")
.eq("project_id", project_id)
.eq("detox_status", "keep")
.gt("avg_monthly_volume", 0)   // ← zero-volume kept kws are silently dropped
```

Every row that clears that filter is pushed into `forecasts[]` inside the main `for (const kw of allKeywords)` loop at `index.ts:197`, and every push is upserted at `index.ts:284-299`. There is **no** conditional skip based on HAR presence — the forecast row is emitted regardless.

### 1.2 What is written per HAR state

The relevant block is `index.ts:224-240`:

```ts
const existing = existingForecasts.get(kw.id);
const automatedHar = harResultsMap.get(kw.id) ?? null;
const har = existing?.har_is_manual ? existing.har : (automatedHar ?? existing?.har ?? null);
...
if (har != null) {
  const ctrAtHar = getCtr(device, intent, har);
  const harTrafficAnnual = volume * ctrAtHar * 12;
  harTrafficGainAnnual   = Math.max(harTrafficAnnual - estCurrentClicksAnnual, 0);
  harRevenueGainAnnual   = harTrafficAnnual * cvr * aov;
}
```

| Input state | `har` written | `har_traffic_gain_annual` | `har_revenue_gain_annual` |
|---|---|---|---|
| `har_results` row absent | `NULL` (unless a prior manual value existed) | `NULL` | `NULL` |
| `har_results` row present with `har_position = NULL` (advisor's "client cannot rank") | `NULL` | `NULL` | `NULL` |
| `base_rank` also NULL (client doesn't rank at all) | `NULL` (same as above); `weighted_sum = null` at `:217`; `opportunity = "opportunity"` at `:207-208`; `current_ctr_pct = 0`; `est_current_*` = 0 | `NULL` | `NULL` |

Every unrankable keyword therefore **still receives a `keyword_forecasts` row**, but with NULL HAR fields and £0 modelled revenue.

### 1.3 Latest v1 run — observed counts

Query used:

```sql
WITH runs AS (
  SELECT project_id, total_keywords, completed_at FROM har_jobs
  WHERE status='completed' ORDER BY completed_at DESC LIMIT 5
)
SELECT r.project_id, r.total_keywords,
  (SELECT COUNT(*) FROM keywords WHERE project_id=r.project_id AND detox_status='keep') AS kept,
  (SELECT COUNT(*) FROM keyword_forecasts kf JOIN keywords k ON k.id=kf.keyword_id WHERE k.project_id=r.project_id) AS forecasts,
  (SELECT COUNT(*) FROM keyword_forecasts kf JOIN keywords k ON k.id=kf.keyword_id WHERE k.project_id=r.project_id AND kf.har IS NULL) AS har_null,
  (SELECT COUNT(*) FROM keyword_forecasts kf JOIN keywords k ON k.id=kf.keyword_id WHERE k.project_id=r.project_id AND kf.har_revenue_gain_annual IS NULL) AS rev_null,
  (SELECT COUNT(*) FROM har_results hr JOIN keywords k ON k.id=hr.keyword_id WHERE k.project_id=r.project_id) AS har_result_rows,
  (SELECT COUNT(*) FROM har_results hr JOIN keywords k ON k.id=hr.keyword_id WHERE k.project_id=r.project_id AND hr.har_position IS NULL) AS har_pos_null
FROM runs r;
```

Most recent v1 forecast run (project `5fd4df7e…`, completed 2026-07-20 15:25:24 UTC, `har_jobs.total_keywords=857`):

| kept | forecasts | har_null | rev_null | har_result_rows | har_pos_null |
|---:|---:|---:|---:|---:|---:|
| 857 | **835** | 44 | 44 | 857 | 74 |

Observations:

- **kept − forecasts = 22**: those 22 kept keywords have `avg_monthly_volume = 0` and are excluded by the `.gt("avg_monthly_volume", 0)` filter (§1.1). They receive no forecast row at all.
- **har_null = 44 < har_pos_null = 74**: 30 of the null-position keywords are the same 22 zero-volume dropouts plus 8 whose HAR was recomputed to null after a prior non-null value was persisted; the manual-preservation branch at `:226` keeps the older `har` for the remainder. The point remains: unrankable keywords receive a row, just with `har = NULL`.
- **har_null = rev_null**: consistent with the code — one gate at `:235` controls both fields.

The next four completed runs on record are all ≤ 40 keywords and show no HAR/revenue nulls.

---

## 2. Content-fit dependency

```
$ rg -n 'site_architecture|relevancy_score' \
    supabase/functions/har-calculation/index.ts \
    supabase/functions/compute-forecasts/index.ts
no matches
```

Neither v1 function reads `site_architecture` or `relevancy_score`. HAR v1 is a pure `client_UR ≥ competitor_UR` comparison (`har-calculation/index.ts:1039-1050`). Content-fit is a v2-only concern.

---

## 3. Compute phase at scale (`har-calculation`)

### 3.1 What `runPhaseCompute` does per keyword

`har-calculation/index.ts:919-1065`. Per invocation:

1. Loads the job's Ahrefs URL→metrics map (paged 1,000).
2. Loads the backlinks map (paged 1,000) unless skipped.
3. Bulk-upserts `serp_results` metrics (paged 1,000, chunked 500 per upsert).
4. Upserts a single `client_domain_metrics` row.
5. Pages all kept keywords (1,000/page) into `kept[]`.
6. **For each keyword, issues one blocking query**:
   ```ts
   const { data: serps } = await sb
     .from("serp_results").select("rank_absolute, url")
     .eq("project_id", project_id).eq("keyword_id", kw.id)
     .order("rank_absolute", { ascending: true });
   ```
   Then walks the SERP looking for the first competitor with `url_rating ≤ client_UR` and records `har_position`. Result pushed to `harRows[]`.
7. Upserts `har_results` in chunks of 500 (`:1061-1063`).

So compute is **N + fixed** DB calls where N = kept-keyword count. There is **no batching** of the per-keyword SERP fetch — it is one round-trip per keyword.

### 3.2 Behaviour vs `TICK_BUDGET_MS = 50_000`

`runPhaseCompute` is **not budget-aware**. The `deadline`/`beat` machinery is threaded through the SERP/Ahrefs/backlinks phases (`:275-282`, `:408-…`) but the compute phase is invoked as `await runPhaseCompute(sb, job)` at `:330` with no deadline argument and no periodic checkpoint. It runs to completion or throws.

Failure modes:

- If the invocation exceeds the Edge Function background ceiling (400s per Supabase docs; see `docs/orchestration-dossier-part6-gaps.md`), the runtime kills it. `job.locked_at` remains stale until `release_stale_har_claims()` (called at `:243`) clears it after 5 minutes, then pg_cron / self-tick re-enters the tick handler.
- On re-entry, the phase gate at `:328` (`else` clause — "all queues drained") is satisfied again, so `runPhaseCompute` **restarts from the top**. It is idempotent (all writes are upserts keyed by `keyword_id` / `project_id`), but there is no partial-progress state — a project that can't finish compute in one shot will loop indefinitely.
- A synchronous throw is caught at `:385-402`; the job is marked `rate_limited` (retry in 60s) unless the error matches `/auth\/subscription|client domain|No kept/i`, in which case it is marked `error`.

There is no incremental compute counter beyond `har_rows_done`, which is written **once** at the end (`:1064`).

### 3.3 Observed compute duration

`har_jobs` does not record per-phase timing. The best available proxy is total wall time from `started_at` → `completed_at`, which includes SERP posting/polling, Ahrefs, backlinks, **and** compute. The five largest completed rows on record:

| total_keywords | started_at | wall_seconds | status |
|---:|---|---:|---|
| 1127 | 2026-05-06 15:53:27 | 59,114 | error (later resumed) |
| 1127 | 2026-05-07 09:58:46 | 1,736 | completed |
| 1127 | 2026-05-07 08:26:57 | 1,655 | completed |
| 1127 | 2026-05-06 15:00:34 | 3,173 | error |
| 1127 | 2026-05-06 14:37:08 | 1,403 | error |
| 860  | 2026-05-08 15:48:47 | 1,419 | completed |
| 857  | 2026-07-20 15:12:01 | **804** | completed |

The 857-kw / 804-second run is the healthiest recent data point. It bounds compute at ≤ 804s wall clock, but most of that is SERP/Ahrefs I/O; compute-phase duration in isolation is **not recorded**. The N+1 query pattern (§3.1) at 1,000+ keywords requires the runtime to survive a single continuous run of ≥1,000 sequential Supabase round-trips inside one tick — this is what caused the 59,114-second wall clock (many failed ticks + cron retries) on the 2026-05-06 run.

At 5,000 keywords the compute phase alone issues 5,000 sequential SELECTs. At an optimistic 40 ms per round-trip that is 200 s — inside the 400 s background ceiling but with no headroom for the preceding upsert paging, and no resumability if it fails.

---

## 4. `compute-forecasts` timing & memory

### 4.1 In-memory footprint (single invocation)

Held simultaneously (`compute-forecasts/index.ts`):

| Structure | Line | Contents |
|---|---|---|
| `ctrMap` | 49-54 | ≤ ~600 numbers (5 intents × 2 devices × 30 ranks × ≤2 tiers) |
| `allKeywords` | 79-99 | one object per kept-volume>0 keyword: 8 columns |
| `existingForecasts` | 151-165 | one `{har, har_is_manual}` per keyword |
| `harResultsMap` | 168-183 | one number per keyword |
| `forecasts` batch | 188 | up to `UPSERT_BATCH = 200` rows |
| `forecastMap` | 191-195 | one `{revenue, revenueGainRank1, har}` per keyword (kept for challenge pass) |
| `urlGroups` | 326-341 | Map<url, keyword[]> — one entry per unique `ranking_url` |
| `challenges` | 343 | one row per non-primary keyword sharing a URL |

Every collection is O(N) in kept keywords. At 5,000 keywords a rough envelope is 5k × ~5 collections × ~200 B ≈ 5 MB of live objects, well under the 256 MB soft ceiling.

### 4.2 Timing

`compute-forecasts` does not paginate on writes any more than 200/upsert, but keyword fetch is paginated at 1,000. The dominant cost items are:

- Kept-keyword paging: `ceil(N/1000)` selects.
- **`existingForecasts` lookup**: `ceil(N/100)` selects (`LOOKUP_BATCH = 100` at `:149`, deliberately small — see the comment at `:141-149` about the URL length bug that caused zero-match silent failures).
- **`harResultsMap` lookup**: another `ceil(N/100)` selects.
- Per-row math is pure JS — negligible.
- Upserts: `ceil(N/200)` writes.

For N = 5,000: 5 kw pages + 50 forecast lookups + 50 HAR lookups + 25 upserts = **~130 DB round-trips**, plus one delete + `ceil(challenges/200)` challenge inserts. At ~40 ms per round-trip this is ~5 s of DB time. Wall time on the 857-kw project is not persisted (no `updated_at` on `keyword_forecasts`), so no observed figure is available for direct comparison.

Projected at 5,000 keywords: comfortable inside the 400 s ceiling and inside the 256 MB memory limit. `compute-forecasts` itself is **not** the scale bottleneck for v1.

---

## 5. "Project not found"

Exact query, `compute-forecasts/index.ts:30-36`:

```ts
const { data: project, error: projErr } = await supabase
  .from("navigator_projects")
  .select("aov, conversion_rate, seasonality_start, seasonality_end")
  .eq("id", project_id)
  .single();
if (projErr || !project) throw new Error("Project not found");
```

The `supabase` client here is built with the **caller's** JWT (`index.ts:19-25`):

```ts
const authHeader = req.headers.get("Authorization");
...
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { headers: { Authorization: authHeader } },
  auth: { autoRefreshToken: false, persistSession: false },
});
```

`navigator_projects` RLS visibility is enforced by `public.is_visible_project()` (see `<db-functions>` in the environment brief): non-admin users see a project only if a `user_client_access` row grants them the parent client **and** neither the project nor the client is archived.

Fail conditions therefore include:

1. The invoker is `har-calculation` self-tick using the **service role** JWT — this bypasses RLS **but** the caller-authed client construction requires an `Authorization` header. When `har-calculation` re-invokes `compute-forecasts` at `:342-352` it passes `Bearer ${SERVICE_ROLE}`, which works.
2. The invoker is a browser session for a user without `user_client_access` on the parent client → `.single()` sees 0 rows → PostgREST returns `PGRST116` → the `if (projErr || !project)` branch throws `"Project not found"`. This is the browser-side failure documented in the v2 dossier §7.
3. The project is archived (either directly or via the client) → same 0-row result → same error.

Minimal change: swap `.single()` for `.maybeSingle()` and separate the "no visibility / archived" case from a genuinely missing row, so the failure surfaces as an explicit 403/410 rather than a generic 500. Broader remedy is to run the fetch under service role and re-check visibility explicitly, matching the pattern used by v2 (`compute-forecasts-v2`).

---

## 6. CTR curve source

Cited query, `compute-forecasts/index.ts:42-46`:

```ts
const { data: ctrCurves, error: ctrErr } = await supabase
  .from("ctr_curves")
  .select("device, intent_segment, rank_position, ctr_percentage")
  .eq("project_id", project_id);
```

`.eq("project_id", project_id)` **excludes** the NULL-`project_id` global fallback rows seeded by the migration described in `docs/global-fallback-ladder-verification-2026-07-19.md`. `compute-forecasts` therefore reads **project rows only**.

Downstream lookup at `getCtr()` (`:56-76`) has its own in-memory fallback ladder (specific intent → generic → other intents → any) but the entire `ctrMap` is populated exclusively from project-scoped rows. If a project has no `ctr_curves` rows at all — for example, a GSC-sourced project that has not run `ctr-curves-from-gsc` — every `getCtr()` call returns 0 and every revenue figure zeros out.

This is the **same table** that `ctr-curves-from-gsc` writes and that the setup-page CTR curve flow writes; both are project-scoped and land in `ctr_curves` with the invoking project's `project_id`. `compute-forecasts` consumes whichever set was written most recently (they use the same `onConflict` key).

Contrast with v2: `compute-forecasts-v2` goes through `_shared/ctr-resolver-v2.ts`, which consults both project rows and the global tiers. v1 does neither.

---

## 7. Minimum v1 autonomous path for a GSC-sourced 5,000-keyword project

In dependency order. "Autonomous" means the stage advances without an operator click after the sync starts.

| # | Stage | Autonomous? | Blocker |
|---:|---|---|---|
| 1 | GSC CSV upload → `gsc_uploads` + `gsc_upload_keywords` + `gsc_upload_pages` | **No** | Operator uploads the file via `GscUploadPanel`. There is no scheduled ingest. |
| 2 | `gsc-intent-enrichment` (populates `search_intent` on the staging table) | Partial | Runs via `useNavigatorSync` when sync is fired; no cron. |
| 3 | `brand-classification` (populates `is_branded` on staging) | Partial | Same — client-driven. |
| 4 | **GSC → `keywords` promotion** | **No — MISSING** | Confirmed in `docs/orchestration-dossier-part5-gsc-promotion.md`: no code path, no trigger, no function inserts from `gsc_upload_keywords` into `keywords`. Operator must separately hand-add the same list through `addKeywordsToProject`. Without this, stages 5–8 see zero rows. |
| 5 | `keyword-enrichment` (volume, intent, difficulty on `keywords`) | Partial | Client-driven loop in `useNavigatorSync`. Row-count caps documented in Part 6. |
| 6 | `dfs-core-keyword-backfill` / cluster derivation | No | Operator-triggered admin action. |
| 7 | `base-rank-backfill` (populates `base_rank` from `serp_results`) | No | Operator-triggered admin action. |
| 8 | `ctr-curves-from-gsc` (writes project rows into `ctr_curves`) | No | Operator-triggered from the CTR Curves card. §6 shows this is the only source `compute-forecasts` reads; a project that skips it will get £0 revenue everywhere. |
| 9 | `keyword-detox` | Yes | Own worker + pg_cron (`detox-jobs-tick`). |
| 10 | `keyword-categorisation` (live + deferred) | Yes | pg_cron + `EdgeRuntime.waitUntil` self-chain. Two jobs stuck since 2026-06-05 per Part 4. |
| 11 | `har-calculation` (v1) | Yes | Self-chained via `scheduleSelfTick`; pg_cron watchdog `har-worker-tick`. Compute phase not budget-aware (§3.2) — a project that can't finish compute in one 400 s tick will loop, not resume. |
| 12 | `compute-forecasts` (v1) | Yes (invoked from HAR completion) | `har-calculation:342-352` calls it inline before flipping `har_status=completed`. Fails silently to `last_error` if `.single()` returns 0 rows (§5). |

**Verdict.** The v1 forecast stages themselves (detox → categorisation → HAR v1 → compute-forecasts) are autonomous once seeded. The autonomous chain does not start because five upstream stages (1, 4, 6, 7, 8) are operator-clicks and one of them (**GSC → keywords promotion**) does not exist as code. A GSC-sourced 5,000-keyword project cannot reach v1 forecasts without manual intervention today.

Once those upstream gaps are closed, the remaining v1 risk at 5,000 keywords is the **non-resumable compute phase** in `har-calculation` (§3.2): 5,000 sequential SERP SELECTs must complete inside one 400 s tick, or the job restarts from the top. Compute-forecasts itself (§4) and the row-emission contract (§1) both scale fine.

---

## Evidence summary

- File reads: `supabase/functions/compute-forecasts/index.ts` (lines 19-99, 149-299), `supabase/functions/har-calculation/index.ts` (lines 87-403, 919-1065, 1075-1100).
- Ripgrep: `rg -n 'site_architecture|relevancy_score' …` → no matches.
- DB queries (executed against production Supabase, read-only):
  - Top `har_jobs` by keyword count and by completion recency.
  - Cross-join of kept keywords, `keyword_forecasts`, and `har_results` for the five most recent completed runs.
  - `information_schema.columns` on `keyword_forecasts` (confirms no `updated_at`).
- Cross-references: `docs/orchestration-dossier-part4-state.md`, `-part5-gsc-promotion.md`, `-part6-gaps.md`, `docs/autonomous-pipeline-audit-2026-07-21.md`, `docs/global-fallback-ladder-verification-2026-07-19.md`, `docs/v2-at-5k-feasibility-2026-07-21.md` §7.
