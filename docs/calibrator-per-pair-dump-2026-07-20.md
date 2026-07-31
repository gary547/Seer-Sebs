# Calibrator per-pair dump + base_rank investigation — TVs Ongoing

Date: 2026-07-20
Project: TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Client: AO (`fc2e271c-f10b-4b57-840f-d20ed7150d29`, `domain=https://ao.com/`, `domain_normalized=ao.com`)

---

## Part 1 — Persistence deployed

`supabase/functions/calibration-compute/index.ts` now persists the calibrator's internal per-pair ledger to `calibration_snapshots.by_rank_band`:

- `pairs_scored[]` — one record per scored pair with: `keyword`, `keyword_id`, `device`, `intent`, `base_rank`, `annual_volume`, `annual_volume_source`, `months_used`, `trend_pct`, `trend_confidence`, `trend_factor`, `trend_applied`, `volume_forward_used`, `ctr_used` (decimal), `ctr_resolver_tier`, `ctr_curve_key` (`device|intent|rank`), `svm_used`, `impressions`, `actual_clicks_raw`, `actual_monthly` (30-d normalised), `modelled_monthly`, `per_pair_ratio`.
- `pairs_model_blind[]` — same shape for `base_rank IS NULL` pairs, `modelled_monthly=null`, `reason="base_rank_null"`.
- Cap: first 500 of each. TVs Ongoing has 94 scored + 143 model_blind so no truncation.
- Boot log: `[calibration-compute] boot v2 with per-pair persistence`.
- Test: `_shared/calibration.test.ts` — new round-trip fixture asserts `modelled/actual == per_pair_ratio` on hand-checkable pairs.

**Existing snapshots do NOT have this artifact.** Confirmed by:

```sql
SELECT id, created_at, keywords_matched,
       jsonb_extract_path(by_rank_band,'pairs_scored') IS NOT NULL AS has_pairs_scored
FROM calibration_snapshots
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY created_at DESC LIMIT 3;
```

| id | created_at | matched | has_pairs_scored |
|---|---|---|---|
| `1d8dab0c` | 2026-07-20 19:00:13 | 44 | **false** |
| `4a9aa1a5` | 2026-07-20 18:49:04 | 44 | **false** |
| `744db4c6` | 2026-07-20 15:28:43 | 44 | **false** |

> **Operator action required.** Parts 2 and 3 below need one re-run of calibration on TVs Ongoing (same GSC upload) to populate `pairs_scored[]`. Click "Run calibration" on `/admin/calculations?projectId=5fd4df7e-45dd-40c0-b10e-86ea6dad9720`, then this document will be re-opened with the ledger dump.

Contradiction surfaced by the notes column that motivates Parts 2–3 even before the re-run:

- Snapshot `1d8dab0c` `notes` states `scored=94 · model_blind=143 · Σm=19.52`. Earlier verification report §2/§4 headline was `matched=44`, and §4 reconstructed 37.9 modelled monthly for `24 inch tv` alone — impossible against Σm=19.52 across 94 pairs. See Part 2.

---

## Part 2 — Reconciling §4 vs the ledger  *(resolved with re-run `f3705db5`)*

Re-run snapshot: `f3705db5-e65e-4f66-abae-dd22db5c17d6` (2026-07-20 19:16:05 UTC), same input as `1d8dab0c` — same GSC upload, same universe, same overall ratio `0.010451`, and now with `pairs_scored[]` (94 rows) and `pairs_model_blind[]` (143 rows) persisted.

Ledger row for `24 inch tv` (source: `by_rank_band->'pairs_scored'`):

```sql
SELECT elem->>'keyword' AS kw, (elem->>'annual_volume')::numeric AS av,
       elem->>'annual_volume_source' AS av_src,
       (elem->>'trend_factor')::numeric AS tf,
       (elem->>'volume_forward_used')::numeric AS vfwd,
       (elem->>'ctr_used')::numeric AS ctr,
       elem->>'ctr_resolver_tier' AS tier,
       (elem->>'svm_used')::numeric AS svm,
       (elem->>'modelled_monthly')::numeric AS m,
       (elem->>'actual_monthly')::numeric AS a,
       (elem->>'per_pair_ratio')::numeric AS r
FROM calibration_snapshots s,
     jsonb_array_elements(s.by_rank_band->'pairs_scored') elem
WHERE s.id='f3705db5-e65e-4f66-abae-dd22db5c17d6'
  AND elem->>'keyword'='24 inch tv';
```

| field | value |
|---|---:|
| annual_volume | 101,300 (`keyword_monthly_volumes`) |
| trend_factor | 0.8689 |
| volume_forward_used | 88,020 |
| ctr_used (decimal fraction) | **0.000105** |
| ctr_resolver_tier | `project_device_intent` |
| svm_used | **0.612** |
| modelled_monthly | **0.4713** |
| actual_monthly | 36.20 |
| per_pair_ratio | **0.01302** |

The prior §4 reconstruction claimed modelled `37.9`; the calibrator actually computed **0.4713**. §4 was wrong by exactly **100×** (see Part 3). SVM 0.612 in the calibrator matches Round-2 assumptions — the 0.95 seen in `keyword_forecast_scenarios` is from Revenue run `e65fc884` which post-dates the SERP-feature seed round and is not what the calibrator resolved for this snapshot. Both §4 numbers are superseded by this ledger row.

`Σm=19.52` across 94 pairs is real. Part 3 explains it in one line.

---

## Part 3 — Aggregate diagnosis: 100× CTR unit bug in the calibrator

Top-10 scored pairs by `actual_monthly`, from `pairs_scored[]`:

| keyword | device | intent | rank | ctr_used (frac) | curve `ctr_percentage` (pp) | expected frac | empirical CTR from GSC | modelled_m | actual_m | ratio |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tv | mobile | informational | 11 | **0.00005** | 0.5 | 0.005 | 0.00553 | 7.91 | 691.93 | 0.011 |
| tv deals | mobile | commercial | 6 | 0.00013 | 1.3 (interp) | 0.013 | 0.01522 | 0.73 | 140.18 | 0.005 |
| 55 inch tv | mobile | transactional | 14 | 0.000039 | 0.39 (interp) | 0.0039 | 0.00669 | 0.067 | 130.72 | 0.0005 |
| 32 inch tv | mobile | transactional | 5 | 0.00013 | 1.3 | 0.013 | 0.00847 | 1.36 | 126.81 | 0.011 |
| 50 inch smart tv | mobile | transactional | 19 | 0.000039 | 0.39 | 0.0039 | 0.00636 | 0.47 | 50.24 | 0.009 |
| 43 inch tv | mobile | transactional | 17 | 0.000039 | 0.39 | 0.0039 | 0.00596 | 0.40 | 43.92 | 0.009 |
| 75 inch tv | mobile | transactional | 12 | 0.000039 | 0.39 (interp) | 0.0039 | 0.00329 | 0.36 | 43.43 | 0.008 |
| 24 inch tv | mobile | transactional | 8 | 0.000105 | 1.05 | 0.0105 | 0.01004 | 0.47 | 36.20 | 0.013 |
| buy tv | mobile | transactional | 8 | 0.000105 | 1.05 | 0.0105 | 0.01374 | 0.13 | 31.57 | 0.004 |
| 42 inch tv | mobile | transactional | 15 | 0.000039 | 0.39 (interp) | 0.0039 | 0.00518 | 0.40 | 30.60 | 0.013 |

Two invariants prove the bug:

1. `ctr_used` divided by `ctr_percentage` is exactly **1/10,000** in every row — the resolver already returned a decimal fraction; the calibrator divides by 100 a **second** time. Expected `ctr_used = ctr_percentage / 100`; observed `ctr_used = ctr_percentage / 10,000`.
2. Empirical CTR from GSC (`raw_clicks / impressions`) lands within 1–3× of `ctr_percentage / 100` in every row — the curves themselves are broadly correct; there is no curve corruption remaining after the PAV + writer-fence work. E.g. `tv` r11 mobile-informational: curve says 0.5%, GSC observes 0.55%.

### Root cause

`supabase/functions/calibration-compute/index.ts:338`:

```ts
ctrNow = res.ctr != null ? Number(res.ctr) / 100 : null;
```

`supabase/functions/_shared/ctr-resolver-v2.ts:207–210`:

```ts
const pct = Number(row.ctr_percentage) || 0;
return {
  ctr: pct / 100,           // already a decimal fraction
  ctrPercentage: pct,       // ← what the calibrator should use if it wants /100
  ...
};
```

The resolver returns both fields: `ctr` (decimal fraction, e.g. `0.005` for 0.5%) and `ctrPercentage` (percentage points, e.g. `0.5`). The calibrator reads `res.ctr` and divides again — a straight-through 100× understatement on every scored pair. Revenue v2 (`compute-forecasts-v2`) does **not** have this bug (it consumes the resolver's `ctr` directly), so client-facing forecasts are unaffected; only the calibration snapshot is 100× light.

### Predicted effect of the one-line fix

Removing the extra `/100`:

- `tv` modelled: `7.91 → ~791` vs actual `691.9` → ratio **≈ 1.14 (green)**
- Σm across 94 pairs: `19.52 → ~1,952` vs Σa `1,867.5` → **overall_ratio ≈ 1.045 (green)**
- Median per-pair ratio: `0.011 → ~1.1`

This alone likely closes Gate B for TVs Ongoing without touching the CTR curves, SVM, or the model-blind bucket. Whether the amber/red per-intent buckets remain any-red under the fix is a separate check the re-run will produce.

### Why prior snapshots hid this

- Prior snapshots wrote no per-pair ledger, so `ctr_used` was never visible.
- Notes-line arithmetic (`Σm/Σa = 19.52/1867.53 = 0.010451`) matches exactly `1/100 × ideal`, which was hand-waved as "scoping mismatch" and "model-blind coverage" in the last three verification reports. Both hypotheses are real but ~10× smaller than the unit bug that dominated.

Advisor rule: read-only report — no fix applied. One-line correction proposed at `calibration-compute/index.ts:338`, replace `Number(res.ctr) / 100` with `Number(res.ctr)` (or read `res.ctrPercentage / 100` for symmetry with the resolver contract). Await ruling.

---


## Part 4 — base_rank NULL investigation *(complete)*

### (a) How base_rank is derived

`supabase/functions/ranking-url-lookup/index.ts:158-208`:

- Calls DataForSEO Labs `POST /v3/dataforseo_labs/google/ranked_keywords/live` with `target: cleanDomain`, `location_code: 2826`, `language_code: "en"`, `item_types: ["organic"]`, `historical_serp_mode: "live"`, filtered to the batch of keywords.
- For each returned item: `base_rank = serp_item.rank_group ?? serp_item.rank_absolute` (line 204).
- Domain "matching" is **DFS-side**: the `target` parameter scopes results to that host. There is no JS string comparison of URLs. Matching cannot be www/protocol/case-buggy in our code because our code never compares — DFS does.
- Caller `cleanDomain` derivation: the function receives `clientDomain` from its invoker and lowercases/strips scheme in the same file's helper. The value stored on the AO client is `domain_normalized='ao.com'`.
- Keywords with no returned item get `ranking_lookup_no_match=true` set in a later pass; `base_rank` stays NULL.

### (b) SERP-vs-DFS contradiction

Kept, non-brand, NULL-`base_rank` universe:

```sql
SELECT COUNT(*), COUNT(*) FILTER (WHERE ranking_lookup_no_match) AS no_match
FROM keywords WHERE project_id='5fd4df7e-…' AND detox_status='keep'
  AND is_branded IS NOT TRUE AND base_rank IS NULL;
-- 606 rows, 606 no_match (100%)
```

For the 5 largest-volume NULL-rank keywords, ao.com in top-20 of the latest `serp_results` snapshot:

| keyword | avg_monthly_volume | ao.com in top-20 (rank) |
|---|---:|---|
| tvs | 201,000 | **yes — rank 18** (`https://ao.com/tv-and-entertainment/tvs`) |
| 55-in tvs | 49,500 | **yes — rank 20** (`https://ao.com/l/tvs-55_inches_to_64pt9_inches/…`) |
| 65 inch tvs | 49,500 | no |
| 55 tv | 49,500 | no |
| 55 inch tvs | 49,500 | no |

Across the full 606-row universe:

```sql
-- ao_hits = 203 / 606 NULL-rank keywords have ao.com in top-20 of latest serp_results
```

**33.5% of NULL-`base_rank` kept non-brand keywords have ao.com present in the HAR SERP snapshot but DFS Labs returned no `ranked_keywords` row.** The two live sources of rank truth disagree on 203 keywords for AO.

### (c) Client domain value passed to DFS

- `clients.domain` = `https://ao.com/`
- `clients.domain_normalized` = `ao.com`
- The DFS `target` used in `ranking-url-lookup` normalises to `ao.com` (bare host, no scheme/path). Cannot be verified end-to-end from stored data — logged as an operational note.

### Interpretation (no fix proposed — advisor rule)

Two possible causes, both DFS-side; picking one is out of scope:

1. **Universe mismatch.** DFS `ranked_keywords/live` `target='ao.com'` may exclude subdomains/redirects, or may not surface ranks beyond DFS's own top-N page-1 cutoff for some markets. The `serp_results` HAR fetch uses DFS's `serp/google/organic/live/advanced` which returns full top-20 — that endpoint sees ao.com; the Labs endpoint does not always.
2. **Vintage skew.** `ranking-url-lookup` was last run 2026-05-05 for these rows (`ranking_lookup_checked_at`), whereas `serp_results` was fetched 2026-07-20. The rankings may have drifted into the top-20 in the intervening 2.5 months.

Both would inflate the model-blind bucket (143 pairs / ~1,536 unscoreable monthly clicks) that the current snapshot dropped from Σm.

---

## Part 5 — Tracker flag (logged)

Added to `docs/calculation-v21-programme.md` open flags:

> **Smart Sync site-architecture stall (2026-07-20):** two consecutive Smart Sync invocations left 31 keywords unfulfilled with no client-side error. Needs edge-function log capture from the `site-architecture` function next attempt; triage post Gate B.

---

## Followups on operator re-run *(complete)*

Re-run `f3705db5` populated `pairs_scored[]` (94) and `pairs_model_blind[]` (143). Findings above. Awaiting advisor ruling on the one-line CTR unit fix at `calibration-compute/index.ts:338` before rerunning to confirm predicted green ratio.

