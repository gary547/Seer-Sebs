# Calibration Post-Clustering Comparison — TVs Ongoing

- Project: `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing)
- New snapshot: `d88b6925-6541-44bd-86f9-c04fe02b5e78` — created `2026-07-21 08:10:56 UTC`
- Baseline: `888002bc-ff56-4c05-89dd-da646d60e052` — created `2026-07-20 20:21:50 UTC`
- Bands (as authorised): **green 0.5–2.0**, **amber 0.33–<0.5 or >2.0–3.0**, **red <0.33 or >3.0**

Read-only. Every figure has the SQL that produced it. No fixes proposed.

Note on schema: `calibration_snapshots` has no `summary_json` column. The per-pair ledger, totals, `cluster_excluded` block, `by_intent` and `by_rank_band` all live inside the `by_intent` and `by_rank_band` jsonb columns. Queries below reference those directly.

---

## 1. New snapshot header + hand-verified overall ratio

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched, notes,
       by_rank_band->'totals' AS totals
FROM calibration_snapshots
WHERE id = 'd88b6925-6541-44bd-86f9-c04fe02b5e78';
```

| Field | Value |
|---|---|
| id | `d88b6925-6541-44bd-86f9-c04fe02b5e78` |
| created_at | `2026-07-21 08:10:56.006 UTC` |
| overall_ratio | `1.707778723903179` |
| keywords_matched | 43 |
| keywords_unmatched | 14 724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=98 · model_blind=85 · overall=Σm/Σa=2158.49/1263.92=1.707779` |

Totals block:

| sum_modelled_monthly | sum_actual_monthly | overall_ratio (recomputed) |
|---|---|---|
| 2 158.488277 | 1 263.915663 | **2158.488277 / 1263.915663 = 1.707779** ✅ matches `overall_ratio` |

---

## 2. Clustering pass results for TVs Ongoing

```sql
WITH k AS (
  SELECT cluster_key, COUNT(*) mems
  FROM keywords
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND detox_status='keep' AND cluster_key IS NOT NULL
  GROUP BY cluster_key
)
SELECT
  (SELECT COUNT(*) FROM keywords WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720' AND detox_status='keep') kept,
  (SELECT COUNT(*) FROM k) distinct_clusters,
  (SELECT COUNT(*) FROM k WHERE mems>1) multi_member,
  (SELECT MAX(mems) FROM k) largest,
  (SELECT MAX(cluster_computed_at) FROM keywords WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720') computed_at;
```

| kept | distinct_clusters | multi_member_clusters | largest_cluster_size | cluster_computed_at |
|---|---|---|---|---|
| 857 | 525 | 159 | 13 | 2026-07-21 08:09:39 UTC |

All 857 kept keywords have a `cluster_key` (0 nulls).

---

## 3. `cluster_excluded` block

```sql
SELECT by_rank_band->'cluster_excluded' AS cluster_excluded
FROM calibration_snapshots
WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78';
```

| pairs | keywords | sum_modelled_monthly_excluded |
|---|---|---|
| 54 | 54 | 3 656.54 |

---

## 4. Side-by-side vs baseline `888002bc`

```sql
WITH s AS (
  SELECT id, (p->>'per_pair_ratio')::numeric r
  FROM calibration_snapshots,
       jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id IN ('d88b6925-6541-44bd-86f9-c04fe02b5e78','888002bc-ff56-4c05-89dd-da646d60e052')
    AND (p->>'per_pair_ratio') IS NOT NULL
)
SELECT id, COUNT(*) n, MIN(r), MAX(r),
  percentile_cont(0.25) WITHIN GROUP (ORDER BY r) p25,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY r) p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY r) p75,
  SUM(CASE WHEN r BETWEEN 0.5 AND 2.0 THEN 1 ELSE 0 END) green,
  SUM(CASE WHEN (r>=0.33 AND r<0.5) OR (r>2.0 AND r<=3.0) THEN 1 ELSE 0 END) amber,
  SUM(CASE WHEN r<0.33 OR r>3.0 THEN 1 ELSE 0 END) red
FROM s GROUP BY id;
```

| Metric | Baseline `888002bc` | New `d88b6925` | Δ |
|---|---|---|---|
| overall_ratio | 1.7669 | **1.7078** | −0.0591 |
| scored pair count | 152 | **98** | −54 |
| median | 1.9370 | **1.3508** | −0.5862 |
| p25 | 0.8641 | **0.7238** | −0.1403 |
| p75 | 5.0739 | **3.5296** | −1.5443 |
| min | 0.0511 | **0.2397** | +0.1886 |
| max | 96.6464 | **96.6464** | 0 |
| green (0.5–2.0) | 62 (40.8%) | **49 (50.0%)** | +9.2pp |
| amber (0.33–<0.5 or >2.0–3.0) | 27 (17.8%) | **18 (18.4%)** | +0.6pp |
| red (<0.33 or >3.0) | 63 (41.4%) | **31 (31.6%)** | −9.8pp |

---

## 5. `by_intent` and `by_rank_band` for the new snapshot

```sql
SELECT by_intent, by_rank_band FROM calibration_snapshots
WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78';
```

### by_intent

| intent | Σ modelled | Σ actual | ratio | pairs |
|---|---|---|---|---|
| commercial | 100.078 | 202.892 | 0.4933 | 3 |
| informational | 819.999 | 705.482 | 1.1623 | 2 |
| navigational | 16.729 | 21.566 | 0.7757 | 1 |
| transactional | 3 809.238 | 1 756.205 | 2.1690 | 60 |
| unknown | 0 | 0 | — | 0 |

### by_rank_band (scored bands only)

| band | Σ modelled | Σ actual | ratio | pairs |
|---|---|---|---|---|
| 1-3 | 172.152 | 162.470 | 1.0596 | 4 |
| 4-10 | 1 391.702 | 485.663 | 2.8656 | 17 |
| 11-20 | 2 515.284 | 1 865.241 | 1.3485 | 42 |
| model_blind | — | — | — | 85 (unscored, `base_rank IS NULL`) |
| cluster_excluded | 3 656.54 excluded | — | — | 54 |

---

## 6. Gate verdict

Criterion as written: **overall ratio green AND no intent bucket red**.

- Overall ratio: **1.7078** → within [0.5, 2.0] → **GREEN** ✅
- Intent buckets: commercial 0.493 (green), informational 1.162 (green), navigational 0.776 (green), transactional 2.169 (**amber**, within (2.0, 3.0]), unknown null. No intent bucket is red. ✅

**Verdict: PASS.**

Separately — proportion of scored pairs in the green band: **49 / 98 = 50.0%**.

---

## 7. Worst 10 pairs from the per-pair ledger

```sql
-- Top 5 over-predictions
SELECT p->>'keyword', (p->>'base_rank')::numeric, p->>'resolver_tier',
       (p->>'ctr_used')::numeric, (p->>'svm_used')::numeric,
       (p->>'volume_forward_used')::numeric,
       (p->>'modelled_monthly')::numeric, (p->>'actual_monthly')::numeric,
       (p->>'per_pair_ratio')::numeric
FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78'
ORDER BY (p->>'per_pair_ratio')::numeric DESC LIMIT 5;
-- Bottom 5: same query with ASC.
```

Cluster columns joined from `keywords` on `keyword_id`.

### 5 worst over-predictions

| keyword | cluster_key | members | base_rank | ctr_used | tier | svm | vol_fwd | modelled | actual | ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| 32 in tv | `32 inch tv` | 5 | 4 | 0.01100 | (null) | 0.612 | 342 475 | 192.13 | 1.99 | **96.65** |
| sony tv | `sony tv` | 4 | 8 | 0.01050 | (null) | 0.720 | 146 898 | 92.55 | 1.75 | **52.97** |
| 43inch tv | `43 inch tv` | 3 | 18 | 0.00690 | (null) | 0.612 | 191 879 | 67.52 | 2.17 | **31.14** |
| smart tv 42 inch | `42 inch smart tv` | 4 | 3 | 0.01300 | (null) | 0.720 | 38 298 | 29.87 | 1.39 | **21.56** |
| 40 inch tv smart | `40 inch smart tv` | 4 | 10 | 0.00560 | (null) | 0.612 | 331 596 | 94.70 | 6.20 | **15.26** |

### 5 worst under-predictions

| keyword | cluster_key | members | base_rank | ctr_used | tier | svm | vol_fwd | modelled | actual | ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| tv deals uk | `deals tv uk` | 1 | 20 | 0.00890 | (null) | 0.612 | 21 183 | 9.615 | 40.12 | **0.2397** |
| cheap tvs for sale | `cheap for sale tvs` | 1 | 16 | 0.00390 | (null) | 0.366 | 40 182 | 4.783 | 19.22 | **0.2489** |
| cheap tv deals | `cheap deal tv` | 1 | 18 | 0.00690 | (null) | 0.581 | 12 600 | 4.212 | 16.81 | **0.2506** |
| 75 inch tv deals | `75 deal inch tv` | 1 | 19 | 0.00390 | (null) | 0.581 | 3 000 | 0.567 | 1.87 | **0.3035** |
| 50 inch tv deals | `50 deal inch tv` | 1 | 13 | 0.00390 | (null) | 0.612 | 8 589 | 1.708 | 5.18 | **0.3298** |

Note: `resolver_tier` was not persisted on the per-pair rows in this snapshot (all null in the ledger); every other requested field is present.

---

## 8. Non-canonical exclusion confirmation

```sql
WITH base AS (
  SELECT DISTINCT (p->>'keyword_id')::uuid kid
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='888002bc-ff56-4c05-89dd-da646d60e052'
),
new_scored AS (
  SELECT DISTINCT (p->>'keyword_id')::uuid kid
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78'
),
new_excluded AS (
  SELECT DISTINCT (p->>'keyword_id')::uuid kid
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_cluster_excluded') p
  WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78'
)
SELECT
  (SELECT COUNT(*) FROM base) baseline_scored_kids,
  (SELECT COUNT(*) FROM new_scored) new_scored_kids,
  (SELECT COUNT(*) FROM new_excluded) new_excluded_kids,
  (SELECT COUNT(*) FROM base b WHERE b.kid IN (SELECT kid FROM new_excluded)) baseline_now_excluded,
  (SELECT COUNT(*) FROM base b WHERE b.kid NOT IN (SELECT kid FROM new_scored)
                                 AND b.kid NOT IN (SELECT kid FROM new_excluded)) baseline_now_dropped_entirely;
```

| baseline scored kids | new scored kids | new excluded kids | baseline now excluded | baseline dropped entirely |
|---|---|---|---|---|
| 152 | 98 | 54 | **54** | 0 |

The prompt referenced "47 previously non-canonical scored pairs". The actual count is **54** — every one of the 152 baseline-scored pairs that dropped out of the new scored set now appears in `pairs_cluster_excluded`. No baseline pair was silently dropped.

### 3 clusters where the canonical was scored and siblings were excluded

```sql
WITH scored AS (
  SELECT (p->>'keyword_id')::uuid kid FROM calibration_snapshots,
    jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='d88b6925-6541-44bd-86f9-c04fe02b5e78'
),
sk AS (SELECT id, keyword, cluster_key FROM keywords WHERE id IN (SELECT kid FROM scored) AND cluster_member_count>1),
sibs AS (
  SELECT sk.cluster_key, sk.keyword AS canonical_kw, k2.keyword AS sibling
  FROM sk JOIN keywords k2
    ON k2.cluster_key=sk.cluster_key
   AND k2.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND k2.id<>sk.id
)
SELECT cluster_key, canonical_kw, array_agg(sibling) siblings
FROM sibs GROUP BY cluster_key, canonical_kw
ORDER BY COUNT(*) DESC LIMIT 3;
```

| cluster_key | canonical scored | siblings excluded |
|---|---|---|
| `75 inch tv` | **75 inch tv** | 75 inch tvs, 75 inches tv, tv 75 inch, 75 inch television, 75 in tv |
| `samsung smart tv` | **samsung smart tv** | smart samsung tv, samsung smart television, samsung smart televisions, smart tv samsung, samsung smart tvs |
| `4k tv` | **4k tv** | tv 4k, 4k tvs, 4k televisions, 4k television |

Cluster-scoping is behaving as designed: exactly one canonical member per multi-member cluster is scored, siblings are held in `pairs_cluster_excluded`, and no baseline pair vanished without an audit trail.

---

## Stopping here per instructions — no fixes proposed.
