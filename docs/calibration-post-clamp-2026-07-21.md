# Calibration comparison — after CTR monotonicity clamp

Project: `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing).
Read-only. No code, migrations, deploys, gate criteria, bands, or thresholds changed.
Authorised bands: **Green 0.5–2.0 · Amber 0.33–<0.5 or >2.0–3.0 · Red <0.33 or >3.0.**

Resolver clamp redeployed 2026-07-21 10:41:27 UTC. This report compares the first calibration snapshot taken after that redeploy.

---

## 1) New snapshot row

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots
WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7';
```

| field | value |
|---|---|
| id | `a46a976d-e280-449c-b8fb-2f586ad0c7f7` |
| created_at | 2026-07-21 10:48:31.802517+00 |
| overall_ratio | **0.939084** |
| keywords_matched | 65 |
| keywords_unmatched | 14,724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=114 · model_blind=85 · overall=Σm/Σa=2788.34/2969.22=0.939084` |

Hand-verification from the totals block (`by_rank_band → totals`):

```sql
SELECT (by_rank_band->'totals'->>'sum_modelled_monthly')::numeric AS sum_m,
       (by_rank_band->'totals'->>'sum_actual_monthly')::numeric   AS sum_a,
       ROUND(((by_rank_band->'totals'->>'sum_modelled_monthly')::numeric
            / (by_rank_band->'totals'->>'sum_actual_monthly')::numeric)::numeric, 6) AS hand_ratio
FROM calibration_snapshots WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7';
```

sum_modelled_monthly = **2,788.3444** · sum_actual_monthly = **2,969.2169** · ratio = 2788.3444 / 2969.2169 = **0.939084** — matches `overall_ratio` exactly.

---

## 2) Clamp presence on ledger rows — NOT CONFIRMED

```sql
WITH pairs AS (
  SELECT jsonb_array_elements(by_rank_band->'pairs_scored') AS p
  FROM calibration_snapshots WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7'
)
SELECT COUNT(*)                                           AS n_pairs,
       COUNT(*) FILTER (WHERE (p->>'clamped') IS NOT NULL)     AS with_clamped_field,
       COUNT(*) FILTER (WHERE (p->>'preClampCtr') IS NOT NULL) AS with_preClampCtr
FROM pairs;
```

| n_pairs | with_clamped_field | with_preClampCtr |
|---|---|---|
| 114 | **0** | **0** |

The `clamped` and `preClampCtr` fields the resolver now returns are **not being persisted into the ledger** by `calibration-compute`. The pair writer at `supabase/functions/calibration-compute/index.ts` lines 513–551 records `ctr_used` and `ctr_resolver_tier` but never reads `res.clamped` / `res.preClampCtr`. Therefore the ledger cannot answer "does ctr_used differ from preClampCtr on clamped rows" directly.

Indirect evidence the clamp is nevertheless active in the resolver at scoring time: the very high rank-21+ overshoots present in `2cc40f0a` (e.g. `samsung tv` rank-29 ratio **18.11**) have collapsed in this snapshot to **4.65** without any curve/data change between the two runs — a change consistent only with a per-context ladder clamp reducing the CTR at rank 29. See §7 movement table.

**Reporting gap flagged, no fix proposed.**

---

## 3) Side-by-side vs prior snapshots

```sql
WITH pairs AS (
  SELECT id AS snap_id, jsonb_array_elements(by_rank_band->'pairs_scored') AS p
  FROM calibration_snapshots
  WHERE id IN ('a46a976d-e280-449c-b8fb-2f586ad0c7f7',
               '2cc40f0a-ede1-4bf0-959d-f89dae671cea',
               '908ef33d-f5f6-44b1-b802-59a2fef8f8f9')
), s AS (
  SELECT snap_id, (p->>'per_pair_ratio')::numeric AS r FROM pairs
)
SELECT snap_id,
  COUNT(*) AS scored_pairs,
  ROUND(MIN(r),4) AS min,
  ROUND((percentile_cont(0.25) WITHIN GROUP (ORDER BY r))::numeric,4) AS p25,
  ROUND((percentile_cont(0.5)  WITHIN GROUP (ORDER BY r))::numeric,4) AS median,
  ROUND((percentile_cont(0.75) WITHIN GROUP (ORDER BY r))::numeric,4) AS p75,
  ROUND(MAX(r),4) AS max,
  COUNT(*) FILTER (WHERE r >= 0.5 AND r <= 2.0)                                     AS green,
  COUNT(*) FILTER (WHERE (r >= 0.33 AND r < 0.5) OR (r > 2.0 AND r <= 3.0))         AS amber,
  COUNT(*) FILTER (WHERE r < 0.33 OR r > 3.0)                                        AS red
FROM s GROUP BY snap_id;
```

| snapshot | overall_ratio | pairs | min | p25 | median | p75 | max | G | A | R | green% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `908ef33d` (baseline, cluster-props reverted, pre-clamp) | 1.0253 | 111 | 0.1147 | 0.5773 | 1.2805 | 2.2797 | 52.9746 | 55 | 25 | 31 | 49.5% |
| `2cc40f0a` (canonical-own revert, pre-clamp)             | 1.1144 | 114 | 0.0440 | 0.5772 | 1.2345 | 2.3912 | 52.9746 | 56 | 23 | 35 | 49.1% |
| `a46a976d` (**post-clamp, this snapshot**)               | **0.9391** | 114 | 0.0440 | 0.5670 | **1.1615** | **2.2467** | 52.9746 | **58** | 24 | **32** | **50.9%** |

Overall ratio moved from 1.1144 → 0.9391 (closer to 1.0). Median per-pair ratio tightened 1.2345 → 1.1615. p75 fell 2.3912 → 2.2467. Green count rose 56 → 58; red fell 35 → 32; green share rose 49.1% → **50.9%**. Min and max are unchanged.

---

## 4) by_intent and by_rank_band buckets (post-clamp snapshot)

```sql
SELECT jsonb_pretty(by_intent), jsonb_pretty(by_rank_band - 'pairs_scored')
FROM calibration_snapshots WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7';
```

### by_intent

| intent | Σ modelled | Σ actual | ratio | pairs | band |
|---|---:|---:|---:|---:|---|
| commercial     |   98.7813 |  212.2892 | **0.4653** |  3 | **Amber** (0.33–<0.5) |
| navigational   |   16.7293 |   21.5663 | 0.7757 |  1 | Green |
| informational  |  791.2566 |  967.1687 | 0.8181 |  1 | Green |
| transactional  | 1881.5771 | 1768.1928 | 1.0641 | 60 | Green |
| unknown        |     0     |     0     |  n/a   |  0 | — |

### by_rank_band

| band | Σ modelled | Σ actual | ratio | pairs | band |
|---|---:|---:|---:|---:|---|
| 1–3        |  202.0242 |  216.2048 | 0.9344 |  5 | Green |
| 4–10       |  812.0048 |  479.3373 | 1.6940 | 14 | Green |
| 11–20      | 1500.6675 | 2058.2530 | 0.7291 | 42 | Green |
| 21–30      |  273.6479 |  215.4217 | 1.2703 |  4 | Green |
| **totals** | **2788.3444** | **2969.2169** | **0.9391** | **65** | — |

Reconciliation: Σ per rank band = 202.0242 + 812.0048 + 1500.6675 + 273.6479 = **2,788.3444** modelled and 216.2048 + 479.3373 + 2058.2530 + 215.4217 = **2,969.2168** actual — matches totals to rounding.

Note: `by_intent.matched` (3+1+1+60 = 65) reconciles to `by_rank_band.totals.matched` = 65. The 21–30 bucket is present with 4 pairs (was 4 in `2cc40f0a` at ratio 3.5794 red — now down to 1.2703 green, the clearest ledger-level sign of the clamp).

---

## 5) Gate verdict

Criterion as written: **overall ratio Green AND no intent bucket Red.**

- Overall ratio 0.9391 → within 0.5–2.0 → **Green**.
- Intent bucket bands: commercial **Amber**, navigational Green, informational Green, transactional Green, unknown n/a.
- No intent bucket is Red.

**Verdict: PASS.**

Green-band share of scored pairs (stated separately): **58 / 114 = 50.9%**.

---

## 6) Ledger extremes

```sql
WITH new_pairs AS (
  SELECT p FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7'
)
SELECT p->>'keyword', p->>'cluster_key',
       (p->>'cluster_member_count')::int,
       (p->>'annual_volume')::numeric AS canonical_own_volume,
       (p->>'base_rank')::int          AS canonical_own_base_rank,
       p->>'ctr_used', p->>'preClampCtr', p->>'clamped',
       p->>'ctr_resolver_tier', (p->>'svm_used')::numeric,
       ROUND((p->>'modelled_monthly')::numeric,3),
       (p->>'actual_clicks_exact')::numeric,
       (p->>'actual_clicks_cluster')::numeric,
       ROUND((p->>'per_pair_ratio')::numeric,4)
FROM new_pairs
ORDER BY (p->>'per_pair_ratio')::numeric DESC LIMIT 5;
-- (identical query with ORDER BY ... ASC LIMIT 5 for under-predictions)
```

### 5 worst OVER-predictions (per_pair_ratio DESC)

| keyword | cluster_key | mem | own_vol | own_rank | ctr_used | preClamp | clamped | tier | svm | modelled | acts_exact | acts_cluster | ratio |
|---|---|---:|---:|---:|---:|:-:|:-:|---|---:|---:|---:|---:|---:|
| sony tv               | sony tv         | 4 | 168,500 |  8 | 0.0105  | — | — | project_device_intent | 0.720 | 92.546 |  29 |  29 | 52.9746 |
| 50 inch 4k tv         | 4k 50 inch tv   | 1 |  22,300 |  8 | 0.0105  | — | — | project_device_intent | 0.720 | 11.395 |  20 |  20 |  9.4580 |
| tv on sale            | on sale tv      | 1 | 252,100 | 10 | 0.0056  | — | — | project_device_intent | 0.616 | 65.297 | 115 | 115 |  9.4255 |
| samsung oled tv       | oled samsung tv | 4 |  68,600 | 20 | 0.0039  | — | — | project_device_intent | 0.581 | 14.410 |  27 |  27 |  8.8596 |
| tcl 55 inch tv        | 55 inch tcl tv  | 1 |  44,300 | 25 | 0.0039  | — | — | project_all_intent    | 0.648 | 12.128 |  27 |  27 |  7.4568 |

### 5 worst UNDER-predictions (per_pair_ratio ASC)

| keyword | cluster_key | mem | own_vol | own_rank | ctr_used | preClamp | clamped | tier | svm | modelled | acts_exact | acts_cluster | ratio |
|---|---|---:|---:|---:|---:|:-:|:-:|---|---:|---:|---:|---:|---:|
| 55 inch tv       | 55 inch tv       | 11 | 28,820 | 14 | 0.0039 | — | — | project_device_intent | 0.684 | 6.676 | 2170 | 2518 | 0.0440 |
| lg tv 50 inch    | 50 inch lg tv    |  1 |  8,320 | 19 | 0.0039 | — | — | project_device_intent | 0.581 | 1.292 |   21 |  187 | 0.1147 |
| cheap tv deals   | cheap deal tv    |  1 | 18,000 | 18 | 0.0039 | — | — | project_all_intent    | 0.581 | 2.381 |  279 |  279 | 0.1417 |
| buy tv           | buy tv           |  3 | 40,500 | 20 | 0.0039 | — | — | project_device_intent | 0.452 | 4.977 |  524 |  581 | 0.1422 |
| tcl 75 inch tv   | 75 inch tcl tv   |  3 |  3,300 | 19 | 0.0039 | — | — | project_device_intent | 0.612 | 0.656 |   57 |   57 | 0.1912 |

`preClampCtr` and `clamped` are empty because those fields are not persisted (§2).

---

## 7) Movement attribution (2cc40f0a → a46a976d)

Match key: `keyword + ctr_curve_key`.

```sql
WITH old_pairs AS (
  SELECT p->>'keyword' k, p->>'ctr_curve_key' key, (p->>'per_pair_ratio')::numeric r_old
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea'
),
new_pairs AS (
  SELECT p->>'keyword' k, p->>'ctr_curve_key' key, (p->>'per_pair_ratio')::numeric r_new,
         COALESCE((p->>'clamped')::boolean,false) clamped_new
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7'
),
j AS (
  SELECT o.k, o.key, r_old, r_new, clamped_new,
         (ABS(r_new-1) - ABS(r_old-1)) AS delta_to_1
  FROM old_pairs o JOIN new_pairs n USING (k, key)
)
SELECT COUNT(*) matched,
  COUNT(*) FILTER (WHERE delta_to_1 < 0 AND ABS(delta_to_1) > 0.05*ABS(r_old-1)) improved,
  COUNT(*) FILTER (WHERE delta_to_1 > 0 AND ABS(delta_to_1) > 0.05*ABS(r_old-1)) worsened,
  COUNT(*) FILTER (WHERE ABS(delta_to_1) <= 0.05*ABS(r_old-1)) held_within_5pct
FROM j;
```

| matched | improved | worsened | held within 5% |
|---:|---:|---:|---:|
| 114 | **9** | **3** | **102** |

### 5 largest IMPROVEMENTS (movement toward 1.0)

| keyword | ctr_curve_key | ratio_before | ratio_after | clamped |
|---|---|---:|---:|:-:|
| samsung tv           | mobile\|transactional\|29 | 18.1180 |  4.6487 | (field absent) |
| samsung 55 inch tv   | mobile\|transactional\|23 | 11.6847 |  2.9980 | (field absent) |
| tcl 55 inch tv       | mobile\|transactional\|25 | 13.1927 |  7.4568 | (field absent) |
| samsung s95f         | mobile\|transactional\|21 | 12.3318 |  6.9701 | (field absent) |
| philips ambilight tv 65 | mobile\|transactional\|25 | 4.3366 | 2.4511 | (field absent) |

Every one of the 9 improvers sits at rank ≥ 21 mobile/transactional — the exact contexts where §Additional-A (below) shows the resolver ladder capping rank-21+ CTR at the rank-20 value. Consistent with the clamp being active in scoring despite the ledger field being absent.

### 5 largest REGRESSIONS (movement away from 1.0)

| keyword | ctr_curve_key | ratio_before | ratio_after | clamped |
|---|---|---:|---:|:-:|
| 48 inch tv         | mobile\|transactional\|24 | 0.9747 | 0.5509 | (field absent) |
| 4k tv deals        | mobile\|transactional\|18 | 1.0894 | 0.6157 | (field absent) |
| cheap tv deals     | mobile\|transactional\|18 | 0.2506 | 0.1417 | (field absent) |
| tv deals uk        | mobile\|commercial\|20    | 0.2310 | 0.1998 | (field absent) |
| samsung 75 inch tv | mobile\|transactional\|13 | 3.6019 | 3.6019 | (field absent) |

Rank 24 `48 inch tv` also matches the clamp pattern (rank-24 CTR pulled down by rank ≤ 20 tier), which lowered its modelled clicks. The 5th row is unchanged (delta 0) — reported for completeness of the top-5.

---

## A) Clamp impact (indirect)

```sql
SELECT COUNT(*) FILTER (WHERE (p->>'clamped')::boolean IS TRUE) AS clamped_pairs
FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
WHERE id='a46a976d-e280-449c-b8fb-2f586ad0c7f7';
```

Ledger-reported clamped pairs: **0** — because the calibration ledger does not persist the resolver's `clamped` / `preClampCtr` fields (§2). Aggregate `preClampCtr − ctr_used` therefore cannot be computed from stored data.

Indirect estimate from the resolver-side diagnostic in `docs/ctr-monotonicity-clamp-2026-07-21.md`: 137/450 resolved (device, intent, rank) slots in this project were lowered by the clamp, with mobile navigational and rank-21+ mobile transactional the most-affected contexts. The 9 improved pairs in §7 are the ledger-visible reflection of those slot-level clamps.

The "10 largest clamp reductions" table cannot be produced from the ledger as stored. It is available only inside the resolver at scoring time and is not written into `calibration_snapshots.by_rank_band.pairs_scored`.

---

## B) Tail symmetry

```sql
WITH s AS (
  SELECT id snap, (p->>'per_pair_ratio')::numeric r
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id IN ('a46a976d-e280-449c-b8fb-2f586ad0c7f7','2cc40f0a-ede1-4bf0-959d-f89dae671cea')
)
SELECT snap,
  COUNT(*) FILTER (WHERE r > 2.0) AS above_2,
  COUNT(*) FILTER (WHERE r < 0.5) AS below_05,
  ROUND(MAX(r),4) AS max, ROUND(MIN(r),4) AS min
FROM s GROUP BY snap;
```

| snapshot | pairs > 2.0 | pairs < 0.5 | worst over | worst under |
|---|---:|---:|---:|---:|
| `2cc40f0a` (pre-clamp) | 37 | 21 | 52.9746 | 0.0440 |
| `a46a976d` (post-clamp) | **35** | 21 | 52.9746 | 0.0440 |

The over-prediction tail shortened by 2 pairs (37 → 35). The under-prediction tail is unchanged in count and in min. Worst-over is unchanged: the single extreme `sony tv` outlier at rank 8 lies below rank-21 and is not touched by the clamp (which only lowers CTR when a higher rank's CTR exceeds a lower rank's, and rank 8 is at the top of the ladder in `project_device_intent`).

Conclusion: the clamp **shortened the over-prediction tail** (top-end distribution pulled inward, red count 35 → 32) and left the **under-prediction tail unchanged**. Total red pairs fell by 3 (all from the over-prediction side), consistent with a monotone-decreasing enforcement that can only lower CTRs.

---

## Summary

- Overall ratio 0.9391 (Green). No intent bucket Red. **Gate: PASS.**
- Green share 50.9% (up from 49.1% in `2cc40f0a`).
- 21–30 rank band ratio fell 3.5794 (Red) → 1.2703 (Green).
- Movement: 9 improvers, 3 regressions, 102 within 5%. All improvers at rank ≥ 21 mobile/transactional — the clamp's target contexts.
- **Reporting gap:** the resolver returns `clamped` and `preClampCtr` but `calibration-compute` does not persist them into the ledger, so items 2 and A cannot be verified from stored data. Flagged for the operator; no fix proposed here.
