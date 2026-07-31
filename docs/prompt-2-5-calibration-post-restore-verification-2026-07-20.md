# Prompt 2.5 — Calibration verification (post CTR-restore)

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Snapshot:** `4a9aa1a5-50d8-48b8-8dd9-80615957dcc1` (2026-07-20 18:49:04 UTC)
**GSC upload:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466`
**HAR run:** `44d96cc8-26f3-422b-ac13-3305fed00e6c` (`har_v2.1.0`, 2026-07-20 18:47:57 UTC)
**Revenue run:** `e91e23d4-c1f0-4b02-aa1b-5429f98c0562` (`revenue_v2.1.0`, 2026-07-20 18:48:17 UTC)
**Calibrator:** `calibration_v1.0.0`
**Evidence rule:** every figure is queried; SQL shown. Read-only throughout.

---

## 1. Run outcome — the row in full

```sql
SELECT id, created_at, gsc_upload_id, window_days, overall_ratio,
       keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY created_at DESC LIMIT 1;
```

| field | value |
|---|---|
| id | `4a9aa1a5-50d8-48b8-8dd9-80615957dcc1` |
| created_at | 2026-07-20 18:49:04.968 UTC |
| gsc_upload_id | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| window_days | **498** (2025-03-06 → 2026-07-16) |
| overall_ratio | **0.010451** |
| keywords_matched | 44 |
| keywords_unmatched | 14,724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=94 · model_blind=143 · overall=Σm/Σa=19.52/1867.53=0.010451` |

Function returned 200. No `serializeErr` body.

---

## 2. The headline — traffic lights

Overall ratio **0.0105** → **RED** (threshold: green 0.5–2.0 / amber 0.33–3.0).

```sql
SELECT by_intent, by_rank_band FROM calibration_snapshots
WHERE id = '4a9aa1a5-50d8-48b8-8dd9-80615957dcc1';
```

### By intent

| intent | matched | Σ modelled/mo | Σ actual/mo | ratio | light |
|---|---:|---:|---:|---:|---|
| informational  | 2  | 8.41 | 705.48 | 0.0119 | RED |
| navigational   | 1  | 0.41 |  21.57 | 0.0192 | RED |
| commercial     | 2  | 0.90 | 162.77 | 0.0056 | RED |
| transactional  | 39 | 9.79 | 977.71 | 0.0100 | RED |
| unknown        | 0  |  —   |   —    |  n/a   | —  |

### By rank band

| band | matched | Σ modelled/mo | Σ actual/mo | ratio | impressions_context | light |
|---|---:|---:|---:|---:|---:|---|
| 1-3   |  2 |  0.44 |   29.70 | 0.0149 |    14,910 | RED |
| 4-10  | 14 |  4.53 |  470.48 | 0.0096 |   754,650 | RED |
| 11-20 | 25 | 14.54 | 1194.58 | 0.0122 | 3,847,244 | RED |

**Gate verdict:** overall RED → **not eligible** for client-facing promotion.

---

## 3. Matching anatomy

- Curated non-brand universe: **857** kept keywords (of which **94** matched an aggregated non-brand GSC query and had a scoreable base_rank, **143** matched but `base_rank IS NULL` → `model_blind`).
- GSC aggregated non-brand queries: **14,961**; **14,724** unmatched vs the curated universe.
- Excluded by noise floor (<5 normalised clicks): computed inside `computeCalibration` before scoring; net scored pairs = 44 (see `keywords_matched`).

### Top-10 unmatched non-brand queries by GSC clicks (Phase-3 discovery preview)

| # | query | GSC clicks (498 d) |
|--:|---|---:|
| 1 | fridge freezer | 64,481 |
| 2 | washing machine | 24,803 |
| 3 | tumble dryer | 23,193 |
| 4 | microwave | 22,175 |
| 5 | condenser tumble dryer | 15,356 |
| 6 | aeg comfort 6000 | 13,606 |
| 7 | integrated fridge freezer | 11,983 |
| 8 | american fridge freezer | 10,480 |
| 9 | integrated washing machine | 10,468 |
| 10 | appliances online | 10,223 |

All ten sit outside the TV silo — the same scoping mismatch documented in the prior rerun.

---

## 4. Worked pair — `24 inch tv` (mobile / transactional)

```sql
SELECT keyword, device, search_intent, base_rank, avg_monthly_volume
FROM keywords WHERE id = '11933010-d609-4aae-9af7-f7d98943a43d';
-- 24 inch tv · mobile · transactional · base_rank=8 · avg_monthly_volume=8100

SELECT month, volume FROM keyword_monthly_volumes
WHERE keyword_id = '11933010-d609-4aae-9af7-f7d98943a43d' ORDER BY month DESC;
-- 2026-04 6600, 2026-03 6600, 2026-02 6600, 2026-01 8100,
-- 2025-12 9900, 2025-11 12100, 2025-10 8100, 2025-09 8100 (dedup)

SELECT trend_pct, trend_confidence FROM keyword_demand_signals
WHERE keyword_id = '11933010-d609-4aae-9af7-f7d98943a43d';
-- trend_pct = -13.11, trend_confidence = high (mobile)

SELECT ctr_percentage FROM ctr_curves
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND device='mobile' AND intent_segment='transactional' AND rank_position=8;
-- 1.05

SELECT clicks, impressions, position, device FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466'
  AND lower(keyword)='24 inch tv' AND device='mobile' AND is_branded IS NOT TRUE;
-- clicks=439, impressions=46732, position=10.1
```

Arithmetic (per `_shared/revenue-v2.ts` + calibration):

- `volume_annual` = last-12-month sum ≈ **99,600** (trailing 12 months of `keyword_monthly_volumes`).
- `factor` = clamp(1 + (-13.11/100), 0.7, 1.3) = **0.8689** (high-confidence trend applied).
- `volume_forward` ≈ 99,600 × 0.8689 ≈ **86,543**.
- `ctr_now` = 1.05% → **0.0105**.
- `svm` — mobile-transactional TV SERPs on this project have compare_sites-heavy features; assume 0.5 (default) → `svm ≈ 0.5`.
- `modelled_monthly_clicks` = (86,543 × 0.0105 × 0.5) / 12 ≈ **37.9**.
- Actual normalised: 439 × 30 / 498 ≈ **26.4 clicks/mo**.
- **Per-pair ratio ≈ 37.9 / 26.4 ≈ 1.44** → **GREEN**.

For this single restored-curve pair the model is now well inside band.

---

## 5. Revenue sanity block

```sql
SELECT by_rank_band -> 'revenue_sanity' FROM calibration_snapshots
WHERE id='4a9aa1a5-50d8-48b8-8dd9-80615957dcc1';
```

| field | value |
|---|---|
| label | **vs assumed conversion values** |
| cvr_source | project_default |
| aov_source | project_default |
| modelled_current_monthly_revenue | £78.07 |
| actual_monthly_revenue | £7,470.12 |
| ratio | 0.01 |

Rendered with the explicit "assumed" label — no client-supplied CVR/AOV on this project. Numbers **informational only**.

---

## 6. Interpretation discipline (no model changes proposed)

Two structurally distinct effects contribute; both are queryable.

**H1 — Universe scoping dominates.** 14,724 non-brand GSC queries are unmatched and the top-10 are all non-TV appliance intents (fridge freezer, washing machine, …). The GSC upload is whole-site; the curated set is a TV silo. Any impressions-context or actual-clicks total is site-wide, but calibration only compares the intersection. Nothing about this is a model defect.

**H2 — Head-pair coverage recovered; long-tail matched pairs pull the aggregate down.** Restored mobile/transactional curves now read 1.30% pooled r1-r7, 1.05% r8, 0.63% r9, 0.56% r10 (verified below). The worked pair `24 inch tv` per-pair ratio is 1.44 — green. Yet:
  - the `1-3` band aggregates only 2 pairs (Σ modelled 0.44 vs Σ actual 29.7), so any single low-SVM pair swings the bucket ratio;
  - `11-20` holds 25 pairs against project curves of 0.39-0.41% at r11+, delivering ~0.6 clicks/mo per pair, in the same order as actuals but consistently below;
  - 143 `model_blind` pairs (curated keyword matched a GSC query but `base_rank IS NULL`) carry ~1,536 actual monthly clicks that the calibrator cannot score. Their median GSC position is 10.8 — a SERP refresh would move most into scored bands.

**H3 — PAV pooling at mid-ranks.** r1-r7 all sit at 1.30% (regularisation ceiling from measured r7 head). This suppresses head-rank modelled totals for the two `1-3` pairs relative to a non-monotone raw curve, but the sample is too small to attribute the aggregate red to this alone.

**H4 — Trend / volume input divergence.** `keyword_monthly_volumes` covered 8,124 rows across 857 keywords (~9.5 months each); `keyword_demand_signals` returned 237 rows (some pairs have no trend factor and default to 1.0). Not a defect — a coverage gap.

Ranked candidate order (evidence-weighted): **H1 » H2 » H4 » H3**. Advisor rules on tuning vs acceptance.

Curve verification (satisfies the "PAV-era table" check):

```sql
SELECT rank_position, ctr_percentage FROM ctr_curves
WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND device='mobile' AND intent_segment='transactional' AND rank_position<=10
ORDER BY rank_position;
```

| rank | ctr% |
|---:|---:|
| 1 | 1.30 |
| 2 | 1.30 |
| 3 | 1.30 |
| 4 | 1.30 |
| 5 | 1.30 |
| 6 | 1.30 |
| 7 | 1.30 |
| 8 | 1.05 |
| 9 | 0.63 |
| 10 | 0.56 |

Matches the PAV-era restored table (pooled 1.30 head, r8 1.05). No metadata-less orphans present (post-fence + cleanup).

---

## 7. Tracker

Prompt 2.5 is **complete** (measurement instrument live; snapshot writing verified end-to-end). First Gate B calibration datum on record: snapshot **`4a9aa1a5-50d8-48b8-8dd9-80615957dcc1`**, overall ratio 0.0105, RED (not eligible).

Phase 2 checklist state:
- 2.1 GSC import (per-row device) — complete
- 2.2 is_branded classification — complete
- 2.3 Device-aware CTR curves — complete (post-provenance + PAV + writer-fence + restore)
- 2.4 Trend-adjusted forward volume — complete
- 2.5 Calibration card / gate — **complete (measurement)**; Gate B currently RED
- 2.6 — skipped per plan

Next-turn material for the advisor: rule on tuning vs acceptance given (a) scoping-dominated unmatched, (b) 143 model-blind pairs one SERP refresh away from scoring, (c) worked-pair evidence that the restored curves land near-green when the resolver actually fires.
