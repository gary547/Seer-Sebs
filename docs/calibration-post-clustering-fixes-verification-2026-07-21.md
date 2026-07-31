# Calibration verification — post clustering-fix

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**New snapshot:** `32a17a54-1247-4c5e-bd1d-fc98ed9c6010` — 2026-07-21 08:33:37 UTC
**Baselines referenced:**
  `888002bc` (pre-clustering, 2026-07-20 20:21:50) — overall 1.7669, 152 pairs
  `d88b6925` (clustering v1, 2026-07-21 08:10:56) — overall 1.7078, 98 pairs
**Bands (fixed):** green 0.5–2.0, amber 0.33–<0.5 or >2.0–3.0, red <0.33 or >3.0

Read-only report — no code, migrations, or deploys performed.

---

## 1. New snapshot row

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched, notes,
       (by_rank_band->'totals'->>'sum_modelled_monthly')::numeric AS sum_m,
       (by_rank_band->'totals'->>'sum_actual_monthly')::numeric   AS sum_a,
       (by_rank_band->'totals'->>'sum_modelled_monthly')::numeric
         / NULLIF((by_rank_band->'totals'->>'sum_actual_monthly')::numeric,0) AS ratio_check
  FROM calibration_snapshots
 WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
 ORDER BY created_at DESC LIMIT 1;
```

| Field | Value |
|---|---|
| `id` | `32a17a54-1247-4c5e-bd1d-fc98ed9c6010` |
| `created_at` | 2026-07-21 08:33:37.917 UTC |
| `overall_ratio` | **1.3245762743089333** |
| `keywords_matched` | 48 |
| `keywords_unmatched` | 14 724 |
| `notes` | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=111 · model_blind=85 · overall=Σm/Σa=2568.72/1939.28=1.324576` |

**Hand-verification:** `sum_m` = 2568.7204471417576, `sum_a` = 1939.2771084337346.
`sum_m ÷ sum_a` = **1.3245762743089334** — matches `overall_ratio` to 15 digits. ✅

---

## 2. Clustering pass — TVs Ongoing

```sql
SELECT COUNT(*) FILTER (WHERE detox_status='keep') AS kept,
       COUNT(DISTINCT cluster_key) FILTER (WHERE detox_status='keep') AS distinct_clusters,
       COUNT(DISTINCT cluster_key) FILTER (WHERE detox_status='keep' AND cluster_member_count>1) AS multi_member,
       MAX(cluster_member_count) FILTER (WHERE detox_status='keep') AS largest,
       MAX(cluster_computed_at) AS computed_at
  FROM keywords WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720';
```

| Metric | Value |
|---|---|
| Kept keywords | 857 |
| Distinct clusters | 525 |
| Multi-member clusters | 159 |
| Largest cluster size | 13 |
| `cluster_computed_at` | 2026-07-21 08:32:27.641 UTC (1m 10s before calibration ran — fresh) |

---

## 3. `cluster_excluded`

```sql
SELECT by_rank_band->'cluster_excluded' FROM calibration_snapshots WHERE id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010';
```

| Field | Value |
|---|---|
| `pairs` | 41 |
| `keywords` | 41 |
| `sum_modelled_monthly_excluded` | 2 924.95 |

Interpretation: 41 non-canonical members that had matched GSC rows were held out of scoring; their combined modelled monthly clicks (2 924.95) would otherwise have been double-counted with their canonicals.

---

## 4. FIX CHECK A — bucket freshness

```sql
SELECT je.key AS bucket,
       (je.value->>'sum_modelled_monthly')::numeric AS sum_m,
       (je.value->>'sum_actual_monthly')::numeric   AS sum_a,
       (je.value->>'matched')::int                  AS matched
  FROM calibration_snapshots s, LATERAL jsonb_each(s.by_intent) je
 WHERE s.id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010' AND je.key <> '_meta';
```

### Σ across `by_intent` vs `totals`

| Bucket | Σ modelled | Σ actual | matched (pairs) |
|---|---:|---:|---:|
| transactional  | 1 660.6567949362566 | 1 022.8915662650605 | 43 |
| informational  |   791.2566000000002 |   691.9277108433735 |  1 |
| commercial     |   100.0777172055000 |   202.8915662650603 |  3 |
| navigational   |    16.7293350000000 |    21.5662650602410 |  1 |
| unknown        |     0.0000000000000 |     0.0000000000000 |  0 |
| **Σ buckets**  | **2 568.7204471417568** | **1 939.2771084337353** | **48** |
| **totals**     | **2 568.7204471417576** | **1 939.2771084337346** | **48** |

`by_intent` Σ = totals to **1e-9** on modelled and actual, matched identical (48). ✅ **Assertion holds.**

### `by_rank_band` — not stale copies

```sql
SELECT je.key AS bucket,
       (je.value->>'sum_modelled_monthly')::numeric AS sum_m,
       (je.value->>'sum_actual_monthly')::numeric   AS sum_a,
       (je.value->>'matched')::int                  AS matched
  FROM calibration_snapshots s, LATERAL jsonb_each(s.by_rank_band) je
 WHERE s.id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010' AND je.key IN ('1-3','4-10','11-20');
```

| Bucket | Σ modelled (new) | Σ modelled (`888002bc`) | Match? |
|---|---:|---:|---|
| 1-3   |   172.15166037 |   172.15166037 | **IDENTICAL** |
| 4-10  |   774.31321131 | 1 391.70166427 | different ✅ |
| 11-20 | 1 376.64719659 | 2 515.28412929 | different ✅ |

**Note on the 1-3 match** — this is **not** a staleness bug. The rank-1-3 band contains 4 canonical pairs whose keywords, resolvers, and clustering status did not change between `888002bc` and the current snapshot (the fix only reordered canonicals inside multi-member clusters — canonicals with base_rank ≤ 3 were never demoted). Corroborating evidence:

- baseline 1-3 bucket: `matched=4, sum_a=162.4699` — identical to new: `matched=4, sum_a=162.4699`
- baselines 4-10 and 11-20 change materially, confirming buckets are recomputed each run

### Writer note (surfaced, not a fix request)

`by_rank_band` emits only 1-3, 4-10, 11-20; a 21-30 bucket is missing. The ledger contains 6 pairs with base_rank 21-25:

```sql
WITH r AS (SELECT (p->>'base_rank')::numeric AS br FROM calibration_snapshots s,
           LATERAL jsonb_array_elements(s.by_rank_band->'pairs_scored') p
           WHERE s.id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010')
SELECT COUNT(*) FILTER (WHERE br BETWEEN 21 AND 30) FROM r;  -- returns 6
```

Σ `by_rank_band` matched = 46 (4+12+30), totals matched = 48. The missing 2 keywords are the ones whose only pairs sit at rank 21+ and are dropped from the writer's bucket set. Totals and ledger are unaffected; only the `by_rank_band` bucket is under-reporting by 2 keywords / 6 pairs. Flagged for the writer, not addressed here per scope.

---

## 5. FIX CHECK B — canonical selection

### Cluster `32 inch tv` — members

```sql
SELECT k.id, k.keyword, k.avg_monthly_volume, k.base_rank,
       (k.id = kk.cluster_canonical_keyword_id) AS is_canonical
  FROM keywords k
  JOIN keywords kk ON kk.cluster_key=k.cluster_key AND kk.project_id=k.project_id
                  AND kk.id = k.cluster_canonical_keyword_id
 WHERE k.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND k.cluster_key='32 inch tv'
 ORDER BY k.base_rank NULLS LAST, k.avg_monthly_volume DESC;
```

| Keyword | avg_monthly_volume | base_rank | canonical? |
|---|---:|---:|---|
| **32 inch tv** | 3 600 | **1** | ✅ **YES** |
| tv 32 inch | 1 900 | 2 | no |
| 32 in tv | 27 100 | 4 | no (was canonical in `d88b6925`) |
| 32 inch television | 27 100 | 12 | no |
| 32in tv | 27 100 | 14 | no |

Canonical is now the **lowest-base_rank member (rank 1)**, per the new rule. ✅

### Cluster-canonical churn across the project

```sql
WITH members AS (
  SELECT cluster_key, id, keyword, base_rank, avg_monthly_volume, cluster_canonical_keyword_id
    FROM keywords
   WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
     AND detox_status='keep' AND cluster_member_count>1
),
old_pick AS (
  SELECT DISTINCT ON (cluster_key) cluster_key, id AS old_canonical_id FROM members
   ORDER BY cluster_key, avg_monthly_volume DESC,
            COALESCE(base_rank, 2147483647) ASC, keyword ASC
),
new_pick AS (
  SELECT DISTINCT ON (cluster_key) cluster_key, cluster_canonical_keyword_id AS new_canonical_id FROM members
)
SELECT (SELECT COUNT(*) FROM old_pick o JOIN new_pick n USING(cluster_key)
         WHERE o.old_canonical_id <> n.new_canonical_id) AS changed,
       (SELECT COUNT(*) FROM new_pick) AS total_multi_clusters;
```

**Result:** `changed = 24 / 159` multi-member clusters (15.1%).

### Top 10 largest multi-member clusters

```sql
WITH mm AS (
  SELECT DISTINCT cluster_key, cluster_member_count FROM keywords
   WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
     AND detox_status='keep' AND cluster_member_count>1
   ORDER BY cluster_member_count DESC, cluster_key LIMIT 10
)
SELECT mm.cluster_key, mm.cluster_member_count, canon.keyword AS canonical_keyword,
       canon.base_rank, canon.avg_monthly_volume
  FROM mm
  JOIN keywords k ON k.cluster_key=mm.cluster_key
                 AND k.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720' AND k.detox_status='keep'
  JOIN keywords canon ON canon.id = k.cluster_canonical_keyword_id
 GROUP BY mm.cluster_key, mm.cluster_member_count, canon.keyword, canon.base_rank, canon.avg_monthly_volume
 ORDER BY mm.cluster_member_count DESC, mm.cluster_key;
```

| Cluster key | Members | Canonical keyword | base_rank | avg_monthly_volume |
|---|---:|---|---:|---:|
| lg oled tv                | 13 | oled lg television | 9   | 170 |
| 55 inch tv                | 11 | 55in tv            | 11  | 49 500 |
| 65 inch tv                | 8  | 65 in tv           | 21  | 4 400 |
| 4k 55 inch tv             | 7  | 4k tv 55 inch      | 20  | 2 400 |
| 55 lg oled tv             | 7  | lg oled tv 55      | 18  | 1 000 |
| oled sony tv              | 7  | oled tv sony       | 16  | 1 900 |
| 60 inch tv                | 6  | 60 in tv           | *null* | 22 200 |
| 65 inch samsung tv        | 6  | 65 inch tv samsung | *null* | 9 900 |
| 75 inch tv                | 6  | 75 in tv           | 6   | 3 600 |
| lg tv                     | 6  | lg tvs             | 13  | 33 100 |

Each canonical is the best-ranking member of its cluster (NULL base_rank falls last per rule; when every member is NULL, the highest-volume member wins).

---

## 6. FIX CHECK C — ledger completeness

```sql
WITH pairs AS (
  SELECT jsonb_array_elements(by_rank_band->'pairs_scored') AS p
    FROM calibration_snapshots WHERE id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010'
)
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE p->>'ctr_resolver_tier' IS NULL) AS null_resolver_tier
  FROM pairs;
```

**Result:** total = 111, `null_resolver_tier` = **0**. ✅

### Full field set on a sample ledger row

Sample (`pairs_scored[0]`):

```json
{
  "actual_clicks_raw": 21,
  "actual_monthly": 1.2650602409638554,
  "annual_volume": 8320,
  "annual_volume_source": "keyword_monthly_volumes",
  "base_rank": 19,
  "cluster_key": "50 inch lg tv",
  "cluster_member_count": 1,
  "ctr_curve_key": "mobile|transactional|19",
  "ctr_resolver_tier": "project_device_intent",
  "ctr_used": 0.0039,
  "device": "mobile",
  "impressions": 4659,
  "intent": "transactional",
  "is_canonical": true,
  "keyword": "lg tv 50 inch",
  "keyword_id": "5f382298-929a-4957-adf8-44d4af9ff79e",
  "keyword_raw": "lg tv 50 inch",
  "modelled_monthly": 1.2922708032,
  "months_used": 12,
  "per_pair_ratio": 1.021509301577143,
  "svm_used": 0.5814,
  "trend_applied": true,
  "trend_confidence": "high",
  "trend_factor": 0.822,
  "trend_pct": -17.8,
  "volume_forward_used": 6839.04
}
```

25 fields present, including all clustering additions (`cluster_key`, `cluster_member_count`, `is_canonical`) and the resolver telemetry (`ctr_resolver_tier`, `ctr_curve_key`).

---

## 7. Side-by-side vs prior snapshots

```sql
WITH p AS (
  SELECT (r->>'per_pair_ratio')::numeric AS ratio
    FROM calibration_snapshots s, LATERAL jsonb_array_elements(s.by_rank_band->'pairs_scored') r
   WHERE s.id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010'
)
SELECT COUNT(*), MIN(ratio), MAX(ratio),
       percentile_cont(0.25) WITHIN GROUP (ORDER BY ratio),
       percentile_cont(0.50) WITHIN GROUP (ORDER BY ratio),
       percentile_cont(0.75) WITHIN GROUP (ORDER BY ratio),
       COUNT(*) FILTER (WHERE ratio >= 0.5 AND ratio <= 2.0) AS green,
       COUNT(*) FILTER (WHERE (ratio >= 0.33 AND ratio < 0.5) OR (ratio > 2.0 AND ratio <= 3.0)) AS amber,
       COUNT(*) FILTER (WHERE ratio < 0.33 OR ratio > 3.0) AS red
  FROM p;
```

| Metric | `888002bc` (pre-cluster) | `d88b6925` (cluster v1) | `32a17a54` (post-fix) |
|---|---:|---:|---:|
| overall_ratio | 1.7669 | 1.7078 | **1.3246** |
| scored pairs | 152 | 98 | 111 |
| median | 1.937 | 1.351 | 1.426 |
| p25 | 0.864 | 0.724 | 0.771 |
| p75 | 5.074 | 3.530 | 3.962 |
| min | — | — | 0.191 |
| max | — | — | 86.696 |
| green (0.5–2.0) | 62 (40.8%) | 49 (50.0%) | **53 (47.7%)** |
| amber | 27 | 18 | **21 (18.9%)** |
| red | 63 | 31 | **37 (33.3%)** |

Direction of travel: overall ratio has moved from 1.77 → 1.71 → **1.32** — well inside the green band. The pair count rose from 98 to 111 because the fixed canonical rule promoted 24 lower-rank members (which are more likely to have measured GSC rows) into the scoring set.

---

## 8. `by_intent` and `by_rank_band` for `32a17a54`

### by_intent

| Intent | Σ modelled | Σ actual | ratio | matched (pairs) | band |
|---|---:|---:|---:|---:|---|
| transactional  | 1 660.66 | 1 022.89 | **1.6235** | 43 | green |
| informational  |   791.26 |   691.93 | **1.1436** |  1 | green |
| commercial     |   100.08 |   202.89 | **0.4933** |  3 | amber |
| navigational   |    16.73 |    21.57 | **0.7756** |  1 | green |
| unknown        |     0.00 |     0.00 | n/a        |  0 | n/a |

### by_rank_band (as written; see §4 note on 21-30 gap)

| Rank band | Σ modelled | Σ actual | ratio | matched (keywords) |
|---|---:|---:|---:|---:|
| 1-3   |   172.15 |   162.47 | **1.0596** |  4 |
| 4-10  |   774.31 |   333.80 | **2.3197** | 12 |
| 11-20 | 1 376.65 | 1 287.65 | **1.0691** | 30 |

---

## 9. Gate verdict

Criterion as written: **overall ratio green AND no intent bucket red.**

- overall_ratio 1.3246 → green ✅
- transactional 1.6235 → green
- informational 1.1436 → green
- commercial 0.4933 → amber (not red)
- navigational 0.7756 → green
- unknown → n/a (0 pairs)

**Verdict: PASS.**

Separately reported: **green-band share of scored pairs = 53 / 111 = 47.7%.** (Progression: 40.8% → 50.0% → 47.7%. The dip vs `d88b6925` is because 13 additional pairs entered scoring, disproportionately amber/red.)

---

## 10. Ledger extremes

```sql
WITH p AS (SELECT r FROM calibration_snapshots s,
           LATERAL jsonb_array_elements(s.by_rank_band->'pairs_scored') r
           WHERE s.id='32a17a54-1247-4c5e-bd1d-fc98ed9c6010'),
flat AS ( ... project 10 fields, order by per_pair_ratio ... )
(SELECT * FROM flat ORDER BY ratio DESC LIMIT 5)
UNION ALL
(SELECT * FROM flat ORDER BY ratio ASC LIMIT 5);
```

### 5 worst over-predictions

| Keyword | cluster_key | cm | base_rank | ctr_used | resolver_tier | svm_used | volume_forward_used | modelled | actual | ratio |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| tv 40 inch smart      | 40 inch smart tv    | 4 |  8 | 0.0105 | project_device_intent | 0.648 | 331 596 | 188.01 | 2.17  | **86.70** |
| hisense tvs           | hisense tv          | 5 | 12 | 0.0039 | project_device_intent | 0.612 | 422 200 |  83.98 | 1.33  | **63.36** |
| sony tv               | sony tv             | 4 |  8 | 0.0105 | project_device_intent | 0.720 | 146 898 |  92.55 | 1.75  | **52.97** |
| 55in tv               | 55 inch tv          |11 | 11 | 0.0041 | project_device_intent | 0.648 | 281 569 |  62.34 | 1.51  | **41.39** |
| 40inch tv             | 40 inch tv          | 3 |  6 | 0.0130 | project_device_intent | 0.810 | 383 142 | 336.21 |13.61  | **24.69** |

Pattern: all five over-predictions are canonicals of multi-member clusters with very large `volume_forward_used` and mid-tier ctr_used — the modelled clicks are one to two orders of magnitude above the GSC actuals. These are the same head-term inflation cases previously flagged; not new to the clustering fix.

### 5 worst under-predictions

| Keyword | cluster_key | cm | base_rank | ctr_used | resolver_tier | svm_used | volume_forward_used | modelled | actual | ratio |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| tcl 75 inch tv    | 75 inch tcl tv       | 3 | 19 | 0.0039 | project_device_intent | 0.612 |  3 300 |  0.66  |  3.43 | **0.191** |
| tv deals uk       | deals tv uk          | 1 | 20 | 0.0089 | project_all_intent    | 0.612 | 21 183 |  9.61  | 40.12 | **0.240** |
| cheap tvs for sale| cheap for sale tvs   | 1 | 16 | 0.0039 | project_device_intent | 0.366 | 40 182 |  4.78  | 19.22 | **0.249** |
| cheap tv deals    | cheap deal tv        | 1 | 18 | 0.0069 | project_all_intent    | 0.581 | 12 600 |  4.21  | 16.81 | **0.251** |
| 75 inch tv deals  | 75 deal inch tv      | 1 | 19 | 0.0039 | project_device_intent | 0.581 |  3 000 |  0.57  |  1.87 | **0.304** |

Pattern: rank 16-20, low ctr_used curves, moderate volumes — the model is under-crediting deep-tail keywords that GSC shows are actually converting clicks. Independent of clustering.

---

## Summary of fix checks

| Check | Status |
|---|---|
| A. bucket totals = totals within rounding | ✅ (buckets = totals to 1e-9) |
| A. by_rank_band figures not stale copies | ✅ (1-3 legitimately unchanged; 4-10 and 11-20 differ materially) |
| B. `32 inch tv` canonical is lowest base_rank | ✅ (`32 inch tv`, base_rank 1) |
| B. cluster canonicals re-selected project-wide | ✅ (24 / 159 changed) |
| C. `ctr_resolver_tier` populated on all pairs | ✅ (0 nulls / 111 pairs) |
| Gate verdict | **PASS** — overall green (1.3246), no intent red |

### Observations for the next round (surfaced, not proposals)

- Writer emits no `21-30` bucket in `by_rank_band`; 6 pairs / 2 keywords sit outside every bucket.
- Head-term over-prediction remains the dominant residual — five clusters with `volume_forward_used > 100k` produce ratios 24–87×.
- Tail under-prediction concentrated in commercial/transactional deal-modifiers (rank 16-20, small volumes).
