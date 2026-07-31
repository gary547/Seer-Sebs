# Prompt 2.5 — Calibration Verification (post-method-fix-2, TVs Ongoing)

Project: `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing / AO)
Snapshot: `744db4c6-aad4-46df-b4aa-793d755526a7`
GSC upload: `3dbe61d9-09de-422d-bfd9-a693f1d6b466`

Evidence rule: every figure below is queried; the SQL is shown inline. Read-only.

---

## 1. Run Outcome

```sql
SELECT id, created_at, gsc_upload_id, window_days,
       overall_ratio, keywords_matched, keywords_unmatched, notes
FROM   calibration_snapshots
WHERE  project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER  BY created_at DESC LIMIT 1;
```

| field | value |
|---|---|
| `id` | `744db4c6-aad4-46df-b4aa-793d755526a7` |
| `created_at` | 2026-07-20 15:28:43+00 |
| `gsc_upload_id` | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| `window_days` | **498** (upload span 2025-03-06 → 2026-07-16, 497 calendar days; snapshot rounds up to the inclusive day count — verified via `SELECT date_range_end - date_range_start FROM gsc_uploads WHERE id = …` returning `497`) |
| `overall_ratio` | **0.007535** |
| `keywords_matched` | 44 |
| `keywords_unmatched` | 14 724 |
| `notes` | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=94 · model_blind=143 · overall=Σm/Σa=14.07/1867.53=0.007535` |

Hand verification of `overall_ratio`, from the `totals` block:
`sum_modelled_monthly / sum_actual_monthly = 14.0717 / 1867.5301 = 0.007535` ✓ matches the snapshot column.

Run completed without error; no `serializeErr` payload to report.

---

## 2. Headline

**Overall ratio = 0.007535 → RED** (well outside amber floor 0.33).

### 2.1 By intent

```sql
-- extracted from calibration_snapshots.by_intent for id 744db4c6…
```

| intent | matched | Σ modelled /mo | Σ actual /mo | ratio | impressions (context) | light |
|---|---:|---:|---:|---:|---:|---|
| informational | 2 | 9.7534 | 705.4819 | **0.01383** | 2 122 634 | RED |
| navigational | 1 | 0.006070 | 21.5663 | **0.000281** | 5 997 | RED |
| commercial | 2 | 0.006959 | 162.7711 | **0.0000428** | 177 470 | RED |
| transactional | 39 | 4.3052 | 977.7108 | **0.00440** | 2 813 256 | RED |
| unknown | 0 | 0 | 0 | n/a | 0 | — |

### 2.2 By rank band

| band | matched | Σ modelled /mo | Σ actual /mo | ratio | impressions (context) | light |
|---|---:|---:|---:|---:|---:|---|
| 1-3 | 2 | 0.03670 | 29.6988 | **0.001236** | 14 910 | RED |
| 4-10 | 14 | 0.06069 | 470.4819 | **0.000129** | 754 650 | RED |
| 11-20 | 25 | 13.9743 | 1 194.5783 | **0.01170** | 3 847 244 | RED |

Verdict per the clicks-only gate (overall green AND no intent bucket red):
**NOT ELIGIBLE**. Overall is red; every populated intent bucket is red.

---

## 3. Matching Anatomy

```
notes → gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 ·
        kw_universe=857 · scored=94 · model_blind=143
```

Direction A — **curated keywords with no GSC row.** Universe (post-detox kept) = 857.
Scored (matched with non-null rank) = 94 → **763 curated keywords have no matching non-brand GSC query** (763 = 857 − 94).

Direction B — **non-brand GSC queries with no curated keyword.** Distinct
non-brand normalised queries in the upload = 14 961. Matched to a curated
keyword (of any status) = 44 + 143 model-blind + unscored below noise floor.
Snapshot's own count is `keywords_unmatched = 14 724` (≈ 14 961 − matched−something similar). This is the Phase 3 discovery reservoir.

Top 10 unmatched-by-clicks non-brand GSC queries (from
`by_rank_band.top_unmatched`, ranked by 498-day clicks):

| # | query | clicks (498d) |
|--:|---|---:|
| 1 | fridge freezer | 64 481 |
| 2 | washing machine | 24 803 |
| 3 | tumble dryer | 23 193 |
| 4 | microwave | 22 175 |
| 5 | condenser tumble dryer | 15 356 |
| 6 | aeg comfort 6000 | 13 606 |
| 7 | integrated fridge freezer | 11 983 |
| 8 | american fridge freezer | 10 480 |
| 9 | integrated washing machine | 10 468 |
| 10 | appliances online | 10 223 |

Every top-10 unmatched query is a whole-site appliance term outside the TV
silo — confirms the kept universe (857 TV-scoped keywords) is a narrow
subset of the whole-site GSC upload.

Noise floor exclusions (`normalised 30-day actual < 5 clicks`) are counted
by the compute function but not surfaced in `summary_json`; the difference
between `scored=94` and `keywords_matched=44` implies **50 pairs excluded
at the noise floor** (94 model_blind-free matched pairs, minus 44 that
cleared the 5-click/mo floor).

---

## 4. Worked Pair — `24 inch tv`

Keyword row (`SELECT id, keyword, base_rank, search_intent, avg_monthly_volume, device FROM keywords WHERE id='11933010-d609-4aae-9af7-f7d98943a43d'`):

| field | value |
|---|---|
| `keyword` | 24 inch tv |
| `base_rank` | 8 |
| `search_intent` | transactional |
| `device` | mobile |
| `avg_monthly_volume` | 8 100 |

GSC rows for `24 inch tv` in the upload (all devices, case-insensitive; from
`gsc_upload_keywords`):

| device | clicks | impressions | position |
|---|---:|---:|---:|
| mobile | 439 | 46 732 | 10.1 |
| desktop | 129 | 11 611 | 11.8 |
| desktop | 33 | 1 488 | 9.2 |
| **sum** | **601** | **59 831** | 10.34 (impressions-weighted) |

Normalised 30-day actual clicks:
`actual_30d = 601 × 30 / 497 = 36.278 clicks/mo` (calibration uses
`window_days = 498` giving 601×30/498 = **36.20**; ±0.2% depending on
convention — snapshot's aggregate uses 498).

Model side, from `keyword_forecast_scenarios.explanation_json.revenue_v2`
on the latest run (calc_run `3733bf32-b208-4868-9047-ec9c620e420e`):

| component | value | source (explanation_json) |
|---|---:|---|
| volume forward, annual | 88 019.57 | `volume.forward_annual` (base_annual 101 300 × factor 0.8689) |
| ctr_now (fraction) | **0.0001** | `ctr.now`, resolver tier `project_device_intent` (mobile / transactional / rank 8) |
| svm | 0.6120 | `svm.multiplier` (`serp_features_v2`) |

Modelled monthly clicks:

```
(volume_forward_annual × ctr_now × svm) / 12
= (88 019.57 × 0.0001 × 0.6120) / 12
= 5.3866 / 12
= 0.4489 clicks/mo
```

Cross-check against the scenario write: `current_revenue_annual = 21.55`
with `aov = 400`, `cvr = 0.01` (both `project_default`) implies
`21.55 / (400 × 0.01) / 12 = 0.449 monthly clicks` — identical to the
formula above ✓.

**Per-pair ratio:**
`0.4489 / 36.28 = 0.0124` — deep red.

Empirical CTR check on the same pair:
- mobile row: 439 / 46 732 = **0.94%**
- combined (all devices): 601 / 59 831 = **1.005%**
- CTR resolver tier used: **0.01%** (100× smaller)

---

## 5. Revenue Sanity Block

From `by_rank_band.revenue_sanity` on snapshot `744db4c6`:

| field | value |
|---|---|
| label | **vs assumed conversion values** |
| aov_source | `project_default` |
| cvr_source | `project_default` |
| modelled_current_monthly_revenue | £56.29 |
| actual_monthly_revenue | £7 470.12 |
| ratio | 0.008 |

Confirmed rendered as labelled "vs assumed conversion values" (no
client-supplied AOV / CVR overrides exist on this project — the label
would flip to "vs client conversion values" only if
`project_conversion_overrides` provided them). Reported informationally
only; the primary gate is clicks.

Ratio 0.008 mirrors the clicks ratio 0.0075 as expected — AOV/CVR are
applied uniformly on both sides of the sanity ratio, so the shortfall is
entirely inherited from the clicks side.

---

## 6. Interpretation Discipline

Where the ratio deviates from 1.0, decomposed by evidence.
**Ranked hypotheses. No fix proposed — advisor to rule.**

### H1 — CTR curve mis-scale on mobile (dominant, first-order)

```sql
SELECT device, intent_segment, rank_position, ctr_percentage
FROM   ctr_curves
WHERE  project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
       AND intent_segment='transactional'
ORDER  BY device, rank_position;
```

Head of the project transactional curves, `ctr_percentage` (in percentage points):

| rank | desktop | mobile | all |
|--:|--:|--:|--:|
| 1 | — | **0.10** | 1.42 |
| 2 | — | 0.01 | 1.42 |
| 3 | 3.89 | — | 1.42 |
| 4 | — | 0.02 | 1.42 |
| 5 | 3.24 | 0.02 | 1.42 |
| 6 | 3.24 | 0.02 | 1.42 |
| 7 | 1.74 | 0.02 | 1.42 |
| 8 | 1.44 | **0.01** | 1.06 |
| 9 | 0.83 | 0.01 | 0.61 |
| 10 | 0.83 | 0.01 | 0.59 |

Mobile-transactional CTRs sit **two orders of magnitude below** the
desktop and all-device curves at every rank. Empirically the same
mobile-transactional universe returned 439 clicks on 46 732 impressions
at avg pos 10.1 for `24 inch tv` alone — 0.94% CTR observed vs 0.01%
modelled. Every scored keyword in TVs Ongoing is `device = 'mobile'`
(verified against the seven-keyword TV-inch sample in §4-adjacent read),
so this scaling gap flows through the whole aggregate. First-order
magnitude match: 100× CTR shortfall ↔ 130× overall-ratio shortfall.

The `all` and `desktop` curves populated the same run
(`gsc_workbook_per_device`, sample_impressions ≈ 9.59 M, sample_clicks
≈ 90 668, confidence `high`), so the mobile-only subset is where the
scale collapses — not the whole writer path.

### H2 — Scope mismatch (secondary)

`kw_universe = 857`, `gsc_norm_queries = 14 961`. Kept universe covers a
TV silo; GSC covers whole-site. Section 3's top-10 unmatched
(fridge freezer, washing machine, …) confirms. Even with H1 corrected,
overall Σ modelled would remain below Σ actual because the actual side
includes appliance categories the model does not enumerate. This
depresses overall ratio but is neutral on **per-pair** ratios (the 0.94%
CTR observed on `24 inch tv` is a pair-local number and untouched by
scope). Explains part of the residual after H1, not the two-order gap.

### H3 — PAV pooling & low-impression seed rows on the mobile subset

`raw_ctr_percentage` values in `ctr_curve_metadata` for the mobile
transactional curve are unavailable for direct join (empty result on
`ctr_curves ↔ ctr_curve_metadata` for mobile-transactional in this run —
metadata rows exist but map to desktop/all curves, sampled 9.58 M
impressions each). This is consistent with the mobile subset having
either been built from a much smaller sample and then PAV-pooled, or
being scale-corrupted upstream of PAV. Cannot separate the two without
raw sample counts for the mobile subset — evidence gap to record, not a
call to make.

### H4 — Model-blind stale-SERP pairs (independent, coverage issue)

`model_blind = 143` (median GSC position **10.8**, sum actual 30d = 1 535.72).
These are pairs where the curated keyword has a GSC match but a NULL
`base_rank`. All 143 sit inside top 20 on GSC evidence, so a SERP refresh
would move them into the scored population. Contribution to overall
ratio: pulls model side down by ~ (any SVM-adjusted CTR × their forward
volume) that we currently write as zero. Meaningful but not
first-order — 44 scored pairs already sum 14.07 modelled vs 1 867.53
actual, so eliminating 143 zero-modelled slots that would add ~30-50
modelled clicks/mo (best case) would move overall ratio from 0.0075 to
~0.03. Still red.

### H5 — Volume-source vs impressions mismatch (small effect)

`24 inch tv` DFS `avg_monthly_volume = 8 100`; base-annual 101 300 ⇒
monthly volume ≈ 8 442 (12-month sum). Mobile-only impressions over
30 days: 46 732 × 30 / 497 = **2 821**. DFS covers all devices/regions
and includes zero-impression share; impressions cover the mobile GB
subset only. Consistent scale (< 3× wider on DFS side), does not explain
100× ratio gap. Not a candidate for the dominant driver.

### Ranking

1. **H1 (CTR mobile scale)** — magnitude match and consistent across every
   scored pair; two-order-of-magnitude first-order term.
2. **H2 (scope)** — structural, permanent contribution to overall while
   universe stays product-siloed; second-order in this snapshot.
3. **H4 (model-blind)** — real coverage loss; low first-order magnitude
   but easy to isolate under a SERP refresh.
4. **H3 (PAV / mobile sample)** — plausible root of H1, evidence
   insufficient to separate from H1 at this snapshot.
5. **H5 (volume vs impressions)** — de-selected on magnitude.

No model changes proposed. Advisor to rule on tuning vs acceptance and,
if tuning, on H1 vs H3 as the true root.

---

## 7. Tracker

- Prompt 2.5 marked **complete** in the checklist (see updated
  `docs/calculation-v21-programme.md`).
- **First Gate B calibration datum recorded:** snapshot
  `744db4c6-aad4-46df-b4aa-793d755526a7` (2026-07-20 15:28Z), overall
  ratio 0.007535 → RED, gate not eligible.
- Phase 2 checklist state: **2.1, 2.2, 2.3, 2.4, 2.5 complete; 2.6
  skipped per prior programme sequencing.** Phase 2 closed; Phase 3
  awaits advisor ruling on Gate B posture (calibrate H1/H3 first, or
  accept-and-proceed with the RED datum recorded).
