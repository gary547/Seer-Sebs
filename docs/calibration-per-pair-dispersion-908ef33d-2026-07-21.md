# Per-pair dispersion — snapshot `908ef33d`

- **Snapshot:** `908ef33d-f5f6-44b1-b802-59a2fef8f8f9`
- **Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
- **Scope:** read-only per-pair distribution across `by_rank_band->'pairs_scored'`
- **Authorised bands (fixed):** green `0.5 ≤ ratio ≤ 2.0`, amber `0.33 ≤ ratio < 0.5` or `2.0 < ratio ≤ 3.0`, red `ratio < 0.33` or `ratio > 3.0`

Evidence rule: every figure below is produced by a query in §4.

---

## §1 Distribution — `908ef33d`

| Metric | Value |
|---|---:|
| n (scored pairs) | 111 |
| min | 0.1147 |
| p25 | 0.5773 |
| median | 1.2805 |
| p75 | 2.2797 |
| max | 52.9746 |

| Band | Count | Share |
|---|---:|---:|
| Green (0.5–2.0) | 55 | **49.55 %** |
| Amber (0.33–<0.5 or >2.0–3.0) | 25 | 22.52 % |
| Red (<0.33 or >3.0) | 31 | 27.93 % |

---

## §2 Side-by-side vs prior snapshots (authorised bands)

| Snapshot | Created | n | median | p25 | p75 | Green | Amber | Red | Green share |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `d88b6925` | 2026-07-21 08:10 | 98 | 1.351 | — | — | 49 | 18 | 31 | 50.00 % |
| `32a17a54` | 2026-07-21 08:33 | 111 | 1.426 | 0.771 | 3.962 | 53 | 21 | 37 | 47.75 % |
| **`908ef33d`** | **2026-07-21 09:05** | **111** | **1.281** | **0.577** | **2.280** | **55** | **25** | **31** | **49.55 %** |

Movement `32a17a54 → 908ef33d`: median tightens (1.426 → 1.281), p75 drops (3.962 → 2.280), red count −6, amber +4, green +2. Centre-of-mass shifts toward parity; tail thickness (p75) improves materially.

Prior snapshot summaries for `d88b6925` and `32a17a54` are the values given in the task prompt; the `908ef33d` row is produced by the SQL in §4.

---

## §3 Worst over- and under-predictions

### Over-predictions (top 5, highest `per_pair_ratio`)

| keyword | cluster_key | members | base_rank | ctr_used | resolver_tier | svm_used | volume_forward | modelled_monthly | act_exact | act_cluster | ratio |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
| sony tv | sony tv | 4 | 8 | 0.01050 | project_device_intent | 0.7200 | 146 898.30 | 92.5459 | 29 | 29 | **52.9746** |
| tcl 55 inch tv | 55 inch tcl tv | 1 | 25 | 0.00690 | project_all_intent | 0.6480 | 57 590.00 | 21.4580 | 27 | 27 | 13.1927 |
| samsung s95f | s95f samsung | 1 | 21 | 0.00690 | project_all_intent | 0.6120 | 141 440.00 | 49.7727 | 67 | 67 | 12.3318 |
| samsung 55 inch tv | 55 inch samsung tv | 4 | 23 | 0.01520 | project_device_generic | 0.7200 | 114 228.80 | 104.1767 | 82 | 148 | 11.6847 |
| 50 inch 4k tv | 4k 50 inch tv | 1 | 8 | 0.01050 | project_device_intent | 0.7200 | 18 087.53 | 11.3951 | 20 | 20 | 9.4580 |

### Under-predictions (top 5, lowest `per_pair_ratio`)

| keyword | cluster_key | members | base_rank | ctr_used | resolver_tier | svm_used | volume_forward | modelled_monthly | act_exact | act_cluster | ratio |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
| lg tv 50 inch | 50 inch lg tv | 1 | 19 | 0.00390 | project_device_intent | 0.5814 | 6 839.04 | 1.2923 | 21 | 187 | **0.1147** |
| tcl 75 inch tv | 75 inch tcl tv | 3 | 19 | 0.00390 | project_device_intent | 0.6120 | 3 300.00 | 0.6564 | 57 | 57 | 0.1912 |
| tv deals uk | deals tv uk | 1 | 20 | 0.00890 | project_all_intent | 0.6120 | 21 182.94 | 9.6149 | 666 | 691 | 0.2310 |
| cheap tvs for sale | cheap for sale tvs | 1 | 16 | 0.00390 | project_device_intent | 0.3663 | 40 181.64 | 4.7833 | 319 | 319 | 0.2489 |
| cheap tv deals | cheap deal tv | 1 | 18 | 0.00690 | project_all_intent | 0.5814 | 12 600.00 | 4.2122 | 279 | 279 | 0.2506 |

Signals visible in the two lists:

- Over-prediction top 5 concentrates on high `volume_forward_used` head terms with head-band CTR (r8) or `project_all_intent`/`project_device_generic` tiers whose CTR is materially higher than measured intent curves would give at that rank.
- Under-prediction top 5 concentrates on ranks 16–20 where the resolved CTR sits at the project's tail floor (0.39 %) while actuals — especially cluster-level — remain large; `lg tv 50 inch` shows a 9× exact→cluster uplift (21 → 187) that the modelled side is not compensating for.

---

## §4 SQL appendix

### Q1. Distribution and band counts (§1)

```sql
WITH p AS (
  SELECT jsonb_array_elements(by_rank_band->'pairs_scored') AS r
  FROM calibration_snapshots
  WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
), v AS (
  SELECT (r->>'per_pair_ratio')::numeric AS ratio FROM p
)
SELECT count(*) AS n,
       min(ratio) AS mn,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY ratio) AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY ratio) AS med,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY ratio) AS p75,
       max(ratio) AS mx,
       count(*) FILTER (WHERE ratio >= 0.5 AND ratio <= 2.0) AS green,
       count(*) FILTER (WHERE (ratio >= 0.33 AND ratio < 0.5)
                            OR (ratio > 2.0 AND ratio <= 3.0)) AS amber,
       count(*) FILTER (WHERE ratio < 0.33 OR ratio > 3.0)     AS red
FROM v;
```

### Q2. Worst over-predictions (§3)

```sql
WITH p AS (
  SELECT jsonb_array_elements(by_rank_band->'pairs_scored') AS r
  FROM calibration_snapshots
  WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9'
)
SELECT r->>'keyword'                              AS keyword,
       r->>'cluster_key'                          AS cluster_key,
       (r->>'cluster_member_count')::int          AS members,
       (r->>'base_rank')::int                     AS base_rank,
       (r->>'ctr_used')::numeric                  AS ctr_used,
       r->>'ctr_resolver_tier'                    AS tier,
       (r->>'svm_used')::numeric                  AS svm,
       (r->>'volume_forward_used')::numeric       AS vol_fwd,
       (r->>'modelled_monthly')::numeric          AS modelled,
       (r->>'actual_clicks_exact')::numeric       AS act_exact,
       (r->>'actual_clicks_cluster')::numeric     AS act_cluster,
       (r->>'per_pair_ratio')::numeric            AS ratio
FROM p
ORDER BY (r->>'per_pair_ratio')::numeric DESC
LIMIT 5;
```

### Q3. Worst under-predictions (§3)

Same as Q2 with `ORDER BY (r->>'per_pair_ratio')::numeric ASC LIMIT 5`.
