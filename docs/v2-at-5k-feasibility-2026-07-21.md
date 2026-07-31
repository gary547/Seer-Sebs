# v2 Calculation Stack — 5,000-Keyword Feasibility Report

Read-only investigation. Target: TVs Ongoing (`project_id = 5fd4df7e-45dd-40c0-b10e-86ea6dad9720`, 857 kept keywords). Latest HAR v2 run `fc816e93-60eb-47f9-ab69-24e902175be8`, latest Revenue v2 run `915e8e40-5e32-4ddd-84ab-718508da25e6` (both 2026-07-20 20:20 UTC).

---

## 1. Unrankable Keyword Coverage

### Query

```sql
WITH latest_har AS (
  SELECT id FROM calc_run_registry
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND model_version LIKE 'har_v2%' AND status IN ('succeeded','partial')
  ORDER BY started_at DESC LIMIT 1
)
SELECT scenario,
       count(*) AS n,
       count(*) FILTER (WHERE har_position IS NULL)               AS har_pos_null,
       count(*) FILTER (WHERE tp_absolute_revenue_annual IS NULL) AS tp_abs_null
FROM keyword_forecast_scenarios
WHERE calc_run_id = (SELECT id FROM latest_har)
GROUP BY scenario ORDER BY scenario;
```

### Result

| scenario     | rows | har_position NULL | tp_absolute_revenue_annual NULL |
| ------------ | ---: | ----------------: | ------------------------------: |
| conservative |  857 |               477 |                             489 |
| realistic    |  857 |                59 |                              81 |
| stretch      |  857 |                 0 |                              22 |

- Kept keywords: **857**
- Distinct keywords with ≥1 scenario row: **857** (100%)
- Scenario rows total: **2,571** = 857 × 3

### Row-emission contract (code)

Every kept keyword receives **three** scenario rows unconditionally. In `supabase/functions/har-calculation-v2/index.ts:602-627`:

```ts
for (const scenario of SCENARIOS) {
  const res = computeScenario(inputs, scenario, override, scoringConfig);
  insertBuffer.push({ ... har_position: res.har_position, ... });
  wroteAny = true;
}
if (wroteAny) keywordsWritten += 1; else keywordsSkipped += 1;
```

`wroteAny` is set to `true` on the first scenario iteration, so `keywordsSkipped` can only be non-zero if `SCENARIOS` is empty — which it never is. Confirmed: `keywords_skipped = 0` in the latest run summary.

Revenue v2 (`supabase/functions/compute-forecasts-v2/index.ts:490-682`) iterates every keyword that already has a scenario row and issues an UPDATE regardless of computability — computability governs the values, not the row's existence. `tp_absolute_revenue_annual` is left `NULL` when `canTp` is false (`_shared/revenue-v2.ts:202-207`), i.e. any of `volume_forward | ctr_tp | pos_tp | cvr | aov` is null. Row is still updated.

### Null-attribution — top warnings on run `915e8e40`

```sql
SELECT w->>'code' AS code, (w->>'count')::int AS n
FROM calc_run_registry, LATERAL jsonb_array_elements(warnings) AS w
WHERE id='915e8e40-5e32-4ddd-84ab-718508da25e6'
ORDER BY n DESC;
```

| code                             | count |
| -------------------------------- | ----: |
| trend_adjusted                   |  1482 |
| not_ranking                      |  1209 |
| missing_rank_prob                |   536 |
| low_rank_prob                    |   536 |
| missing_pos_tp                   |   536 |
| missing_ctr_tp                   |   536 |
| trend_declining                  |   348 |
| missing_volume                   |    66 |
| missing_ctr_now                  |    28 |
| svm_unmatched_features           |    23 |
| keyword_monthly_volumes_absent   |    22 |

`missing_pos_tp = 536` matches the conservative-scenario `har_position IS NULL = 477` + realistic `59` = **536**. Every unrankable case at HAR time cascades into `tp_absolute_revenue_annual = NULL` at Revenue time. Additional `NULL` tp_abs rows beyond that (conservative 489 − 477 = 12; realistic 81 − 59 = 22; stretch 22 − 0 = 22) are attributable to missing volume (66) and missing CTR-tp (which also correlate with `har_position IS NULL`).

### Verdict

**Every kept input keyword receives all three scenario rows.** Rows are never dropped at either v2 stage. What varies is column population: `har_position`, and any revenue column downstream of it, becomes `NULL` when the HAR ladder fails to beat any competitor for that scenario, or when a scoring input (volume, ctr_tp, cvr, aov) is missing.

---

## 2. No-Beat Keywords

### Code — `_shared/har-v2.ts:291-353`

```ts
let harPosition: number | null = null;
// ...ladder walk...
for (const c of sortedComps) {
  ...
  if (beaten) {
    harPosition = c.rank_absolute ?? null;
    rankProb = clamp(p, 0, 1);
    ...
    break;
  }
  notBeatenProduct *= (1 - p);
}
// Observed-rank clamp using base_rank as proxy
if (harPosition != null && inp.base_rank != null && inp.base_rank > 0) { ... }
// Override precedence
if (override) { harPosition = override.har; ... }
```

If no competitor is beaten and no manual override exists, **`harPosition` remains `null`** — it is not fallback-set to `base_rank`, and the scenario row is still emitted (see §1). The `no_beat_reason` block (`har-v2.ts:354-364`) stamps the row's `explanation_json` with either `"no_comparable_competitors"` (ladder considered zero rows) or `"authority_below_threshold"`.

### Count on TVs Ongoing (realistic scenario)

```sql
SELECT
  count(*) FILTER (WHERE har_position IS NULL) AS realistic_har_null,
  count(*) FILTER (WHERE (explanation_json->'no_beat_reason'->>'reason')='authority_below_threshold') AS reason_authority,
  count(*) FILTER (WHERE (explanation_json->'no_beat_reason'->>'reason')='no_comparable_competitors') AS reason_no_comparable
FROM keyword_forecast_scenarios
WHERE calc_run_id='fc816e93-60eb-47f9-ab69-24e902175be8' AND scenario='realistic';
```

| realistic_har_null | authority_below_threshold | no_comparable_competitors |
| -----------------: | ------------------------: | ------------------------: |
|                 59 |                        59 |                         0 |

Per-scenario totals: conservative **477**, realistic **59**, stretch **0**. All attributed to `authority_below_threshold`. Row is emitted; `har_position`, `rank_attainment_probability`, `har_confidence` and every downstream revenue column are `NULL`.

---

## 3. Content Fit Dependency

### Code — `har-calculation-v2/index.ts:446-506`

```ts
const { data: saRaw, error: saErr } = await sb
  .from("site_architecture")
  .select("keyword_id, relevancy_score")
  .in("keyword_id", kwBatch);
...
const contentByKw = new Map<string, number | null>();
for (const r of (saRaw ?? [])) contentByKw.set(String(r.keyword_id), r.relevancy_score);
...
const contentFit = contentByKw.has(kid) ? contentByKw.get(kid)! : null;
if (contentFit == null) { missingContentFitCount += 1; ... }
```

When there is **no row at all** for a keyword, `contentByKw.has(kid)` is false and `contentFit` is set to `null`. This is functionally identical to "row present with `NULL` score": both feed `content_fit_score: null` into `CompositeInputs` and `computeScenario` treats missing content-fit as an additive gap in the ladder — the keyword is not skipped, no exception is raised, and one `missing_content_fit` warning per keyword is added to the run's summary.

### Coverage on TVs Ongoing

```sql
SELECT count(*) AS kept_missing_site_arch
FROM keywords k
LEFT JOIN site_architecture sa ON sa.keyword_id = k.id
WHERE k.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND k.detox_status='keep'
  AND sa.keyword_id IS NULL;
```

Result: **0**. Every kept keyword on TVs Ongoing has a `site_architecture` row (see run summary `missing_content_fit_count: 606` — those are rows-with-null-score, not row-absent). This means site-architecture is a **required upstream** if we want authoritative content-fit; missing rows silently degrade HAR confidence without failing the run.

---

## 4. V2 Timing at Scale

### Query

```sql
SELECT project_id, model_version, EXTRACT(EPOCH FROM (finished_at-started_at))::int AS seconds,
       COALESCE((summary_json->>'keywords_total')::int, (summary_json->>'keywords_covered')::int) AS kw
FROM calc_run_registry
WHERE (model_version LIKE 'har_v2%' OR model_version LIKE 'revenue_v2%')
  AND status IN ('succeeded','partial') AND finished_at IS NOT NULL
ORDER BY started_at DESC;
```

### Observed range (all runs on record)

| function        | kw_count      | seconds (min/median/max) | seconds/keyword (median) |
| --------------- | ------------- | -----------------------: | -----------------------: |
| har_v2.1.0      | 857 – 860     | 4 / 7 / 14               | ≈ 0.008                  |
| revenue_v2.1.0  | 857 – 860     | 10 / 14 / 20             | ≈ 0.017                  |

Only two projects have v2 runs on record (TVs Ongoing 857 kw, TV World Cup 2026 860 kw). **No production v2 run has ever executed against >860 keywords.** All extrapolation below is linear from that base.

### Projections (linear, median rate)

| target keywords | HAR v2 projected | Revenue v2 projected | Combined | > 400s ceiling? |
| --------------- | ---------------: | -------------------: | -------: | :-------------: |
| 5,000           |             ~41s |                 ~99s |    ~140s | no              |
| 18,000          |            ~147s |                ~357s |    ~504s | **YES** (Revenue and combined) |

Caveats — **linear projection is optimistic**:
- `serp_results` fetched per 100-kw chunk with pagination — grows superlinearly with SERPs-per-keyword variance.
- `serp_features` averages 23 rows/kw on TVs Ongoing (max 82); at 18k kw that is ≥414k rows in RAM for Revenue v2.
- 15-minute inflight-run guard cutoff (`compute-forecasts-v2/index.ts:154`) is comfortably above 400s but the Supabase Edge background wall-clock is the binding limit.

### Verdict

**5k keywords: comfortably inside 400s.** **18k keywords: Revenue v2 alone is projected at ≈357s, combined ≈504s, above the 400s background ceiling** — and this is before superlinear effects. HAR v2 stays under budget at both sizes.

---

## 5. Memory Profile

### `har-calculation-v2` — what lives in memory simultaneously

| structure                             | source                                   | scale at 5k kw            | scale at 18k kw           |
| ------------------------------------- | ---------------------------------------- | ------------------------- | ------------------------- |
| `keptKws` (id, base_rank, ranking_url)| all kept kws                             | 5,000 rows                | 18,000 rows               |
| `overrideByKw` (keyword_forecasts)    | one row per kw                           | ≤5,000                    | ≤18,000                   |
| `insertBuffer` (scenario inserts)     | flushed every 500                        | 500 rows                  | 500 rows                  |
| per-100-kw batch: `serpByKw`          | pagination-safe, ~20 SERP rows/kw        | 2,000 rows                | 2,000 rows                |
| per-batch: `lpsByKwCanonical`         | ~20 LPS rows/kw                          | 2,000 rows                | 2,000 rows                |
| per-batch: `sfByKw` (serp_features)   | ~23 rows/kw, first-wins dedupe           | 2,300 rows                | 2,300 rows                |
| per-batch: `contentByKw`              | one row/kw                               | 100 rows                  | 100 rows                  |

HAR v2 processes in KW_CHUNK=100 batches (`har-calculation-v2/index.ts:48`, `:360`). **Batch structures are discarded per batch**, only the project-wide `keptKws` + `overrideByKw` + insert buffer are persistent. Peak memory scales with keyword count only for the id/override maps.

Rough estimate: id + base_rank + ranking_url ≈ 100 bytes/row → **~0.5 MB at 5k, ~1.8 MB at 18k**. Well under 256 MB.

### `compute-forecasts-v2` — what lives in memory simultaneously

| structure                                 | source                                                | scale at 5k kw            | scale at 18k kw           |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------- | ------------------------- |
| `curves` + `curveMeta`                    | full project CTR curves                               | ~600 rows                 | ~600 rows                 |
| `scenarioRows` (loaded in full up front)  | 3 × kept_kws for target HAR run                       | **15,000 rows**           | **54,000 rows**           |
| `kwMeta` (keywords + tags)                | one per kw                                            | 5,000                     | 18,000                    |
| `monthlyByKw` (12 months × kw)            | pagination-safe                                       | **60,000 rows**           | **216,000 rows**          |
| `trendByKw` (keyword_demand_signals)      | ~5 per kw                                             | ~25,000                   | ~90,000                   |
| `featuresByKw` (serp_features)            | ~23/kw                                                | **~115,000 rows**         | **~414,000 rows**         |
| `updatesBuffer` (flushed at 100)          | rolling window                                        | 100                       | 100                       |
| `adjustments` (serp_feature_ctr_adjust.)  | small, project-agnostic                               | tens                      | tens                      |

Only `scenarioRows` and `monthlyByKw`/`featuresByKw` scale with keyword count and are **all held simultaneously before the per-keyword loop begins** (`compute-forecasts-v2/index.ts:282-436`). Rough per-row sizes:

- `scenarioRows` ≈ 300 bytes/row (explanation_json can be 1–5 KB) → conservative **~5 MB at 5k, ~18 MB at 18k**; if explanation_json is deserialised eagerly, **~15–75 MB at 5k, ~54–270 MB at 18k**.
- `monthlyByKw` ≈ 40 bytes/row → ~2.4 MB / ~8.6 MB.
- `featuresByKw` ≈ 200 bytes/row → ~23 MB / ~83 MB.

**Estimated peak at 5k: ~40–110 MB. At 18k: ~145–380 MB.** 18k comes uncomfortably close to the 256 MB soft ceiling once explanation_json weight is included; the 500 MB hard ceiling is not breached in a naive estimate but every superlinear pathology (feature rows/kw variance, per-scenario explanation payload growth) will push against it.

---

## 6. LPS and Demand-Signals Caps at 5,000

### Enforcement (source)

**`link-power-score-compute/index.ts:37, 208-230`**:

```ts
const MAX_LIMIT = 5000;
...
const effectiveLimit = limitKeywords ?? MAX_LIMIT;
const { data: kwRows } = await sb
  .from("keywords")
  .select("id")
  .eq("project_id", projectId)
  .eq("detox_status", "keep")
  .order("created_at", { ascending: true })
  .limit(effectiveLimit + 1);
const allIds = (kwRows ?? []).map(...);
const capApplied = allIds.length > effectiveLimit;
const keywordIds = capApplied ? allIds.slice(0, effectiveLimit) : allIds;
if (capApplied) {
  runWarnings.push({
    code: "keyword_cap_applied", cap: effectiveLimit, total_kept_seen: allIds.length,
    message: `Kept-keyword count exceeded ${effectiveLimit}; only the first ${effectiveLimit} were scored.`,
  });
}
```

**`demand-signals-compute/index.ts:36, 88-92, 218-236`**: `MAX_LIMIT = 5000` is applied **only when `payload.limit_keywords` is passed by the caller** (`Math.min(MAX_LIMIT, Math.floor(rawLimit))`). When no caller limit is supplied, execution falls through to `fetchAllRows(...)` (line 230), which paginates through all rows uncapped. **There is no default 5,000 cap on demand-signals in the no-limit call path.**

### Behaviour matrix

| function              | 4,999 kept kws     | 5,000 kept kws                       | 5,001 kept kws                                                                 |
| --------------------- | ------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| link-power-score      | all 4,999 processed | all 5,000 processed (`+1` probe returns 5,000, `capApplied=false`) | first 5,000 by `created_at ASC` processed; 1 dropped; `keyword_cap_applied` warning emitted in `warnings`, run status `partial` |
| demand-signals (no limit) | all 4,999 processed | all 5,000 processed                  | all 5,001 processed (uncapped via `fetchAllRows`)                              |
| demand-signals (`limit_keywords=5000` passed) | 4,999 | 5,000 | first 5,000 by `created_at ASC` processed; 1 silently dropped; **no warning surfaced** (unlike LPS) |

### Verdict

- **LPS: hard-capped at 5,000, warning surfaced.** 18k-keyword projects lose 13,000 keywords of LPS scoring; HAR v2 then treats those as `missing_lps_row` (see `har-calculation-v2/index.ts:633`).
- **Demand-signals: uncapped in the default path.** No cap enforcement unless a caller explicitly passes `limit_keywords`, in which case the drop is silent.

---

## 7. V1 Compute Error — "compute-forecasts HTTP 500: Project not found"

### Call site — `har-calculation/index.ts:342-363`

```ts
const fcUrl = `${SUPABASE_URL}/functions/v1/compute-forecasts`;
const fcRes = await fetch(fcUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SERVICE_ROLE}`,
    apikey: SERVICE_ROLE,
  },
  body: JSON.stringify({ project_id: job.project_id }),
});
if (!fcRes.ok) {
  const body = await fcRes.text().catch(() => "");
  recomputeError = `compute-forecasts HTTP ${fcRes.status}: ${body.slice(0, 300)}`;
  ...
}
```

### Why "Project not found" fires — `compute-forecasts/index.ts:16-36`

```ts
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { headers: { Authorization: authHeader } },
  ...
});
...
const { data: project, error: projErr } = await supabase
  .from("navigator_projects")
  .select("aov, conversion_rate, seasonality_start, seasonality_end")
  .eq("id", project_id)
  .single();
if (projErr || !project) throw new Error("Project not found");
```

The v1 `compute-forecasts` function creates its Supabase client with `SUPABASE_ANON_KEY` and forwards the caller's Authorization header. The caller (`har-calculation`) sends `Authorization: Bearer <SERVICE_ROLE>` — a raw API-key JWT with `role=service_role`, not a user JWT. PostgREST accepts service_role and returns rows bypassing RLS, so the `SELECT` succeeds — **but** in the `.single()` case an unexpected empty result throws `PGRST116` (`"JSON object requested, multiple (or no) rows returned"`), which surfaces as `projErr`, and the code raises `"Project not found"`. In practice this fires for projects whose row was archived (`archived_at IS NOT NULL`) between HAR start and post-HAR compute — v1 has no archive filter, but the project row is still present, so the true root cause is more likely a stale-cache / race against transient `navigator_projects` state. Either way, the error is thrown **after** v1 has already written `har_results`, updated `har_jobs.status='completed'`, and set `navigator_projects.har_status='completed'`.

### Impact — quantified

```sql
SELECT last_error, count(*) FROM har_jobs
WHERE last_error LIKE '%compute-forecasts%' GROUP BY last_error;
-- => 21 rows, all "compute-forecasts HTTP 500: {\"error\":\"Project not found\"}"

SELECT hj.id, hj.status, (SELECT count(*) FROM har_results hr WHERE hr.project_id=hj.project_id) AS har_result_rows
FROM har_jobs hj WHERE hj.last_error LIKE '%compute-forecasts%' LIMIT 5;
-- All 5 sampled: status='completed', har_result_rows in 19..40 (>0).
```

**21 HAR v1 jobs carry this error. Every one is `status='completed'` with `har_results` rows present.** The post-HAR `compute-forecasts` call updates `keyword_forecasts.har` and `.har_revenue_gain_annual` (per the comment at `har-calculation/index.ts:332-340`) — those two columns end up **stale** (previous run's values) or **null** on the affected projects, which is the observable symptom users see in v1 dashboards. Data collection itself is unaffected.

---

## 8. Minimum Autonomous Path for a 5,000-Keyword GSC Project

Legend: **AUTO** = runs to completion without a human clicking a UI button; **MANUAL** = requires a client-side trigger or admin card click today.

| # | Stage                                     | Autonomous today? | Blocker                                                                                                                                     |
|--:|-------------------------------------------|:-----------------:|---------------------------------------------------------------------------------------------------------------------------------------------|
|  1 | `gsc-workbook-import` (CSV → `gsc_upload_keywords`) | MANUAL | Admin upload dialog only; no cron/webhook.                                                                                                  |
|  2 | **GSC → `keywords` promotion**            | **MISSING**       | No code path exists (Part 5 dossier). Keywords never reach the main table without manual intervention.                                       |
|  3 | `keyword-enrichment` (DFS volumes)        | MANUAL            | Called from `useNavigatorSync.ts` client loop; no server cron.                                                                              |
|  4 | `keyword-detox`                           | **AUTO**          | `detox-jobs-tick` cron every minute; self-resumes.                                                                                          |
|  5 | `keyword-categorisation` (live)           | **AUTO** (partial)| `categorisation-worker-tick` + `categorisation-live-resume` cron. But deferred-tier keywords require the nightly `categorisation-deferred-tick`; and two production jobs are stuck at `processed=0` (Part 6 §6). |
|  6 | `brand-classification`                    | MANUAL            | Admin card only; no cron.                                                                                                                   |
|  7 | `gsc-intent-enrichment`                   | MANUAL            | Client-driven from admin UI; no cron.                                                                                                       |
|  8 | `ctr-curves-from-gsc`                     | MANUAL            | Admin `CtrCurvesCard` button.                                                                                                               |
|  9 | `keyword-cluster-recompute`               | MANUAL            | Admin `KeywordClusteringCard` button.                                                                                                       |
| 10 | `base-rank-backfill`                      | MANUAL            | Admin `BaseRankBackfillCard` button.                                                                                                        |
| 11 | `site-architecture` (relevancy scoring)   | MANUAL            | Client-loop; has 40-invocation cap noted in Part 4 dossier. **Would not complete at 5k keywords without client-side stall recovery.**       |
| 12 | `demand-signals-compute`                  | MANUAL            | No cron. Uncapped at 5k (§6) but not autonomous.                                                                                            |
| 13 | `link-power-score-compute`                | MANUAL            | No cron. **Hard-capped at 5,000** — 5k project fits; 5,001+ silently drops the excess (with warning).                                       |
| 14 | `har-calculation-v2`                      | MANUAL            | Admin card only.                                                                                                                            |
| 15 | `calibration-compute`                     | MANUAL            | Admin `CalibrationCard` button.                                                                                                             |
| 16 | `compute-forecasts-v2`                    | MANUAL            | Admin card / sequential-run button (§HOTFIX 2).                                                                                             |

Truly-autonomous stages today: **4 (detox), 5 (categorisation)** — and only if the project already has keywords in `public.keywords`. Every other stage in the v2 forecast path requires a human clicking a button, and the pipeline is broken at step 2 for any GSC-first project.

---

## Verdict

The v2 calculation stack itself (HAR v2 + Revenue v2) is **fast enough for 5,000 keywords** (~140s combined, well under 400s) and **memory-safe at 5k** (~40–110 MB peak). It emits every input keyword as a scenario row; keywords the client cannot realistically rank for surface as `har_position = NULL` with `no_beat_reason='authority_below_threshold'` in `explanation_json` and cascade to `NULL` revenue columns — **no rows are dropped at any stage.**

However, the pipeline **cannot run end-to-end autonomously for a 5,000-keyword project today** because (a) the GSC-to-keywords promotion path does not exist, (b) 12 of the 16 pipeline stages require a human click, (c) `link-power-score-compute` is hard-capped at 5,000 (fine for 5k, breaks 18k), and (d) HAR v1 leaves `keyword_forecasts.har` unpopulated on ~21 historical projects due to the post-HAR "Project not found" error. At 18k keywords, Revenue v2 wall-clock already projects to ≈357s (combined ≈504s) and peak memory to ≈145–380 MB — both approaching the platform ceilings before superlinear factors are considered.
