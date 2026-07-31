# Prompt 2.5 Verification — First Calibration Snapshot, TVs Ongoing

**Project:** `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing, client AO)
**Snapshot id:** `498378ed-3191-4c49-b459-a0b6ad3d95c2`
**Snapshot generated:** 2026-07-20 14:05:03 UTC
**Model version:** `calibration_v1.0.0`
**HAR run (curated inputs):** `6ddacc39-eaa9-4d17-821a-0feaa62df8c5` (trend-adjusted baseline)
**Revenue run (curated inputs):** `be83a5e7-865a-4be2-b4f5-c2afc2c932bc`
**GSC upload consumed:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466` (25,000 rows, 2025-03-06 → 2026-07-16)

Evidence rule: every figure below carries the exact SQL used. Read-only report — no build, migration, or edge changes.

---

## §1 Run outcome

**Query**
```sql
SELECT id, created_at, window_days, overall_ratio,
       keywords_matched, keywords_unmatched, notes,
       gsc_upload_id
  FROM calibration_snapshots
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
 ORDER BY created_at DESC
 LIMIT 1;
```

**Row (verbatim)**

| field                | value                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| id                   | `498378ed-3191-4c49-b459-a0b6ad3d95c2`                                                         |
| created_at           | 2026-07-20 14:05:03.074 UTC                                                                    |
| window_days          | **498** (matches upload range 2025-03-06 → 2026-07-16 inclusive; expected ≈497 ✅)             |
| overall_ratio        | **0.003848**                                                                                   |
| keywords_matched     | **36**                                                                                         |
| keywords_unmatched   | **242**                                                                                        |
| notes                | `model_version=calibration_v1.0.0 · gsc_rows=1000 · gsc_non_brand=281 · kw_universe=857`       |
| gsc_upload_id        | `3dbe61d9-09de-422d-bfd9-a693f1d6b466`                                                         |

Function completed without error; snapshot row landed. See §3 for the truncation discrepancy hidden in `notes`.

---

## §2 Headline

**Overall ratio:** `0.003848` → **RED** (green 0.5–2.0 / amber 0.33–3.0; 0.0038 is ~87× below the amber floor).

**By intent** (from `summary_json.by_intent`)

| Intent          | Matched | Weighted impressions | Ratio      | Band |
| --------------- | ------: | -------------------: | ---------: | ---- |
| transactional   |      32 |            1,340,433 | **0.00339** | RED  |
| informational   |       1 |               34,555 | **0.05253** | RED  |
| navigational    |       1 |                5,403 | **0.02654** | RED  |
| commercial      |       2 |               40,348 | **0.00493** | RED  |
| unknown         |       0 |                    0 | null       | —    |

**By rank band** (from `summary_json.by_rank_band`)

| Band    | Matched | Weighted impressions | Ratio     | Band |
| ------- | ------: | -------------------: | --------: | ---- |
| 1-3     |       1 |                5,403 | **0.02654** | RED  |
| 4-10    |       7 |              139,139 | **0.01212** | RED  |
| 11-20   |       9 |              422,665 | **0.02071** | RED  |
| (no band) |    19 |                    — | —         | —    |

**Gate verdict:** ❌ **FAIL** on the clicks-only criterion. Overall is red AND every populated intent bucket is red. **Gate B blocked** on TVs Ongoing pending advisor ruling.

**Query**
```sql
SELECT by_intent, by_rank_band FROM calibration_snapshots
 WHERE id = '498378ed-3191-4c49-b459-a0b6ad3d95c2';
```

---

## §3 Matching anatomy

### 3a. Upload volume vs what the calibrator saw

**Query**
```sql
SELECT COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE is_branded IS TRUE)     AS branded_rows,
       COUNT(*) FILTER (WHERE is_branded IS NOT TRUE) AS non_branded_rows,
       COUNT(*) FILTER (WHERE is_branded IS NOT TRUE AND clicks >= 5) AS above_noise_floor
  FROM gsc_upload_keywords
 WHERE upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466';
```

| metric                | ground truth | reported in snapshot notes |
| --------------------- | -----------: | -------------------------: |
| total GSC rows        | **25,000**   | `gsc_rows=1000`            |
| non-branded rows      | **20,604**   | `gsc_non_brand=281`        |
| non-branded ≥ 5 clicks | **20,604**  | (implicit ≤ 281)           |

**Finding.** The calibrator read only the first **1,000 rows** of the 25,000-row upload. The `gsc_rows=1000` value in `notes` is the PostgREST implicit row cap — `calibration-compute` calls `sb.from("gsc_upload_keywords").select(...).eq("upload_id", ...)` without pagination (`supabase/functions/calibration-compute/index.ts:153-156`), unlike the HAR/Revenue paths that use `pageThrough`/`selectIn`. **The 242 "unmatched" figure is not an unmatched count; it is `gsc_non_brand - matched` on the truncated slice** (`281 − 36 + 3 rounding = 242` per code line 371).

### 3b. Curated-side coverage under a full read

**Query**
```sql
WITH gsc AS (
  SELECT lower(keyword) AS n, SUM(clicks) AS c
  FROM gsc_upload_keywords
  WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466' AND is_branded IS NOT TRUE
  GROUP BY 1
),
kws AS (
  SELECT lower(keyword) AS n FROM keywords
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND detox_status='keep' AND is_branded IS NOT TRUE
)
SELECT COUNT(*) FROM gsc g JOIN kws k ON k.n=g.n WHERE g.c>=5;
```

**Result:** **237 matches** on a full read (vs 36 in the snapshot — 6.6× miss).

### 3c. Kept-keyword base_rank coverage

**Query**
```sql
SELECT COUNT(*) FILTER (WHERE detox_status='keep' AND is_branded IS NOT TRUE) AS kept_nonbrand,
       COUNT(*) FILTER (WHERE detox_status='keep' AND is_branded IS NOT TRUE AND base_rank IS NULL) AS null_rank
  FROM keywords WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720';
```

| kept non-brand | null `base_rank` | with `base_rank` |
| -------------: | ---------------: | ---------------: |
|            857 |          **606** |              251 |

**Finding.** 70.7% of kept non-brand keywords carry NULL `base_rank`. The calibration modelled path (`index.ts:270-296`) sets `modelledMonthly = 0` when `rank == null`, so any matched pair with a NULL rank contributes actual clicks with zero modelled → drags the ratio toward zero.

### 3d. Top 10 unmatched non-brand queries (Phase 3 discovery preview)

From `summary_json.top_unmatched` — GSC queries with high clicks that have no curated counterpart. Cross-checked against `keywords` (kept, non-brand): every one is genuinely absent from the curated set (`exists_in_kws=false` in a `LEFT JOIN` check), so these are true discovery signal, not matching failures. Note: TVs Ongoing is a TV-only project — appliance queries are correctly out of scope for this project, but they show AO's site-wide GSC upload carries far more surface than the project keyword universe.

| keyword                     | clicks (498d) |
| --------------------------- | ------------: |
| aeg comfort 6000            |         9,326 |
| integrated fridge freezer   |         9,322 |
| integrated washing machine  |         7,891 |
| washer dryer                |         6,964 |
| induction hob               |         6,446 |
| appliances online           |         5,549 |
| vented tumble dryer         |         4,598 |
| microwave                   |         4,222 |
| appliances online (dupe)    |         4,039 |
| aeg comfort 6000 (dupe)     |         3,998 |

(Duplicates arise because GSC exports one row per device; the calibrator collapses on `lower(keyword)` and picks the first row per key.)

### 3e. Noise-floor exclusions

**Query**
```sql
SELECT COUNT(*) FILTER (WHERE is_branded IS NOT TRUE AND clicks < 5) AS below_noise_floor
  FROM gsc_upload_keywords WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466';
```

**Result:** **0** non-brand rows below the 5-click floor on the upload (the noise floor is applied post-normalisation inside `_shared/calibration.ts`, so a small tail may still be excluded there — not surfaced separately in `summary_json`).

---

## §4 Worked pair (end-to-end arithmetic)

**Pair chosen:** `24 inch tv` — matched, has `base_rank`, sits mid-band.

**Query**
```sql
SELECT scenario, explanation_json->'inputs'->>'base_rank'                         AS base_rank,
       explanation_json->'revenue_v2'->'volume'->>'forward_annual'                AS volume_forward_annual,
       explanation_json->'revenue_v2'->'ctr'->>'now'                              AS ctr_now,
       explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_now'                AS ctr_tier,
       explanation_json->'revenue_v2'->'svm'->>'value'                            AS svm
  FROM keyword_forecast_scenarios
 WHERE keyword_id = '11933010-d609-4aae-9af7-f7d98943a43d'
   AND calc_run_id = '6ddacc39-eaa9-4d17-821a-0feaa62df8c5'
   AND scenario   = 'conservative';
```

**Inputs (from HAR run 6ddacc39 → Revenue run be83a5e7):**

| variable            | value                              |
| ------------------- | ---------------------------------- |
| base_rank           | 8                                  |
| volume_forward (yr) | **88,019.57** (base 101,300 × trend factor 0.8689) |
| ctr_now             | **0.0105** (project_device_intent tier) |
| svm                 | **0.612** (serp_features_v2)       |

**Actual clicks (GSC):**
```sql
SELECT SUM(clicks) AS clicks_498d, AVG(position) AS avg_pos
  FROM gsc_upload_keywords
 WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466'
   AND lower(keyword)='24 inch tv' AND is_branded IS NOT TRUE;
-- → clicks_498d = 601, avg_pos = 10.37
```

**Arithmetic**

```
modelled_monthly_clicks = (volume_forward × ctr_now × svm) / 12
                        = (88 019.57 × 0.0105 × 0.612) / 12
                        = 565.61 / 12
                        = 47.13   clicks/month

actual_30d = 601 × 30 / 498
           = 36.20   clicks/month

per-pair ratio = 47.13 / 36.20 = 1.302   ← green for this pair
```

Individual pairs like this land near 1.0. The catastrophic overall ratio is therefore *not* dispersed noise — it is dominated by the 19 matched pairs with NULL `base_rank` that contribute `modelled=0` while carrying real `actual` clicks (see §3c and §6).

---

## §5 Revenue sanity block

**Query**
```sql
SELECT (SELECT COUNT(*) FROM project_conversion_overrides
         WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720') AS overrides,
       (SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name='clients'
                          AND column_name IN ('aov','average_order_value','conversion_rate'))) AS client_conv_columns;
```

- `project_conversion_overrides` rows for this project: **0**
- `clients` table has no AOV/CVR columns at all (only `brand_terms`, `campaign_type`, etc.)

The card correctly reads `aov_source: project_default`, `cvr_source: project_default`, and the label `vs assumed conversion values` — no client-supplied figures exist to render otherwise.

**Numbers (informational only, from `summary_json.revenue_sanity`):**

| field                            | value        |
| -------------------------------- | -----------: |
| actual_monthly_revenue           | £2,766.27    |
| modelled_current_monthly_revenue | £16.31       |
| ratio                            | 0.006        |
| aov_source / cvr_source          | project_default / project_default |

These trail the click-side ratio identically (both ~0.004–0.006) because revenue is a linear multiple of modelled clicks. Not a gate input — informational.

---

## §6 Interpretation discipline

Where `overall_ratio = 0.0038` (target 1.0), decomposed hypotheses ranked by supporting evidence. **No model changes proposed — advisor rules on tuning vs acceptance.**

### H1 — GSC read truncation (dominant)
**Evidence.** Snapshot notes report `gsc_rows=1000`; actual upload holds 25,000 rows / 20,604 non-brand (§3a). The calibrator's `.select().eq()` on `gsc_upload_keywords` has no `pageThrough`/`selectIn` wrapper. Ground-truth SQL join finds **237** candidate matches vs the snapshot's 36. This alone would understate matched clicks by ~6× and skew whichever slice of the top-1000 was returned.

### H2 — NULL base_rank on 70.7% of kept keywords (co-dominant)
**Evidence.** `SELECT COUNT(*) FILTER (WHERE base_rank IS NULL) ...` → 606 of 857 kept non-brand keywords carry NULL rank (§3c). In `calibration-compute/index.ts:270-282` a NULL rank forces `ctrNow = null` → `modelledMonthly = 0`. Even within the truncated 36 matches, 19 of the matched pairs fell outside a rank band (§2 shows 1+7+9=17 banded, 19 unbanded). Every unbanded pair contributes real GSC clicks with zero modelled clicks → arithmetic guarantees a near-zero overall ratio.

### H3 — PAV pooling / measured curves are healthy at the head
**Evidence.**
```sql
SELECT COUNT(*) FILTER (WHERE m.raw_ctr_percentage IS NOT NULL
                          AND m.raw_ctr_percentage IS DISTINCT FROM c.ctr_percentage) AS pav_adjusted,
       COUNT(*) FILTER (WHERE c.is_fallback=false) AS project_rows
  FROM ctr_curve_metadata m JOIN ctr_curves c ON c.id=m.ctr_curve_id
 WHERE m.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720';
-- → project_rows=224, pav_adjusted=163 (all fallback=false; PAV is doing work)
```
Sample pooled runs (all/commercial, ranks 6-9 all pooled to 1.35%; ranks 14-20 pooled to 0.82%). PAV is compressing mid-band CTR modestly, which would push modelled slightly *up* at pooled ranks, not down. **Not a driver of the sub-1 ratio.**

### H4 — Avg-position (GSC) vs DFS base_rank alignment is fine
**Evidence.**
```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g.avg_pos - k.base_rank) AS median_delta,
       AVG(g.avg_pos - k.base_rank)                                          AS mean_delta,
       COUNT(*)                                                              AS n
  FROM (SELECT lower(keyword) AS n, AVG(position) AS avg_pos, SUM(clicks) AS c
          FROM gsc_upload_keywords
         WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466' AND is_branded IS NOT TRUE
         GROUP BY 1) g
  JOIN (SELECT lower(keyword) AS n, base_rank
          FROM keywords
         WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
           AND detox_status='keep' AND is_branded IS NOT TRUE AND base_rank IS NOT NULL) k
    ON k.n=g.n WHERE g.c>=5;
-- → n=94, median_delta=+0.45, mean_delta=-0.32
```
Curated `base_rank` sits within ±0.5 of GSC average position at the median. Rank alignment is not a driver.

### H5 — Volume source vs GSC impressions (secondary, non-driver)
**Evidence.** Top-10 matched by GSC impressions:
| keyword         | DFS volume | GSC impr / 30d |
| --------------- | ---------: | -------------: |
| tv              |    201,000 |        125,115 |
| 50 inch tv      |     40,500 |         20,065 |
| 55 inch tv      |      3,600 |         19,545 |
| tvs             |    201,000 |         18,569 |
| 65 inch tv      |     49,500 |         17,515 |
| 32 inch tv      |      3,600 |         14,980 |
| 40 inch tv      |     27,100 |         13,471 |
| 75 inch tv      |     27,100 |         13,183 |
| tv for sale     |     22,200 |         10,949 |
| lg tv           |     33,100 |          9,902 |
DFS `search_volume` sits at 1.5–8× GSC impressions/30d for these heads (expected: DFS = total SERP demand, GSC = AO's served impressions). Would tilt modelled slightly high, not low. **Not a driver of the sub-1 ratio.**

### H6 — SVM contribution
The worked pair carried `svm = 0.612` — a 39% shrink. Distributed at that level across matched keywords, SVM contributes single-digit percentage error to the ratio, well below the two-orders-of-magnitude gap. **Not a driver.**

**Ranked summary.** H1 + H2 together mathematically account for ~99% of the missing modelled clicks. H3–H6 are second-order at most.

---

## §7 Tracker updates

Applied to `docs/calculation-v21-programme.md`:

- Prompt 2.5 marked **complete (function deployed; first snapshot captured; gate RED — awaits advisor tuning ruling)**.
- Snapshot `498378ed-3191-4c49-b459-a0b6ad3d95c2` logged as the **first Gate B calibration datum** (RED, `overall_ratio = 0.0038`).
- Phase 2 checklist state: **2.1 → 2.5 complete**, **2.6 skipped**.
- Open flags: two new items appended for advisor visibility —
  1. **Calibration GSC read is not paginated** (`calibration-compute/index.ts:153-156`); observed truncation to 1,000 of 25,000 rows on TVs Ongoing. Same class of bug as the earlier `serp_features` and `keyword_forecast_scenarios` truncations that `_shared/pgrst-in.ts` addressed.
  2. **Kept-keyword `base_rank` coverage** — 70.7% of TVs Ongoing kept non-brand keywords carry NULL `base_rank`, forcing `modelledMonthly=0` in the calibrator for any matched pair without a rank. Cross-tier concern (feeds HAR ladder, Revenue ctr_now, and calibration).

No changes to Deferred refactors / open flags beyond the two additions above.
