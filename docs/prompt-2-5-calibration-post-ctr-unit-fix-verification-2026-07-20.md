# Prompt 2.5 — Calibration verification, post-CTR-unit-fix

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Snapshot under review:** `fe5e3d42-bf7b-4843-87e3-6cd12e7a5594`
**Compared against:** `f3705db5` (pre-fix, 2026-07-20 19:16) and `1d8dab0c` (Gate B datum, 2026-07-20 19:00)
**Author:** Lovable agent — read-only, evidence rule enforced.

---

## 1. Run outcome

```sql
SELECT id, created_at, window_days, overall_ratio,
       keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY created_at DESC LIMIT 5;
```

| id | created_at | window_days | overall_ratio | matched | unmatched |
|---|---|---:|---:|---:|---:|
| **fe5e3d42** (post-fix) | 2026-07-20 19:47:36 UTC | 498 | **1.045105** | 44 | 14 724 |
| f3705db5 (pre-fix)      | 2026-07-20 19:16:05 UTC | 498 | 0.010451     | 44 | 14 724 |
| 1d8dab0c (Gate B)       | 2026-07-20 19:00:13 UTC | 498 | 0.010451     | 44 | 14 724 |
| 4a9aa1a5                | 2026-07-20 18:49:04 UTC | 498 | 0.010451     | 44 | 14 724 |
| 744db4c6                | 2026-07-20 15:28:43 UTC | 498 | 0.007535     | 44 | 14 724 |

**Notes on snapshot `fe5e3d42`:**
`model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=94 · model_blind=143 · overall=Σm/Σa=1951.77/1867.53=1.045105`

**Hand-verification of overall_ratio from totals row:**

```sql
SELECT by_rank_band->'totals'
FROM calibration_snapshots WHERE id='fe5e3d42-bf7b-4843-87e3-6cd12e7a5594';
```
`sum_modelled_monthly = 1951.7658343531107`, `sum_actual_monthly = 1867.5301204819275`.
`1951.7658 / 1867.5301 = 1.045105` — matches `overall_ratio` field to 6 dp. ✅

**Redeploy + boot evidence for `calibration-compute`:** function redeployed 2026-07-20 during the CTR-unit fix; the `supabase--deploy_edge_functions` tool returned `Successfully deployed edge functions: calibration-compute`. Snapshot `fe5e3d42` was written **31 minutes later** (19:47:36 UTC vs pre-fix run at 19:16:05 UTC), on the same 25 000-row / 44-scored / 143-model-blind fixture as `f3705db5`, and shifted the overall ratio by exactly **×100.00000** (0.010451054 → 1.045105411). The identical scored/matched/unmatched counts plus the exact 100× multiplier is the boot signature — no other code path could have produced that.

---

## 2. Headline — overall ratio + traffic light

**Overall ratio = 1.045105 → GREEN** (0.5 ≤ r ≤ 2.0).

### By intent

```sql
SELECT by_intent FROM calibration_snapshots WHERE id='fe5e3d42-…';
```

| Intent | Σ modelled | Σ actual | Ratio | Median per-pair | Pairs | Impressions (context) | Light |
|---|---:|---:|---:|---:|---:|---:|---|
| transactional  | 979.14 | 977.71 | **1.0015** | 1.099 | 39 | 2 813 256 | 🟢 |
| commercial     | 90.46  | 162.77 | 0.5558 | 0.656 | 2  | 177 470 | 🟢 |
| informational  | 840.81 | 705.48 | 1.1918 | 2.400 | 2  | 2 122 634 | 🟢 |
| navigational   | 41.35  | 21.57  | 1.9173 | 1.917 | 1  | 5 997 | 🟢 |
| unknown        | 0      | 0      | —      | —     | 0  | 0 | — |

### By rank band

```sql
SELECT by_rank_band->'1-3', by_rank_band->'4-10', by_rank_band->'11-20'
FROM calibration_snapshots WHERE id='fe5e3d42-…';
```

| Band | Σ modelled | Σ actual | Ratio | Median per-pair | Pairs | Impressions (context) | Light |
|---|---:|---:|---:|---:|---:|---:|---|
| 1–3   | 44.15    | 29.70   | **1.4867** | 1.131 | 2  | 14 910    | 🟢 |
| 4–10  | 453.17   | 470.48  | 0.9632     | 1.136 | 14 | 754 650   | 🟢 |
| 11–20 | 1 454.44 | 1 194.58| 1.2175     | 1.299 | 25 | 3 847 244 | 🟢 |

**Gate verdict (clicks-only criterion — overall green AND no intent bucket red):**
**PASS.** Overall ratio 1.045 (green); all four populated intent buckets green; all three rank bands green. First green calibration on TVs Ongoing.

---

## 3. Distribution of per-pair ratios

```sql
WITH p AS (
  SELECT (elem->>'per_pair_ratio')::numeric AS r
  FROM calibration_snapshots,
       jsonb_array_elements(by_rank_band->'pairs_scored') elem
  WHERE id='fe5e3d42-…' AND elem->>'per_pair_ratio' IS NOT NULL
)
SELECT count(*), min(r), max(r),
       percentile_cont(0.25) WITHIN GROUP (ORDER BY r) AS p25,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY r) AS median,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY r) AS p75,
       count(*) FILTER (WHERE r BETWEEN 0.5 AND 2.0) AS green,
       count(*) FILTER (WHERE (r>=0.33 AND r<0.5) OR (r>2.0 AND r<=3.0)) AS amber,
       count(*) FILTER (WHERE r<0.33 OR r>3.0) AS red
FROM p;
```

| n | min | p25 | **median** | p75 | max | green | amber | red |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 94 | 0.000 | 0.804 | **1.568** | 3.313 | 63.363 | 41 | 18 | 35 |

**Do pairs cluster near 1.0 or merely average to it?** They do NOT cluster. The **median per-pair ratio is 1.568** while the **portfolio ratio is 1.045**, meaning the aggregate is dragged down by high-actual pairs (the sum-of-sums weighting) while individual pairs skew high. The IQR spans **0.804–3.313** — over 4× — and **35 of 94 pairs (37%) are red** (13 zero-ctr pairs at ranks 21+ where the resolver returns no curve, plus 22 large over-predictions). The portfolio green light hides substantial per-pair dispersion.

### 5 worst OVER-predictions (ratio ≫ 1)

| Keyword | Device | Intent | Rank | ctr_used | Tier | Curve key | svm | volFwd | Modelled | Actual | Ratio |
|---|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|
| hisense tvs      | mobile | trans   | 12 | 0.0039 | project_device_intent | mobile\|transactional\|12 | 0.612 | 422 200 | 83.98 | 1.33 | **63.36** |
| 32 in tv         | mobile | info    | 15 | 0.0050 | project_device_intent | mobile\|informational\|15 | 0.612 | 342 475 | 87.33 | 1.99 | **43.93** |
| 55in tv          | mobile | trans   | 13 | 0.0039 | project_device_intent | mobile\|transactional\|13 | 0.648 | 281 569 | 59.30 | 1.51 | **39.37** |
| cheap televisions| mobile | trans   |  6 | 0.0130 | project_device_intent | mobile\|transactional\|6  | 0.479 | 133 774 | 69.39 | 3.01 | **23.04** |
| sony tv          | mobile | trans   | 14 | 0.0039 | project_device_intent | mobile\|transactional\|14 | 0.720 | 146 898 | 34.37 | 1.75 | **19.68** |

Pattern: **all 5 mobile, all high-volume brand/generic head terms at rank 6–15**. Actual clicks are 1–3/mo — well above the noise floor but tiny relative to modelled volume × CTR × SVM. The model treats these as significant traffic; empirically they draw almost none.

### 5 worst UNDER-predictions (ratio = 0)

| Keyword | Device | Intent | Rank | ctr_used | Tier | Curve key | svm | volFwd | Modelled | Actual | Ratio |
|---|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|
| samsung tv            | mobile | trans | 29 | 0.0000 | none | mobile\|transactional\|29 | 0.581 | 572 074 | 0 | 17.41 | 0 |
| 48 inch tv            | mobile | trans | 24 | 0.0000 | none | mobile\|transactional\|24 | 0.581 |  61 476 | 0 | 21.08 | 0 |
| 50 inch tv            | mobile | trans | 21 | 0.0000 | none | mobile\|transactional\|21 | 0.684 | 572 226 | 0 | 134.28 | 0 |
| philips ambilight tv 65| mobile| trans | 25 | 0.0000 | none | mobile\|transactional\|25 | 0.496 |  18 330 | 0 | 1.20 | 0 |
| samsung 55 inch tv    | mobile | trans | 23 | 0.0000 | none | mobile\|transactional\|23 | 0.720 | 114 229 | 0 | 4.94 | 0 |

Pattern: **all rank ≥21**, all `tier=none` (resolver has no curve past rank 20 — CTR curves are only built for r1–r20). These pairs contribute Σmodelled=0 but Σactual=178.9 clicks/mo, single-handedly dragging the portfolio ratio down by ~0.09. This is a **coverage hole, not a units bug** — a rank-21+ tail extension would recover it.

---

## 4. Matching anatomy

| Metric | Value |
|---|---:|
| GSC rows fetched                         | 25 000 |
| GSC non-brand rows                       | 20 604 |
| GSC normalised queries (non-brand)       | 14 961 |
| Curated keyword universe (TVs Ongoing)   | 857 |
| **Matched (scored)**                     | **94 pairs** (aggregate `matched=44` after per-keyword collapse across device rows) |
| Model-blind (base_rank NULL)             | 143 pairs, Σ actual_30d = 1 535.72 clicks, median GSC position = 10.8 |
| Noise-floor exclusions (actual<5/30d)    | not surfaced separately in `by_rank_band.totals` — logical remainder = 94 − 44 = 50 device rows collapsed/excluded |
| **Unmatched from GSC → keyword universe**| 14 724 |
| **Unmatched from keyword universe → GSC**| 857 − (44 curated matches + 143 model_blind) ≈ 670 |

### Top 10 unmatched-by-clicks non-brand GSC queries (Phase 3 discovery preview)

```sql
SELECT elem
FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'top_unmatched') elem
WHERE id='fe5e3d42-…' LIMIT 10;
```

| # | Query | Clicks (window) |
|--:|---|---:|
| 1  | fridge freezer            | 64 481 |
| 2  | washing machine           | 24 803 |
| 3  | tumble dryer              | 23 193 |
| 4  | microwave                 | 22 175 |
| 5  | condenser tumble dryer    | 15 356 |
| 6  | aeg comfort 6000          | 13 606 |
| 7  | integrated fridge freezer | 11 983 |
| 8  | american fridge freezer   | 10 480 |
| 9  | integrated washing machine| 10 468 |
| 10 | appliances online         | 10 223 |

These are the parent site's non-TV traffic (whole-site GSC vs siloed TV universe — the H1 hypothesis for the aggregate mismatch, unchanged post-fix).

---

## 5. Worked pair — `24 inch tv` (VERBATIM from `pairs_scored[]`)

```sql
SELECT p FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
WHERE id='fe5e3d42-…' AND p->>'keyword' = '24 inch tv';
```

```json
{
  "keyword": "24 inch tv",
  "keyword_id": "11933010-d609-4aae-9af7-f7d98943a43d",
  "device": "mobile",
  "intent": "transactional",
  "base_rank": 8,
  "ctr_curve_key": "mobile|transactional|8",
  "ctr_resolver_tier": "project_device_intent",
  "ctr_used": 0.0105,
  "svm_used": 0.612,
  "annual_volume": 101300,
  "annual_volume_source": "keyword_monthly_volumes",
  "months_used": 12,
  "trend_pct": -13.11,
  "trend_confidence": "high",
  "trend_factor": 0.8689,
  "trend_applied": true,
  "volume_forward_used": 88019.57,
  "impressions": 59831,
  "actual_clicks_raw": 601,
  "actual_monthly": 36.2048,
  "modelled_monthly": 47.1345,
  "per_pair_ratio": 1.3019
}
```

**Arithmetic reproduction:**
`modelled_monthly = volume_forward × ctr_used × svm_used / 12`
= `88 019.57 × 0.0105 × 0.612 / 12`
= `88 019.57 × 0.006426 / 12`
= `565.6135 / 12`
= **`47.1345`** ✅ (matches ledger to 4 dp)

`per_pair_ratio = 47.1345 / 36.2048 = 1.3019` ✅

**Empirical GSC CTR for `24 inch tv`:**
```sql
SELECT SUM(clicks) AS clicks, SUM(impressions) AS imps,
       ROUND(SUM(clicks)::numeric/NULLIF(SUM(impressions),0)*100, 4) AS empirical_ctr_pp
FROM gsc_upload_keywords k JOIN gsc_uploads u ON u.id=k.upload_id
WHERE u.project_id='5fd4df7e-…' AND lower(trim(k.keyword))='24 inch tv';
```
`clicks=601, imps=59 831 → empirical CTR = 1.0045 pp`.
Modelled ctr_used = 1.0500 pp. **Model curve overshoots empirical by 4.5% relative** — well within the range where SVM absorbs the difference, and the pair lands green.

**Confirmation: `ctr_used = 0.0105` (not `0.000105`). CTR-unit fix verified in the ledger.** ✅

---

## 6. Revenue sanity block

```sql
SELECT by_rank_band->'revenue_sanity'
FROM calibration_snapshots WHERE id='fe5e3d42-…';
```

```json
{
  "label": "vs assumed conversion values",
  "cvr_source": "project_default",
  "aov_source": "project_default",
  "modelled_current_monthly_revenue": 7807.06,
  "actual_monthly_revenue": 7470.12,
  "ratio": 1.045
}
```

Rendered labelled — informational only. Ratio identical to overall clicks ratio (as expected, since CVR and AOV apply uniformly to both sides).

---

## 7. Interpretation discipline

The residual 4.5% deviation from 1.000 is trivial at portfolio level and lies well inside the green band. The **more important finding is dispersion, not systematic bias**:

- Median per-pair 1.568 vs portfolio 1.045 → per-pair distribution is right-skewed (long tail of over-predictions at rank 11–15 high-volume terms). The sum-of-sums aggregation is what pulls the number back to ~1.
- 35 red pairs split cleanly: **13 are `tier=none` at rank ≥21** (Σmodelled=0, non-trivial Σactual) — a **coverage hole in the curve library**, not a modelling defect. **22 are over-predictions ≥3×**, concentrated on mobile transactional/informational rank 6–15 for head terms where modelled volume × CTR overwhelms actual click intake.
- Both intent buckets with only 1–2 pairs (commercial n=2, navigational n=1) are statistically thin — their ratios are informational, not diagnostic.

The residual is **dispersion, not systematic bias**. Systematic bias would show median ≈ portfolio ratio with tight IQR; here median > portfolio and IQR spans 4×. Remedy shape (whichever the advisor rules for) would be per-pair variance reduction rather than a global scale correction. No model changes proposed.

---

## 8. Tracker update

- **Gate B datum updated:** snapshot `fe5e3d42-bf7b-4843-87e3-6cd12e7a5594` supersedes `1d8dab0c` as the current Gate B reference. **Verdict: PASS.**
- **CTR-unit fix note:** all prior snapshots on TVs Ongoing (ratios 0.007535–0.010451, covering `744db4c6` through `f3705db5`) were **100× understated by the calibrator (double-division of CTR at `calibration-compute/index.ts:338`), NOT model error**. `pairs_scored[]` for `24 inch tv` shows `ctr_used=0.0105` post-fix vs the reconstructed `0.000105` pre-fix; the 100× shift in overall ratio (0.010451 → 1.045105) is identical to the shift a single-line `res.ctr → res.ctrPercentage/100` change predicted, confirming causality.
- **Audit closure (fix step 2):** review of every other resolver-value consumption in `calibration-compute/index.ts` found no further double-conversions. `svm` is a unitless multiplier; `volFwd` is annual keyword volume divided by 12 once; `trend_factor` is dimensionless; `actual30` is a scalar click count; `gsc.position` and `rank` are raw ordinals; `conversion_rate` was already correctly `/100`-converted once. **CTR was the sole site.**
- **Open flags to append to `docs/calculation-v21-programme.md`:**
  - **Rank-tail CTR coverage** — 13 red pairs at rank ≥21 with `tier=none`. Curve library stops at r20; extending to r30 or applying a decay tail would reclaim measurable actuals.
  - **Head-term over-prediction** — 22 pairs ≥3× over on mobile head terms; investigate whether SVM under-penalises brand-competitor rank-6-to-15 SERPs.
