# CTR Curves v2 — Part 4 runtime verification (TVs Ongoing)

Date: 2026-07-19
Project: TVs Ongoing (`project_id = 5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Function: `ctr-curves-from-gsc` (`model_version = ctr_v2.0.0`)
Trigger: `admin_manual` via "Generate CTR curves (v2)" on `/admin/calculations`

**Headline:** the run failed at 15:26:48 UTC on a unique-constraint violation while inserting the first desktop curve. Mobile curves wrote cleanly (5 buckets × 20 ranks); desktop and the `all` aggregate never materialised. Root cause is a schema/behaviour mismatch: the wipe deliberately preserves `is_fallback = true` rows, but the unique indexes on `ctr_curves` do not include `is_fallback`, so any pre-existing fallback row for `(project, device, intent, rank)` blocks the new measured insert for the same slot.

---

## 1. Run header

```sql
SELECT id, project_id, model_version, status, trigger_source,
       started_at, finished_at, summary_json, warnings, errors
FROM calc_run_registry
WHERE model_version LIKE 'ctr%' AND project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY started_at DESC NULLS LAST LIMIT 1;
```

Result (single row):

| field | value |
| --- | --- |
| id | `2ab7b5a4-ce2f-4ae0-ba40-9cc730bc7307` |
| model_version | `ctr_v2.0.0` |
| status | `failed` |
| trigger_source | `admin_manual` |
| started_at | `2026-07-19 15:26:29.210434+00` |
| finished_at | `2026-07-19 15:26:48.274+00` |
| summary_json | `{}` (empty — the success path was never reached) |
| warnings | `[]` |
| errors | `[{ "code": "db_error", "message": "Insert curves failed: duplicate key value violates unique constraint \"ctr_curves_project_device_rank_intent\"" }]` |

The run lasted ~19 s. The error surfaced from the desktop transactional insert (see §3).

---

## 2. Upload used

The latest eligible upload (`source IN ('gsc_csv_v2','gsc_workbook_v1')`, both date ranges set) is a mixed-device `gsc_csv_v2` workbook. Per-row device coverage from `gsc_upload_keywords`:

```sql
SELECT k.device, COUNT(*) AS rows,
       SUM(k.impressions) AS impressions,
       SUM(k.clicks) AS clicks,
       SUM(CASE WHEN k.is_branded THEN 1 ELSE 0 END) AS branded_rows
FROM gsc_upload_keywords k
JOIN gsc_uploads u ON u.id = k.upload_id
WHERE u.project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND u.source IN ('gsc_csv_v2','gsc_workbook_v1')
GROUP BY 1
ORDER BY 1;
```

| device | rows | impressions | clicks | branded_rows |
| --- | ---:| ---:| ---:| ---:|
| desktop | 9,391 | 41,635,196 | 1,452,823 | 1,824 |
| mobile | 15,609 | 136,411,880 | 2,992,684 | 2,572 |

Both devices are populated and both carry classified rows, so the two Part 2 data-quality guards (`mixed_upload_missing_row_devices`, `upload_unclassified`) correctly did **not** trip. Execution proceeded past the guards into the wipe → insert phase.

---

## 3. What was written before the failure

`ctr_curves` snapshot for the project immediately after the failed run:

```sql
SELECT device, intent_segment, is_fallback, COUNT(*)
FROM ctr_curves
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
GROUP BY 1,2,3
ORDER BY is_fallback, device, intent_segment;
```

| device | intent_segment | is_fallback | count |
| --- | --- | --- | ---:|
| mobile | commercial | false | 20 |
| mobile | informational | false | 20 |
| mobile | navigational | false | 20 |
| mobile | transactional | false | 20 |
| mobile | NULL (generic) | false | 20 |
| desktop | transactional | true | 20 |

Metadata for those curves (all reference the failed calc-run):

```sql
SELECT calc_run_id, source, confidence,
       sample_impressions, COUNT(*)
FROM ctr_curve_metadata
WHERE ctr_curve_id IN (
  SELECT id FROM ctr_curves
  WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
)
GROUP BY 1,2,3,4
ORDER BY sample_impressions;
```

| calc_run_id | source | confidence | sample_impressions | count |
| --- | --- | --- | ---:| ---:|
| `2ab7b5a4…` | `gsc_workbook_per_device` | high | 1,277,319 | 20 |
| `2ab7b5a4…` | `gsc_workbook_per_device` | high | 2,777,717 | 20 |
| `2ab7b5a4…` | `gsc_workbook_per_device` | high | 16,326,350 | 20 |
| `2ab7b5a4…` | `gsc_workbook_per_device` | high | 44,200,748 | 20 |
| `2ab7b5a4…` | `gsc_workbook_per_device` | high | 55,414,869 | 20 |

Five metadata batches × 20 rank rows = 100, exactly matching the five mobile buckets. Every batch is tagged `source = gsc_workbook_per_device` and `confidence = high`. No desktop or `all` metadata was written, corroborating that the failure occurred on the first attempted desktop insert (device loop order is `mobile → desktop → all`, intent loop starts at `transactional`).

The desktop `transactional` `is_fallback = true` rows pre-date this run — the wipe leaves fallback rows in place by design.

---

## 4. Root cause

### Wipe (preserves fallbacks)

From `supabase/functions/ctr-curves-from-gsc/index.ts` (post-guard, pre-insert):

```ts
const { error: delErr } = await sb
  .from("ctr_curves")
  .delete()
  .eq("project_id", projectId)
  .eq("is_fallback", false);
```

This is intentional — fallback ladders act as a safety net for slots that never receive measured data.

### Unique indexes on `ctr_curves` (do NOT include `is_fallback`)

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'ctr_curves';
```

Two overlapping unique indexes, both keyed by `(project_id, device, intent, rank)` only:

- `ctr_curves_project_device_rank_intent` — `UNIQUE (project_id, device, rank_position, COALESCE(intent_segment, ''))`
- `ctr_curves_project_device_intent_rank_uq` — `UNIQUE (project_id, device, intent_segment, rank_position)`

### The collision

When the desktop loop reached `intent = transactional`, the function attempted to insert 20 new rows for `(project = TVs Ongoing, device = desktop, intent = transactional, rank = 1..20, is_fallback = false)`. The pre-existing fallback rows for the same `(project, device, intent, rank)` — untouched by the wipe — occupy those unique slots. Postgres raised:

```
duplicate key value violates unique constraint "ctr_curves_project_device_rank_intent"
```

The catch block routed this through `failRun("db_error", …, 500)`, marking the run failed and returning HTTP 500. Because the loop aborts on first error, the remaining desktop intents and the entire `all` device pass were skipped.

### Why mobile succeeded

No fallback rows exist for `device = mobile` at any intent for this project (see §3), so mobile inserts had no unique-slot competitor and completed cleanly for all five intents.

---

## 5. State impact

- Mobile curves are present and correct (all buckets `confidence = high` on ≥1.27M impressions).
- Desktop curves are absent (aside from the legacy transactional fallback set).
- The `all` aggregate is absent entirely.
- Downstream consumers that read `device = 'all'` will fall back to `STANDARD_CTR` defaults; consumers that read `device = 'desktop'` intent-specific curves will hit the transactional fallback ladder and default constants for the other intents.
- Operator visibility is intact: `calc_run_registry` shows `status = failed` with a specific error code, and `CtrCurvesCard` will render only mobile lines for this project.

There is no silent-success failure mode.

---

## 6. Recommended remedies (advisor decision — no changes made in this turn)

1. **Option A — targeted fallback delete before measured insert (preferred, additive, no migration):**
   Before each per-`(device, intent)` measured insert, delete matching fallback rows for the same slots (`WHERE project_id = … AND device = … AND intent_segment IS NOT DISTINCT FROM … AND rank_position BETWEEN 1 AND 20`). Leaves fallbacks intact for `(device, intent)` slots that will not receive a measured curve this run.

2. **Option B — widen the upfront wipe:**
   Extend the wipe to include fallbacks for the specific `(device, intent)` combinations the run intends to write. Simpler than A but requires computing the write-set before the wipe (`devicesToBuild × INTENT_KEYS`).

3. **Option C — schema change (migration required):**
   Add `is_fallback` to both unique indexes so fallback and measured rows can coexist. Smallest behavioural change but changes the invariant "one curve per `(project, device, intent, rank)`" that some consumers may implicitly rely on.

4. **Independent hardening — atomicity on failure:**
   Wrap the per-device / per-intent inserts in a savepoint or capture the pre-wipe snapshot and restore it on any mid-run error, so a partial failure never strands the project in a half-written state (as it currently is on TVs Ongoing — mobile-only).

---

## 7. Evidence appendix (queries verbatim)

All queries were run against the connected Supabase project via read-only SQL. Results are reproduced inline in §1–§4 above; the queries are:

- Run header — §1 SQL block.
- Upload device / row / impression / brand counts — §2 SQL block.
- `ctr_curves` post-run snapshot — §3 first SQL block.
- `ctr_curve_metadata` per-batch summary — §3 second SQL block.
- Unique-index inspection — §4 `pg_indexes` query.

No writes were performed to produce this report.
