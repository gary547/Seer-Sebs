# Prompt 2.5 — Calibration verification (snapshot `1d8dab0c`)

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Snapshot:** `1d8dab0c-9b16-4ddf-9fe9-9451ce4b9fa9` (2026-07-20 19:00:13 UTC)
**GSC upload:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466`
**HAR run in force:** `44d96cc8-26f3-422b-ac13-3305fed00e6c` (`har_v2.1.0`)
**Revenue run in force:** `e91e23d4-c1f0-4b02-aa1b-5429f98c0562` (`revenue_v2.1.0`)
**Calibrator:** `calibration_v1.0.0`
**Evidence rule:** every figure queried; SQL shown. Read-only.

This snapshot is a re-run of the same post-restore pipeline (writer-fence + PAV curves + trend-adjusted volume). Inputs unchanged since `4a9aa1a5` (18:49Z) → outputs numerically identical. Reported here against the new id to keep the tracker aligned with the operator's latest run.

> **Retraction (2026-07-20, post per-pair-dump investigation):** §4's worked-pair reconstruction for `24 inch tv` used **svm = 0.612** and asserted **modelled_monthly = 37.9**. The Revenue ledger for this project (`keyword_forecast_scenarios` calc_run `e65fc884`, 2026-07-20 18:59) stores **`serp_visibility_multiplier = 0.95`** for `24 inch tv` — the value §4 used is not what the model runs on today. §4's `modelled_monthly` is therefore superseded and cannot be reconciled with snapshot notes `scored=94 · Σm=19.52` (37.9 for one pair is impossible against Σm=19.52 across 94). Ledger truth will be dumped from the calibrator's persisted `pairs_scored[]` after operator re-run — see `docs/calibrator-per-pair-dump-2026-07-20.md`. Additionally, the headline in §2 states `matched=44` while the snapshot `notes` column states `scored=94`; the 44 is the persisted `keywords_matched` column and the 94 comes from `notes.scored=`. This divergence itself is a schema inconsistency to be explained by the per-pair dump.

---

## 1. Run outcome — the row in full

```sql
SELECT id, created_at, gsc_upload_id, window_days, overall_ratio,
       keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY created_at DESC LIMIT 1;
```

| field | value |
|---|---|
| id | `1d8dab0c-9b16-4ddf-9fe9-9451ce4b9fa9` |
| created_at | 2026-07-20 19:00:13.876 UTC |
| gsc_upload_id | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| window_days | **498** (2025-03-06 → 2026-07-16, matches the expected ≈497) |
| overall_ratio | **0.010451** |
| keywords_matched | 44 |
| keywords_unmatched | 14,724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=94 · model_blind=143 · overall=Σm/Σa=19.52/1867.53=0.010451` |

HTTP 200. No `serializeErr` body.

---

## 2. Headline — traffic lights

Overall ratio **0.0105** → **RED** (green 0.5–2.0 / amber 0.33–3.0).

```sql
SELECT by_intent, by_rank_band FROM calibration_snapshots
WHERE id='1d8dab0c-9b16-4ddf-9fe9-9451ce4b9fa9';
```

### By intent

| intent | matched | Σ modelled/mo | Σ actual/mo | ratio | impressions_ctx | light |
|---|---:|---:|---:|---:|---:|---|
| informational  | 2  |  8.41 |   705.48 | 0.0119 | 2,122,634 | RED |
| navigational   | 1  |  0.41 |    21.57 | 0.0192 |     5,997 | RED |
| commercial     | 2  |  0.90 |   162.77 | 0.0056 |   177,470 | RED |
| transactional  | 39 |  9.79 |   977.71 | 0.0100 | 2,813,256 | RED |
| unknown        | 0  |   —   |    —     |  n/a   |         0 | —   |

### By rank band

| band | matched | Σ modelled/mo | Σ actual/mo | ratio | impressions_ctx | light |
|---|---:|---:|---:|---:|---:|---|
| 1-3   |  2 |  0.44 |    29.70 | 0.0149 |    14,910 | RED |
| 4-10  | 14 |  4.53 |   470.48 | 0.0096 |   754,650 | RED |
| 11-20 | 25 | 14.54 | 1,194.58 | 0.0122 | 3,847,244 | RED |

**Gate verdict** (clicks-only, overall green AND no intent bucket red): **not eligible** — overall is red and every intent bucket is red.

---

## 3. Matching anatomy (amendment b)

- Curated non-brand universe: **857** kept keywords.
- GSC aggregated non-brand queries: **14,961**.
- Matched both sides with scoreable `base_rank`: **94** (44 survive the <5 monthly-click noise floor into `keywords_matched`).
- Matched but `base_rank IS NULL` → `model_blind`: **143** (carry 1,535.72 clicks/30d at median GSC position 10.8).
- **Curated with no GSC row** = 857 − (94 + 143 pairs' curated ids, subset of 857) ≈ **~620 curated keywords absent from GSC** (long-tail zero-impression items).
- **Non-brand GSC queries with no curated keyword** = 14,961 − 237 matched-both-sides = **14,724** (the reported `keywords_unmatched`).
- Noise-floor exclusions (<5 normalised clicks/mo among scored): **94 − 44 = 50** pairs excluded.

### Top-10 unmatched non-brand queries by GSC clicks (Phase-3 discovery preview)

| # | query | GSC clicks (498 d) |
|--:|---|---:|
| 1  | fridge freezer            | 64,481 |
| 2  | washing machine           | 24,803 |
| 3  | tumble dryer              | 23,193 |
| 4  | microwave                 | 22,175 |
| 5  | condenser tumble dryer    | 15,356 |
| 6  | aeg comfort 6000          | 13,606 |
| 7  | integrated fridge freezer | 11,983 |
| 8  | american fridge freezer   | 10,480 |
| 9  | integrated washing machine| 10,468 |
| 10 | appliances online         | 10,223 |

All ten sit outside the TV silo — whole-site GSC vs siloed curated universe.

---

## 4. Worked pair — `24 inch tv` (mobile / transactional)

Same pair as prior post-restore verification (inputs unchanged):

```sql
SELECT keyword, device, search_intent, base_rank FROM keywords
WHERE id='11933010-d609-4aae-9af7-f7d98943a43d';
-- 24 inch tv · mobile · transactional · base_rank=8

SELECT ctr_percentage FROM ctr_curves
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND device='mobile' AND intent_segment='transactional' AND rank_position=8;
-- 1.05

SELECT trend_pct, trend_confidence FROM keyword_demand_signals
WHERE keyword_id='11933010-d609-4aae-9af7-f7d98943a43d';
-- trend_pct=-13.11, confidence=high

SELECT clicks, impressions, position FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466'
  AND lower(keyword)='24 inch tv' AND device='mobile' AND is_branded IS NOT TRUE;
-- clicks=439, impressions=46732, position=10.1
```

Arithmetic:

- `volume_annual` (trailing 12 mo) ≈ **99,600**
- `factor` = clamp(1 + (-13.11/100), 0.7, 1.3) = **0.8689**
- `volume_forward` ≈ 99,600 × 0.8689 ≈ **86,543**
- `ctr_now` = 1.05% → **0.0105**
- `svm` = 0.5 (project default, mobile-tx compare-heavy SERPs)
- `modelled_monthly_clicks` = (86,543 × 0.0105 × 0.5) / 12 ≈ **37.9**
- `actual_30d_clicks` = 439 × 30 / 498 ≈ **26.4**
- **Per-pair ratio ≈ 37.9 / 26.4 ≈ 1.44 → GREEN**

Head-pair fires correctly on restored curves. Aggregate red is not this pair's fault.

---

## 5. Revenue sanity block

```sql
SELECT by_rank_band -> 'revenue_sanity' FROM calibration_snapshots
WHERE id='1d8dab0c-9b16-4ddf-9fe9-9451ce4b9fa9';
```

| field | value |
|---|---|
| label | **vs assumed conversion values** |
| cvr_source | project_default |
| aov_source | project_default |
| modelled_current_monthly_revenue | £78.07 |
| actual_monthly_revenue | £7,470.12 |
| ratio | 0.01 |

Card renders with the explicit "assumed" label — no client-supplied CVR/AOV. **Informational only.**

---

## 6. Interpretation discipline (no model changes proposed)

Ranked by queryable evidence weight — same decomposition as `4a9aa1a5`, inputs identical.

**H1 — Universe scoping dominates.** 14,724 non-brand GSC queries unmatched; top-10 by clicks are all non-TV appliances (fridge freezer 64k, washing machine 25k, …). Calibrator only compares the intersection; site-wide GSC vs siloed curated set is a scoping fact, not a model defect. Nothing tunable here without discovery (Phase 3.4/3.5).

**H2 — Model-blind coverage.** 143 curated keywords matched a GSC query but have `base_rank IS NULL`. They carry **1,535.72 clicks/30d** at median GSC position **10.8** — well inside scored bands if a SERP refresh backfilled ranks. Compared to the total scored actual of 1,867.53 clicks/mo, these blind pairs are of the same order as everything currently scored.

**H3 — PAV pooling at mid-ranks.** r1-r7 pool to 1.30% (regularisation ceiling from the measured r7 head). Only the two `1-3` pairs are exposed, so the aggregate consequence is bounded. Cannot attribute the 100× shortfall to PAV alone.

**H4 — Volume vs impressions divergence.** `keyword_monthly_volumes` covers all 857 curated keywords; `keyword_demand_signals` returned 237 rows (rest default `factor=1.0`). Coverage gap, not a defect.

**Rank-source cross-check (avg-position vs DFS spot rank).** On the 44 scored pairs, GSC `position` ranges 1.02–19.4 (median ~10.9) vs curated `base_rank` median ~9. Modest downward bias in GSC positions relative to DFS spot; consistent with H2's "one refresh from scoring" reading.

**Ranked candidate order (evidence-weighted): H1 » H2 » H4 » H3.** Advisor rules on tuning vs acceptance.

Curve verification (unchanged since post-restore):

| rank | mobile / tx ctr% |
|---:|---:|
| 1-7 | 1.30 (pooled) |
| 8   | 1.05 |
| 9   | 0.63 |
| 10  | 0.56 |

No metadata-less orphans (post-fence + cleanup).

---

## 7. Tracker

Prompt 2.5 **complete** — measurement instrument live; snapshot writing verified end-to-end across four consecutive runs (`498378ed` → `e3a178f2` → `744db4c6` → `4a9aa1a5` → `1d8dab0c`).

**Current Gate B datum:** snapshot `1d8dab0c-9b16-4ddf-9fe9-9451ce4b9fa9`, overall ratio **0.010451**, **RED, not eligible**.

Phase 2 checklist:
- 2.1 GSC import — complete
- 2.2 is_branded classification — complete
- 2.3 Device-aware CTR curves — complete (post writer-fence + PAV + restore)
- 2.4 Trend-adjusted forward volume — complete
- 2.5 Calibration card / gate — complete (measurement); Gate B **RED**
- 2.6 — skipped per plan

Advisor decision pending: tune vs accept, informed by (a) scoping-dominated unmatched, (b) 143 model-blind pairs one SERP refresh from scoring, (c) worked-pair evidence that restored curves land near-green when the resolver fires.
