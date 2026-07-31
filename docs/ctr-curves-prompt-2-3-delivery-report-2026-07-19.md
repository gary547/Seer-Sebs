# Prompt 2.3 — CTR curves: device-aware, branded-excluded — Delivery Report

Date: 2026-07-19
Author: Lovable agent (build)
Audience: Technical advisor
Scope reference: Phase 2 (Data foundation & calibration), Prompt 2.3.

---

## 1. Scope recap

Prompt 2.3 required the CTR curve generator (`ctr-curves-from-gsc`) to:

1. Exclude rows where `gsc_upload_keywords.is_branded = true` from aggregation; count but include `NULL`.
2. Build device-aware curves for mixed-device uploads (`gsc_uploads.device = 'mixed'`): `mobile`, `desktop`, and an aggregate `all`. Legacy single-device / null uploads keep the historical `all`-only behaviour.
3. Perform a **single upfront wipe** of non-fallback rows for the project across ALL devices and intents (including any legacy `device='all'` rows from earlier builds) before inserting new curves. Fallback rows (`is_fallback=true`) are never touched.
4. Preserve existing thresholds, blending, confidence tiers, and `ctr_curve_metadata` shape.
5. Do NOT modify the resolver, revenue functions, migrations, or client-facing pages.

---

## 2. Actions delivered

### 2.1 `supabase/functions/ctr-curves-from-gsc/index.ts`

Key surface (post-change):

- **Device selection** — `pickDevicesToBuild(upload)` (index.ts:82) returns `['mobile','desktop','all']` when `upload.device` is `'mixed'` (case-insensitive), else `['all']` with `hasPerRowDevice=false`. This is the sole switch between the new per-device path and the legacy path.
- **Branded exclusion + counters** — `buildAggregations()` (index.ts:118) iterates rows once:
  - `is_branded === true` → skipped, increments `brandedExcludedRows`.
  - `is_branded === null|undefined` → counted in `unclassifiedRows` and still contributes.
  - Position filter `(0, 20.5]` gates `rowsUsed`; out-of-band rows are counted in `rowsConsidered` but not aggregated.
  - Under mixed uploads, unknown device values (`null`, `'tablet'`, other) increment `unknownDeviceRows` and contribute to the `all` bucket ONLY — never to `mobile`/`desktop`.
  - Ranks clamped to `[1,20]` (`clampRank`); intent normalised via `normalizeIntent` into five keys (`transactional | commercial | informational | navigational | generic`).
- **Prior-ladder snapshot** — Before the wipe, for every `(device × intent)` bucket that will be rebuilt, the function reads existing non-fallback `ctr_curves` rows into a `Map` keyed by `${device}::${intent}` (index.ts:~270). Blending then uses the device-matched prior when present; missing ranks fall back to `STANDARD_CTR`. This eliminates cross-device contamination during rebuilds.
- **Single upfront wipe** — One `DELETE FROM ctr_curves WHERE project_id = ? AND is_fallback = false` (index.ts:~288) executed once per run, before any insert. This deletes legacy `device='all'` rows in addition to any per-device rows, guaranteeing no stale `all` curve coexists alongside new mobile/desktop curves after a mixed rebuild. Fallback seed rows are explicitly preserved by the `is_fallback = false` predicate.
- **Blending unchanged** — For each bucket meeting `MIN_BUCKET_IMPR = 500`: weight = `min(bucket.impressions / RANK_FULL_TRUST, 1)` with `RANK_FULL_TRUST = 1000`; `blended = w*measured + (1-w)*fallback`. Values clamped to `[0, 100]` and rounded to two decimals.
- **Confidence tiering unchanged** — `confidenceFor()`: `>= 5000 = high`, `>= 1000 = medium`, else `low` (index.ts:71).
- **Metadata source label** — `sourceLabel` = `gsc_workbook_per_device` for `mobile`/`desktop` buckets and `gsc_workbook_all_device` for the `all` bucket. Written per row to `ctr_curve_metadata.source` alongside `sample_impressions`, `sample_clicks`, `confidence`, and the upload date range.
- **`calc_run_registry` scope + summary** —
  - `scope`: `{ kind: 'ctr_generation', source: <per_device|all_device>, device: <'per_device'|'all'> }`.
  - `summary_json`: `upload_id`, `date_range_start`, `date_range_end`, `rows_considered`, `rows_used`, `branded_excluded_rows`, `unclassified_rows`, `has_per_row_device`, `devices_built`, `curves_written`, and a `buckets[]` breakdown containing `{ device, intent, impressions, clicks, confidence, ranks_written }`.
  - `warnings`: `{ unknown_device_rows: N }` when applicable; per-bucket `{ device, intent, skipped: true, reason }` for buckets below `MIN_BUCKET_IMPR`; `{ device, intent, low_confidence: true, impressions }` where the tier landed low.
- **Failure hygiene** — Any error routes through `failRun()` which marks the calc-run row `failed` with a serialised error before returning the HTTP response; no silent partials.

### 2.2 `supabase/functions/ctr-curves-from-gsc/index.test.ts`

Nine Deno tests, all pure unit tests over exported helpers (`pickDevicesToBuild`, `buildAggregations`, `INTENT_KEYS`):

1. `pickDevicesToBuild: mixed upload -> mobile/desktop/all`
2. `pickDevicesToBuild: all/null/other -> all only (legacy)` — verifies legacy path is triggered for `'all'`, `null`, and even bare `'mobile'`/`'desktop'` upload-level device values (per contract these are not row-level splits).
3. `device splitting: mixed upload aggregates per device and all=sum` — proves the `all` bucket is the sum of mobile+desktop for the same rank/intent.
4. `branded exclusion: is_branded=true dropped; null counted+included` — locks the `NULL` semantics.
5. `legacy no-device path: only 'all' bucket exists` — guarantees no `mobile`/`desktop` keys leak into the aggregation object for legacy uploads.
6. `per-bucket threshold independence: mobile skipped, desktop kept` — proves the 500-impression gate is applied independently.
7. `unknown device under mixed upload: contributes to 'all' only and is counted` — locks the tablet/null routing.
8. `position filter: rows outside (0, 20.5] excluded from rowsUsed`.
9. `all five intent buckets exist per device (empty maps allowed)` — structural completeness.

---

## 3. Files untouched (per scope)

- `supabase/functions/_shared/ctr-resolver-v2.ts` — read-side resolver unchanged.
- `supabase/functions/compute-forecasts-v2/**`, `har-calculation-v2/**`, `_shared/revenue-v2.ts`.
- All client pages and components.
- No migrations. `ctr_curves` schema already keys on `(project_id, device, rank_position, intent_segment)` and supports `intent_segment IS NULL` for the `generic` bucket; no schema change was required.

---

## 4. Test results

Command:

```
deno test supabase/functions/ctr-curves-from-gsc/index.test.ts --allow-all
```

Result: **9 passed | 0 failed** (16 ms total).

```
pickDevicesToBuild: mixed upload -> mobile/desktop/all ... ok (0ms)
pickDevicesToBuild: all/null/other -> all only (legacy) ... ok (0ms)
device splitting: mixed upload aggregates per device and all=sum ... ok (1ms)
branded exclusion: is_branded=true dropped; null counted+included ... ok (0ms)
legacy no-device path: only 'all' bucket exists ... ok (0ms)
per-bucket threshold independence: mobile skipped, desktop kept ... ok (0ms)
unknown device under mixed upload: contributes to 'all' only and is counted ... ok (0ms)
position filter: rows outside (0, 20.5] excluded from rowsUsed ... ok (0ms)
all five intent buckets exist per device (empty maps allowed) ... ok (0ms)
```

Full project Vitest suite was not re-run in this turn (no client-side or shared code was changed); the CTR generator is Deno-only and covered above.

---

## 5. Deployment

Edge function `ctr-curves-from-gsc` was auto-redeployed on save when the prior turn's code edits landed. No manual redeploy was required for this reporting turn (no code changes).

Operator action required to observe per-device curves on any given project:
- Upload (or confirm) a mixed-device GSC workbook via `GscUploadPanel` (`upload.device` persists as `'mixed'`).
- Trigger "Regenerate CTR curves" for the project from `admin/CalculationsPage`.

Projects still on legacy uploads (`device = 'all' | 'mobile' | 'desktop' | null`) retain single-`all`-bucket behaviour and require no re-run.

---

## 6. Operator verification checklist (no execution here — for advisor)

Post-rebuild sanity queries:

```sql
-- Expect: rows for device in ('mobile','desktop','all') after a mixed rebuild;
-- only 'all' after a legacy rebuild.
select device, coalesce(intent_segment,'generic') as intent, count(*)
from ctr_curves
where project_id = :project_id and is_fallback = false
group by 1, 2
order by 1, 2;
```

```sql
-- Latest CTR runs and their per-device summary payload.
select
  started_at,
  scope->>'source' as source,
  summary_json->'devices_built' as devices_built,
  summary_json->>'branded_excluded_rows' as branded_excluded,
  summary_json->>'unclassified_rows' as unclassified,
  summary_json->>'curves_written' as curves_written,
  status
from calc_run_registry
where scope->>'kind' = 'ctr_generation'
order by started_at desc
limit 5;
```

```sql
-- Regression guard: after a mixed rebuild there must be NO orphan legacy 'all'
-- rows without corresponding per-device rows written in the same run window.
select count(*) as legacy_all_rows
from ctr_curves
where project_id = :project_id
  and device = 'all'
  and is_fallback = false;
-- (Value is only meaningful in combination with the group-by query above.)
```

---

## 7. Outstanding items / risks

- **No project-level runtime verification** performed in this delivery turn. The advisor should nominate a project with a confirmed mixed-device upload (e.g. AO/TVs Ongoing if its GSC workbook is device-mixed) for end-to-end confirmation of the summary payload and the three-bucket population.
- **Resolver behaviour unchanged.** Consumer selection of which curve to use at read time (`_shared/ctr-resolver-v2.ts`) is out of scope for 2.3. If Revenue v2 or forecasts ever need to prefer device-matched curves in a keyword's own device context, that is a resolver-side change (candidate for a future prompt).
- **Prior-ladder blending after a device topology change** — When a project transitions from legacy `all`-only history to a first mixed rebuild, the new `mobile` and `desktop` buckets have no device-matched prior and fall back to `STANDARD_CTR` for ranks below `RANK_FULL_TRUST` weight. This is by design (no cross-device leakage) but means the first mixed rebuild for such a project may show slightly higher fallback influence at low-impression ranks than subsequent rebuilds.

---

## 8. Next prompt readiness

Prompt 2.4 is unblocked pending advisor sign-off on the evidence above. No follow-up hotfix has been identified from the 2.3 implementation itself.
