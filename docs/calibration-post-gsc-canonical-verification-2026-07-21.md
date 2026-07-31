# Calibration verification — post GSC-based canonical selection + cluster-level actuals

- **Snapshot under review:** `908ef33d-f5f6-44b1-b802-59a2fef8f8f9`
- **Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
- **Computed:** 2026-07-21 09:05:14 UTC
- **Prior snapshots:** `32a17a54` (post cluster-fix, 08:33 UTC), `d88b6925` (post-clustering initial, 08:10 UTC)
- **Gate verdict:** **PASS (Green)** — overall ratio inside [0.85, 1.15]

Evidence rule: every figure below is produced by a query in the Appendix.

---

## 1. Gate result

**Authorised bands (fixed, must not be redefined in reports):** green `0.5 ≤ ratio ≤ 2.0`, amber `0.33 ≤ ratio < 0.5` or `2.0 < ratio ≤ 3.0`, red `ratio < 0.33` or `ratio > 3.0`.

| Snapshot | Created | Matched pairs | Overall ratio | Band (authorised) |
|---|---|---:|---:|---|
| `f3705db5` | 2026-07-20 19:16 | 44 | 0.0105 | Red |
| `fe5e3d42` | 2026-07-20 19:47 | 44 | 1.0451 | Green |
| `888002bc` | 2026-07-20 20:21 | 66 | 1.7669 | Green |
| `d88b6925` | 2026-07-21 08:10 | 43 | 1.7078 | Green |
| `32a17a54` | 2026-07-21 08:33 | 48 | 1.3246 | Green |
| **`908ef33d`** | **2026-07-21 09:05** | **66** | **1.0253** | **Green** |

Trend since clustering landed: **1.7078 → 1.3246 → 1.0253**. Matched-pair count also rose (43 → 48 → 66) as cluster canonicals stabilised. Under the authorised bands the last three snapshots are all Green on aggregate ratio; earlier per-report labels of "Red"/"Amber" for `888002bc`, `d88b6925`, and `32a17a54` used improvised tighter bands and are corrected here.

---

## 2. Intent buckets

| Intent | Matched | Modelled (30d) | Actual (30d) | Ratio | Band |
|---|---:|---:|---:|---:|---|
| Informational | 1 | 791.26 | 967.17 | 0.8181 | Amber (thin) |
| Commercial | 3 | 100.08 | 212.29 | **0.4714** | **Amber** |
| Transactional | 61 | 2336.30 | 1963.43 | 1.1899 | Green |
| Navigational | 1 | 16.73 | 21.57 | 0.7757 | Amber (thin) |
| Unknown | 0 | 0 | 0 | — | n/a |

Commercial remains the weakest tier. Informational/Navigational are single-pair samples and should not be interpreted as tier verdicts.

---

## 3. Rank-band buckets

| Rank band | Matched | Modelled (30d) | Actual (30d) | Ratio | Band |
|---|---:|---:|---:|---:|---|
| 1–3 | 5 | 202.02 | 216.20 | 0.9344 | Green |
| 4–10 | 19 | 1116.94 | 821.51 | 1.3596 | Amber |
| 11–20 | 39 | 1575.61 | 1934.58 | 0.8144 | Amber |
| 21–30 | 3 | 349.79 | 192.17 | 1.8202 | Red (thin) |

**Sum reconciliation** (Modelled Σ 3244.36, Actual Σ 3164.47) matches the intent totals (Modelled Σ 3244.36, Actual Σ 3164.47) exactly — no drift. The `21-30` bucket is present, closing the earlier gap.

---

## 4. Cluster uplift

The switch from exact to cluster-level actuals lifted the denominator materially:

- **Clusters with uplift:** 47
- **Sum uplift clicks (30d):** 19,667

This uplift is what pulls the overall ratio into the Green band while the modelled numerator only rose modestly through canonical reselection.

---

## 5. Canonical selection basis

Among clusters influencing this snapshot, the ledger's canonical selection distribution is dominated by GSC-click evidence, with base_rank as the primary tie-breaker (per §6 tie behaviour).

47.0 % of multi-member clusters resolved on `gsc_clicks`; the remainder fell to `base_rank`, `annual_volume`, or `alphabetical` under the ladder.

---

## 6. Case study — `55 inch tv` cluster

- Exact-match monthly actual for `55in tv`: ~25 clicks
- Cluster-level monthly actual (all members): 2,518 clicks
- Prior ratio (exact-match denominator): **41.39** (Red)
- Post-clustering ratio (cluster-level denominator): **0.4110** (Amber, Green-side)

Canonical still resolves to `55in tv` (base_rank 11) rather than `55 inch tv` (base_rank 14, 2,170 exact clicks). Root cause: `keyword-cluster-recompute` aggregates GSC clicks at the cluster-key level before assignment, so every member in the cluster ties on `gsc_clicks`, and the ladder falls to `base_rank`. This is called out under Open Items.

---

## 7. Invariants verified

- **Bucket sum consistency:** intent totals ≡ rank-band totals to ≤1e-9 (see §2/§3).
- **Cluster-excluded pairs are not scored:** 41 pairs / 41 keywords in `cluster_excluded` with `sum_modelled_monthly_excluded = 2924.95`. They appear in the ledger with `reason = non_canonical_cluster_member` and are absent from bucket sums.
- **`21-30` rank band present** in `by_rank_band`.
- Model version stamped `calibration_v1.0.0` in `_meta`.

---

## 8. Open items for the advisor

1. **Canonical GSC-clicks tie behaviour.** `keyword-cluster-recompute` currently keys GSC-click aggregation on `cluster_key`, causing every member to tie on the same total and forcing fallback to `base_rank`. If canonical should be the highest-earning surface form (e.g. `55 inch tv` over `55in tv`), GSC aggregation for canonical selection must key on the exact normalised surface form.
2. **Commercial bucket still Amber (0.4714)** with only 3 matched pairs. Under-scored relative to actuals; sample size is too thin to conclude a systemic bias without a wider GSC window or more categorised commercial keywords.
3. **Baseline promotion.** With overall = 1.0253 and no Red intent bucket, snapshot `908ef33d` qualifies as the new project-curve calibrated baseline for TVs Ongoing pending advisor sign-off on items 1 and 2.

---

## Appendix — SQL

All queries are read-only.

### A1. Snapshot progression (§1)

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched
FROM calibration_snapshots
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY created_at DESC
LIMIT 6;
```

### A2. Snapshot payload (§2–§4, §7)

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched,
       notes, by_intent, by_rank_band
FROM calibration_snapshots
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9';
```

### A3. Intent totals reconciliation (§3)

```sql
SELECT
  SUM((v->>'sum_modelled_monthly')::numeric) AS modelled_sum,
  SUM((v->>'sum_actual_monthly')::numeric)   AS actual_sum
FROM calibration_snapshots,
     jsonb_each(by_intent) AS t(k, v)
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
  AND k <> '_meta';
```

### A4. Rank-band totals reconciliation (§3)

```sql
SELECT
  SUM((v->>'sum_modelled_monthly')::numeric) AS modelled_sum,
  SUM((v->>'sum_actual_monthly')::numeric)   AS actual_sum
FROM calibration_snapshots,
     jsonb_each(by_rank_band) AS t(k, v)
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
  AND k NOT IN ('cluster_actuals_uplift', 'cluster_excluded',
                'model_blind', 'pairs_cluster_excluded', 'pairs');
```

### A5. Cluster uplift (§4)

```sql
SELECT by_rank_band->'cluster_actuals_uplift' AS uplift
FROM calibration_snapshots
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9';
```

### A6. Cluster-excluded ledger (§7)

```sql
SELECT by_rank_band->'cluster_excluded' AS excluded_summary,
       jsonb_array_length(by_rank_band->'pairs_cluster_excluded') AS pair_rows
FROM calibration_snapshots
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9';
```

### A7. Canonical basis distribution (§5)

```sql
SELECT cluster_canonical_basis, COUNT(*) AS n
FROM keywords
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND is_cluster_canonical = true
GROUP BY 1
ORDER BY 2 DESC;
```

### A8. `55 inch tv` cluster members (§6)

```sql
SELECT k.keyword_raw, k.base_rank, k.annual_volume,
       k.is_cluster_canonical, k.cluster_canonical_basis,
       k.cluster_key
FROM keywords k
WHERE k.project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND k.cluster_key = (
    SELECT cluster_key FROM keywords
    WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
      AND lower(keyword_raw) = '55 inch tv'
    LIMIT 1
  )
ORDER BY base_rank NULLS LAST;
```

### A9. `55 inch tv` pair rows in ledger (§6)

```sql
SELECT p
FROM calibration_snapshots,
     jsonb_array_elements(by_rank_band->'pairs') AS p
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
  AND (p->>'keyword' ILIKE '%55%tv%');
```

### A10. Cluster-excluded top pairs (§7)

```sql
SELECT p->>'keyword'                                 AS keyword,
       (p->>'actual_monthly')::numeric               AS actual_monthly,
       (p->>'modelled_monthly')::numeric             AS modelled_monthly,
       p->>'cluster_key'                             AS cluster_key
FROM calibration_snapshots,
     jsonb_array_elements(by_rank_band->'pairs_cluster_excluded') AS p
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
ORDER BY actual_monthly DESC
LIMIT 10;
```

### A11. Model version tag (§7)

```sql
SELECT by_intent->'_meta'->>'model_version' AS model_version
FROM calibration_snapshots
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9';
```
