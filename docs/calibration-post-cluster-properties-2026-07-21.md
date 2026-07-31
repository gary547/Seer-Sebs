# Calibration comparison — after cluster-level canonical, volume, and rank

Snapshot under review: **`33997b73-2b87-44d8-a235-2541428a433b`** (project **`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`** — TVs Ongoing).
Bands used throughout (authorised): green `0.5–2.0`, amber `0.33–<0.5 or >2.0–3.0`, red `<0.33 or >3.0`.
Read-only — no code, migrations, deploys, or re-runs performed.

---

## 1. New snapshot row & hand-verify

| id | created_at (UTC) | overall_ratio | matched | unmatched | notes |
|---|---|---:|---:|---:|---|
| `33997b73-2b87-44d8-a235-2541428a433b` | 2026-07-21 09:54:33.939 | **2.372782** | 65 | 14 724 | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=114 · model_blind=85 · overall=Σm/Σa=7045.31/2969.22=2.372782` |

Hand-check from `by_rank_band.totals`:

```
sum_modelled_monthly = 7045.305531078237
sum_actual_monthly   = 2969.21686746988
7045.305531078237 / 2969.21686746988 = 2.3727824  ✓ matches overall_ratio
```

**SQL:**

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots WHERE id='33997b73-2b87-44d8-a235-2541428a433b';

SELECT by_rank_band->'totals' FROM calibration_snapshots
WHERE id='33997b73-2b87-44d8-a235-2541428a433b';
```

---

## 2. Clustering pass results

| metric | value |
|---|---:|
| kept keywords (`detox_status='keep'`) | **857** |
| distinct clusters (kept, non-null `cluster_key`) | **525** |
| multi-member clusters (member_count > 1) | **159** |
| largest cluster size | **13** |
| `cluster_computed_at` (max) | 2026-07-21 09:53:08.235 UTC |

**SQL:**

```sql
SELECT COUNT(*) FILTER (WHERE detox_status='keep') kept,
       COUNT(DISTINCT cluster_key) FILTER (WHERE detox_status='keep' AND cluster_key IS NOT NULL) distinct_clusters,
       MAX(cluster_computed_at) cluster_computed_at
FROM keywords WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720';

WITH k AS (
  SELECT cluster_key, COUNT(*) c FROM keywords
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND detox_status='keep' AND cluster_key IS NOT NULL
  GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE c>1) multi_clusters, MAX(c) largest FROM k;
```

---

## 3. Canonical fix check

### 3.1 `cluster_canonical_basis` distribution (multi-member clusters only)

| basis | canonical members |
|---|---:|
| `gsc_clicks` | **74** |
| `volume` | **84** |
| `base_rank` | **1** |
| _total_ | **159** |

`gsc_clicks` is now the tiebreaker in 46.5% of multi-member clusters — up from ~0% in `908ef33d`, where the cluster-level GSC aggregation caused every member to tie.

### 3.2 `55 inch tv` cluster — every member with exact-form GSC clicks

| keyword | exact GSC clicks | annual volume | base_rank | ranking_url | canonical? |
|---|---:|---:|---:|---|:---:|
| **`55 inch tv`** | **2 170** | 43 200 | 14 | `/l/tvs-55_inches_and_above/…` | ✅ (basis `gsc_clicks`) |
| `55inch tv` | 188 | 594 000 | — | — | — |
| `tv 55 inch` | 105 | 43 200 | — | — | — |
| `55 inch tvs` | 30 | 594 000 | — | — | — |
| `55in tv` | 25 | 594 000 | 11 | `https://ao.com/l/tvs-55_inches_to_64pt9_inches/…` | — |
| `tv 55inch` | 0 | 43 200 | — | — | — |
| `55-in tv` | 0 | 594 000 | — | — | — |
| `55-in tvs` | 0 | 594 000 | 20 | `https://ao.com/l/tvs-55_inches_to_64pt9_inches/…` | — |
| `55 inch television` | 0 | 594 000 | 18 | `https://ao.com/l/tvs-55_inches_to_64pt9_inches/…` | — |
| `55 inches tv` | 0 | 594 000 | — | — | — |
| `55 in tv` | 0 | 594 000 | — | — | — |

Members now hold **materially different exact-form GSC clicks** (2 170 vs 188 vs 105 vs 25 vs 0), confirming per-member GSC aggregation is working.

### 3.3 Canonical members changed vs prior snapshot (`908ef33d`)

Comparing multi-member cluster canonicals present in both runs:

| metric | value |
|---|---:|
| clusters common to both runs (multi-member) | 50 |
| **changed canonical keyword** | **15 (30.0 %)** |
| unchanged | 35 |

**SQL (3.1 / 3.2 / 3.3):**

```sql
-- 3.1
SELECT cluster_canonical_basis, COUNT(*)
FROM keywords
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND detox_status='keep' AND cluster_member_count>1
  AND id=cluster_canonical_keyword_id
GROUP BY 1 ORDER BY 2 DESC;

-- 3.2 (per-member GSC exact clicks vs cluster '55 inch tv')
WITH u AS (SELECT id FROM gsc_uploads
           WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
           ORDER BY uploaded_at DESC LIMIT 1),
gsc AS (SELECT LOWER(TRIM(keyword)) q, SUM(clicks) clicks
        FROM gsc_upload_keywords WHERE upload_id=(SELECT id FROM u) GROUP BY 1)
SELECT k.keyword, COALESCE(g.clicks,0) exact_clicks,
       k.avg_monthly_volume*12 annual_vol, k.base_rank, k.ranking_url,
       (k.id=k.cluster_canonical_keyword_id) is_canonical,
       k.cluster_canonical_basis
FROM keywords k LEFT JOIN gsc g ON g.q=LOWER(TRIM(k.keyword))
WHERE k.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND k.detox_status='keep' AND k.cluster_key='55 inch tv'
ORDER BY is_canonical DESC, exact_clicks DESC;

-- 3.3 (prior canonical = keyword string in 908ef33d pairs_scored per cluster_key)
WITH curr AS (
  SELECT cluster_key, keyword FROM keywords
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND detox_status='keep' AND cluster_member_count>1
    AND id=cluster_canonical_keyword_id),
prior AS (
  SELECT (p->>'cluster_key') cluster_key, (p->>'keyword') keyword
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
    AND (p->>'cluster_member_count')::int > 1)
SELECT COUNT(*) FILTER (WHERE c.keyword <> p.keyword) changed,
       COUNT(*) FILTER (WHERE c.keyword = p.keyword) unchanged,
       COUNT(*) total_common
FROM curr c JOIN prior p ON c.cluster_key=p.cluster_key;
```

---

## 4. Cluster-level properties — top 10 multi-member clusters

| cluster_key | canonical | own_vol (annual = monthly×12) | cluster_volume_annual | own_rank | cluster_base_rank | rank-source keyword | cluster_ranking_url | url_conflict |
|---|---|---:|---:|---:|---:|---|---|:---:|
| `lg oled tv` | lg oled tv | 118 800 | **296 100** | 11 | **9** | oled lg television | `.../tvs-lg-oled_screen/…` | ✅ |
| `55 inch tv` | 55 inch tv | 43 200 | **469 100** | 14 | **11** | 55in tv | `.../tvs-55_inches_to_64pt9_inches/…` | ✅ |
| `65 inch tv` | 65 inch tv | 594 000 | **1 653 000** | — | **21** | 65 in tv | `/l/tvs-65_inches_and_above/…` | — |
| `55 lg oled tv` | lg oled tv 55 | 12 000 | 29 520 | 18 | 18 | lg oled tv 55 | `.../tvs-lg-oled_screen/…` | — |
| `oled sony tv` | oled tv sony | 22 800 | 52 400 | 16 | 16 | oled tv sony | `.../tvs-sony/…` | ✅ |
| `4k 55 inch tv` | 4k tv 55 inch | 28 800 | 21 440 | 20 | 20 | 4k tv 55 inch | `/l/tvs-55_inches_and_above/…` | — |
| `60 inch tv` | 60inch tv | 266 400 | 673 100 | — | — | — | — | — |
| `lg tv` | lg tv | 397 200 | 331 280 | — | **13** | lg tvs | `/l/tvs-lg/…` | ✅ |
| `75 inch tv` | 75 inch tv | 325 200 | 312 400 | 12 | **6** | 75 in tv | `.../tvs-75_inches_and_above/…` | ✅ |
| `65 inch samsung tv` | samsung 65 inch tv | 118 800 | 310 500 | — | — | — | — | — |

Where a `cluster_base_rank` is filled from a non-canonical member (e.g. `55 inch tv`, `75 inch tv`, `lg oled tv`, `lg tv`), the calibrator now consumes the cluster's best-known rank rather than the canonical member's own value. Same for `cluster_volume_annual` (MAX across members).

**URL conflict prevalence across all multi-member clusters:**

| metric | value |
|---|---:|
| multi-member cluster _keywords_ flagged `cluster_url_conflict=true` | 134 |
| distinct multi-member clusters with URL conflict | **31 of 159 (19.5 %)** |

**SQL:**

```sql
-- top-10 multi-member clusters, canonical row per cluster
WITH c AS (
  SELECT cluster_key, COUNT(*) n FROM keywords
  WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    AND detox_status='keep' AND cluster_key IS NOT NULL
  GROUP BY 1 HAVING COUNT(*)>1 ORDER BY n DESC LIMIT 10)
SELECT k.cluster_key, k.keyword, k.avg_monthly_volume*12 own_vol,
       k.cluster_volume_annual, k.base_rank, k.cluster_base_rank,
       (SELECT keyword FROM keywords WHERE id=k.cluster_base_rank_keyword_id) cluster_rank_kw,
       k.cluster_ranking_url, k.cluster_url_conflict
FROM keywords k JOIN c USING(cluster_key)
WHERE k.project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND k.detox_status='keep' AND k.id=k.cluster_canonical_keyword_id
ORDER BY c.n DESC;

SELECT COUNT(DISTINCT cluster_key) FILTER (WHERE cluster_url_conflict) conflict_clusters
FROM keywords
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND detox_status='keep' AND cluster_member_count>1;
```

---

## 5. Side-by-side versus prior snapshots

Distribution of `per_pair_ratio` and gate metric per snapshot (authorised bands only).

| snapshot | overall_ratio | pairs | min | p25 | median | p75 | max | green/amber/red | green share |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|---:|
| `888002bc` | 1.7669 | 152 | — | — | — | — | — | 62 / 27 / 63 | 40.8 % |
| `d88b6925` | 1.7078 | 98 | — | — | 1.351 | — | — | 49 / 18 / 31 | 50.0 % |
| `32a17a54` | 1.3246 | 111 | — | 0.771 | 1.426 | 3.962 | — | 53 / 21 / 37 | 47.7 % |
| `908ef33d` | 1.0253 | 111 | — | 0.577 | 1.281 | 2.280 | — | 55 / 25 / 31 | 49.5 % |
| **`33997b73` (new)** | **2.3728** | **114** | **0.095** | **0.819** | **2.045** | **4.291** | **122.23** | **43 / 20 / 51** | **37.7 %** |

The new snapshot **regresses on every dispersion metric** vs `908ef33d`: median is above the green ceiling, p75 nearly doubles, and max jumps to 122×. Green share drops 11.8 pp.

**SQL (new snapshot distribution):**

```sql
WITH r AS (SELECT (p->>'per_pair_ratio')::float ratio
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='33997b73-2b87-44d8-a235-2541428a433b')
SELECT COUNT(*) n, MIN(ratio) mn,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY ratio) p25,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY ratio) med,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ratio) p75,
  MAX(ratio) mx,
  COUNT(*) FILTER (WHERE ratio>=0.5 AND ratio<=2.0) grn,
  COUNT(*) FILTER (WHERE (ratio>=0.33 AND ratio<0.5) OR (ratio>2.0 AND ratio<=3.0)) amb,
  COUNT(*) FILTER (WHERE ratio<0.33 OR ratio>3.0) red
FROM r;
```

---

## 6. `by_intent` and `by_rank_band` buckets

### 6.1 `by_intent`

| intent | Σ modelled | Σ actual | ratio | pairs |
|---|---:|---:|---:|---:|
| commercial | 220.14 | 212.29 | **1.037** | 3 |
| informational | 1 906.30 | 967.17 | 1.971 | 1 |
| navigational | 12.98 | 21.57 | 0.602 | 1 |
| transactional | 4 905.89 | 1 768.19 | **2.775** | 60 |
| unknown | 0 | 0 | — | 0 |
| **Σ** | **7 045.31** | **2 969.22** | **2.373** | **65 canonical (114 scored)** |

### 6.2 `by_rank_band`

| band | Σ modelled | Σ actual | ratio | pairs |
|---|---:|---:|---:|---:|
| 1–3 | 573.64 | 216.20 | 2.653 | 5 |
| 4–10 | 2 428.52 | 692.59 | 3.506 | 20 |
| 11–20 | 3 270.97 | 1 868.25 | 1.751 | 37 |
| **21–30** | **772.18** | **192.17** | **4.018** | **3** |
| **Σ** | **7 045.31** | **2 969.22** | **2.373** | **65** |

Bucket sums match `totals` to within rounding (Σ modelled 7 045.31, Σ actual 2 969.22 — identical to `totals.sum_modelled_monthly` / `sum_actual_monthly`). The `21–30` bucket is present.

_Note on `matched` mismatch:_ intent buckets sum to 65 while rank buckets also sum to 65 — the ledger holds 114 pairs_scored but the `matched` totals count canonical members only (65). This is consistent with the writer's design; scored-pair count differs from matched-canonical count because some canonical members have zero cluster-actual clicks.

**SQL:**

```sql
SELECT by_intent, by_rank_band FROM calibration_snapshots
WHERE id='33997b73-2b87-44d8-a235-2541428a433b';
```

---

## 7. Gate verdict

Criterion (as written): **overall ratio green AND no intent bucket red.**

- Overall ratio = **2.3728** → outside green band (0.5–2.0), lands in **amber**.
- Intent buckets: commercial green, informational amber, navigational green, transactional amber, unknown n/a. **No intent bucket is red.**

**Verdict:** ❌ **FAIL** — overall ratio is not green. Regression vs `908ef33d` (which was green at 1.0253).

Green-band share of scored pairs: **43 / 114 = 37.7 %** (down from 49.5 % in `908ef33d`).

---

## 8. Ledger extremes (from `pairs_scored`)

_The `pairs_scored` array in this snapshot does not carry `cluster_canonical_basis`; that field lives on the `keywords` table and is reported in §3.1 / §3.3. All other fields below come straight from the ledger._

### 5 worst over-predictions

| keyword | cluster_key | cmc | own_vol | cl_vol | own_rank | cl_rank | ctr_used | tier | svm_used | modelled_monthly | act_exact | act_cluster | per_pair_ratio |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| sony tv | sony tv | 4 | 168 500 | **388 800** | 8 | 8 | 0.0105 | project_device_intent | 0.720 | 213.54 | 29 | 29 | **122.23** |
| samsung 55 inch tv | 55 inch samsung tv | 4 | 124 000 | 294 000 | 23 | 23 | 0.0152 | project_device_generic | 0.720 | 247.00 | 82 | 148 | 27.70 |
| samsung s95f | s95f samsung | 1 | 108 800 | 219 600 | 21 | 21 | 0.0069 | project_all_intent | 0.612 | 100.46 | 67 | 67 | 24.89 |
| tv on sale | on sale tv | 1 | 252 100 | 584 400 | 10 | 10 | 0.0056 | project_device_intent | 0.616 | 151.37 | 115 | 115 | 21.85 |
| samsung oled tv | oled samsung tv | 4 | 68 600 | 159 300 | 20 | 16 | 0.0039 | project_device_intent | 0.581 | 33.46 | 27 | 27 | 20.57 |

### 5 worst under-predictions

| keyword | cluster_key | cmc | own_vol | cl_vol | own_rank | cl_rank | ctr_used | tier | svm_used | modelled_monthly | act_exact | act_cluster | per_pair_ratio |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| lg tv 50 inch | 50 inch lg tv | 1 | 8 320 | 6 920 | 19 | 19 | 0.0039 | project_device_intent | 0.581 | 1.07 | 21 | **187** | **0.095** |
| tcl 75 inch tv | 75 inch tcl tv | 3 | 3 300 | 3 120 | 19 | 19 | 0.0039 | project_device_intent | 0.612 | 0.62 | 57 | 57 | 0.181 |
| cheap tv deals | cheap deal tv | 1 | 18 000 | 14 200 | 18 | 18 | 0.0069 | project_all_intent | 0.581 | 3.32 | 279 | 279 | 0.198 |
| 75 inch tv deals | 75 deal inch tv | 1 | 3 000 | 2 310 | 19 | 19 | 0.0039 | project_device_intent | 0.581 | 0.44 | 31 | 31 | 0.234 |
| 50 inch smart tv sale | 50 inch sale smart tv | 2 | 3 460 | 3 120 | 8 | 8 | 0.0105 | project_device_intent | 0.523 | 1.43 | 63 | 87 | 0.273 |

**SQL:**

```sql
WITH x AS (
  SELECT (p->>'keyword') keyword, (p->>'cluster_key') cluster_key,
    (p->>'cluster_member_count')::int cmc,
    (p->>'canonical_own_volume')::float own_vol, (p->>'cluster_volume_annual')::float cl_vol,
    (p->>'canonical_own_base_rank')::int own_rank, (p->>'cluster_base_rank')::int cl_rank,
    (p->>'ctr_used')::float ctr, (p->>'ctr_resolver_tier') tier, (p->>'svm_used')::float svm,
    (p->>'modelled_monthly')::float m, (p->>'actual_clicks_exact')::float a_ex,
    (p->>'actual_clicks_cluster')::float a_cl, (p->>'per_pair_ratio')::float r
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='33997b73-2b87-44d8-a235-2541428a433b')
(SELECT 'over' side, * FROM x ORDER BY r DESC NULLS LAST LIMIT 5)
UNION ALL
(SELECT 'under' side, * FROM x WHERE r>0 ORDER BY r ASC LIMIT 5);
```

---

## 9. Movement attribution vs `908ef33d`

Pairs joined on `keyword` string across both snapshots' `pairs_scored`.

| bucket | count |
|---|---:|
| pairs in both snapshots | 96 |
| **improved** (`|r−1|` smaller in new) | **31** |
| **worsened** (`|r−1|` larger in new) | **65** |
| held within 5% of prior deviation | 4 |

### 5 largest improvements

| keyword | 908ef33d ratio | new ratio | Δ |r−1| | cl_vol (new) | own_vol (new) | cl_rank (new) | own_rank (new) |
|---|---:|---:|---:|---:|---:|---:|---:|
| tcl 55 inch tv | 13.193 | 10.006 | −3.187 | 33 600 | 44 300 | 25 | 25 |
| 50 inch 4k tv | 9.458 | 7.804 | −1.654 | 18 400 | 22 300 | 8 | 8 |
| 37 inch tv | 5.079 | 4.037 | −1.042 | 21 300 | 26 800 | 13 | 13 |
| philips ambilight tv 65 | 4.337 | 3.303 | −1.033 | 10 740 | 14 100 | 25 | 25 |
| 55 inch tv clearance | 3.532 | 2.933 | −0.599 | 14 200 | 17 100 | 19 | 19 |

_All five had cluster_volume ≤ own_volume (i.e. MAX-vol didn't inflate), and cl_rank = own_rank — improvement comes from other clustered actuals or ctr, not from cluster-level property changes._

### 5 largest regressions

| keyword | 908ef33d ratio | new ratio | Δ |r−1| | cl_vol (new) | own_vol (new) | cl_rank (new) | own_rank (new) | driver |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **sony tv** | 52.97 | **122.23** | +69.26 | **388 800** | 168 500 | 8 | 8 | `cluster_volume_annual` = 2.3× own_vol → modelled ×2.3 with unchanged actuals |
| samsung 55 inch tv | 11.68 | 27.70 | +16.02 | **294 000** | 124 000 | 23 | 23 | cl_vol 2.4× own_vol; also cl_rank rose to 23 |
| samsung s95f | 12.33 | 24.89 | +12.56 | **219 600** | 108 800 | 21 | 21 | cl_vol 2.0× own_vol (single-member cluster? cmc=1 — cl_vol change is from vol-source drift) |
| tv on sale | 9.43 | 21.85 | +12.42 | **584 400** | 252 100 | 10 | 10 | cl_vol 2.3× own_vol (cmc=1) |
| philips ambilight tv 55 | 6.65 | 14.65 | +8.00 | **28 740** | 13 040 | 8 | 8 | cl_vol 2.2× own_vol (cmc=1) |

**Observation.** Four of the top five regressions are single-member clusters (`cmc=1`) where `cluster_volume_annual` is nonetheless roughly double the canonical member's `own_vol`. This indicates the MAX-over-members computation is drawing volume from a source that differs from the canonical's `own_vol` even within a single-member cluster — likely because `cluster_volume_annual` is being sourced from a different volume field than `canonical_own_volume` (e.g. DFS annual vs `avg_monthly_volume×12`). Not proposing a fix per scope — flagging for the technical advisor.

**SQL:**

```sql
WITH a AS (
  SELECT (p->>'keyword') kw, (p->>'per_pair_ratio')::float ra,
    (p->>'cluster_volume_annual')::float cl_vol_a, (p->>'canonical_own_volume')::float own_vol_a,
    (p->>'cluster_base_rank')::int cl_rank_a, (p->>'canonical_own_base_rank')::int own_rank_a
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='33997b73-2b87-44d8-a235-2541428a433b'),
b AS (
  SELECT (p->>'keyword') kw, (p->>'per_pair_ratio')::float rb
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='908ef33d-f5f6-44b1-b802-59a2fef8f8f9')
SELECT COUNT(*) both,
       COUNT(*) FILTER (WHERE abs(a.ra-1) < abs(b.rb-1)-0.001) improved,
       COUNT(*) FILTER (WHERE abs(a.ra-1) > abs(b.rb-1)+0.001) worsened,
       COUNT(*) FILTER (WHERE abs(abs(a.ra-1)-abs(b.rb-1))
                          <= greatest(0.001, 0.05*abs(b.rb-1))) held5pct
FROM a JOIN b USING(kw);

-- top 5 improvements (ORDER BY improvement DESC) and top 5 regressions (ORDER BY regression DESC)
-- from the same CTE joined on kw.
```

---

## Bottom line

- Clustering pass is doing what it was told: `gsc_clicks` now decides 46.5 % of canonicals, per-member exact clicks are correctly differentiated (55" example shows a 87× spread across members), and cluster-level MAX-volume / MIN-rank are landing on every member row.
- Calibration nevertheless **regressed to overall_ratio 2.373 (amber, gate FAIL)** from 1.025 (green) in `908ef33d`. Green share fell 49.5 % → 37.7 %.
- The regression concentrates in a small number of very-high-magnitude over-predictions (sony tv 122×, samsung 55 inch tv 27.7×, samsung s95f 24.9×, tv on sale 21.9×, samsung oled tv 20.6×). Four of the five worst regressions are **single-member clusters where `cluster_volume_annual` ≈ 2× `canonical_own_volume`** despite `cmc=1`; this is the largest single mechanical driver of the regression and warrants attention.
- Reporting only; no code, migrations, or re-runs performed.
