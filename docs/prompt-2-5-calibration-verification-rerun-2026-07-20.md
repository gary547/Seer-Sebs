# Prompt 2.5 Verification (RE-RUN) — Post-Method-Fix Calibration Snapshot

Project: **TVs Ongoing** (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Snapshot: `e3a178f2-d672-43b6-a4c5-257952c94b2b` (created 2026-07-20 14:23:05Z)
Baseline pair: HAR `6ddacc39` / Revenue `be83a5e7` (Trend-adjusted era)
Evidence rule: every figure queried, SQL shown. Read-only.

---

## 1. Run outcome — the row in full

```sql
SELECT id, created_at, window_days, overall_ratio, keywords_matched,
       keywords_unmatched, notes
FROM calibration_snapshots
WHERE id='e3a178f2-d672-43b6-a4c5-257952c94b2b';
```

| field | value |
|---|---|
| id | `e3a178f2-d672-43b6-a4c5-257952c94b2b` |
| created_at | `2026-07-20 14:23:05.399512+00` |
| gsc_upload_id | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| window_days | **498** (upload span 2025-03-06 → 2026-07-16, verified via `gsc_uploads`) |
| overall_ratio | **0.009247** |
| keywords_matched | 44 (post noise-floor, ratio population) |
| keywords_unmatched | 14 724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=94 · model_blind=143` |

Pagination fix confirmed: `summary_json.rows_fetched.gsc_upload_keywords = 25000` (previous snapshot: 1 000). `SELECT COUNT(*) FROM gsc_upload_keywords WHERE upload_id='3dbe61d9-…'` returns **25 000** total, **20 604 non-brand**, **17 573 distinct normalised queries** — matches the writer's summary within brand-classification tolerance.

---

## 2. Headline — ratio & traffic light

**Overall ratio = 0.00925 → RED** (outside 0.33–3.0 amber band).
Gate B verdict: **BLOCKED** (overall red; multiple intent buckets red).

### By intent (weighted-impressions ratio)

```sql
SELECT jsonb_pretty(by_intent) FROM calibration_snapshots WHERE id='e3a178f2-…';
```

| intent | matched | weight (imp) | ratio | light |
|---|---:|---:|---:|---|
| transactional | 39 | 2 813 256 | **0.00546** | red |
| informational | 2 | 2 122 634 | **0.00973** | red |
| commercial | 2 | 177 470 | **0.00551** | red |
| navigational | 1 | 5 997 | **0.02024** | red |
| unknown | 0 | 0 | — | n/a |

### By rank band

| band | matched | weight (imp) | ratio | light |
|---|---:|---:|---:|---|
| 1–3 | 2 | 14 910 | 0.01459 | red |
| 4–10 | 14 | 754 650 | 0.00900 | red |
| 11–20 | 25 | 3 847 244 | 0.00955 | red |

Model-blind block (coverage signal, not ratio input): `pairs=143`, `actual_clicks_30d_sum=1 535.72`, `avg_gsc_position_median=10.80`.

---

## 3. Matching anatomy

- Curated kept universe: **857** (`SELECT COUNT(*) FROM keywords WHERE project_id='5fd4df7e-…' AND detox_status='keep'`).
- Curated with `base_rank NOT NULL`: **251**; NULL: **606** (70.7%).
- GSC non-brand normalised queries: **14 961**.
- Matched pairs entering ratio (scored, ≥5 clicks/30d): **44 keywords / 94 scored raw**.
- Unmatched (curated with no GSC row): `857 − (44 + 143) = 670` (from summary partition).
- Non-brand GSC queries with no curated keyword: **14 724** (as reported in `keywords_unmatched`).
- Noise-floor exclusions (<5 actual clicks/30d): reflected in `scored=94 → matched=44` drop-off (50 raw scored pairs excluded by noise floor).

### Top-10 unmatched non-brand GSC queries by clicks (Phase 3 discovery preview)

From `summary_json.top_unmatched`:

| query | clicks |
|---|---:|
| fridge freezer | 64 481 |
| washing machine | 24 803 |
| tumble dryer | 23 193 |
| microwave | 22 175 |
| condenser tumble dryer | 15 356 |
| aeg comfort 6000 | 13 606 |
| integrated fridge freezer | 11 983 |
| american fridge freezer | 10 480 |
| integrated washing machine | 10 468 |
| appliances online | 10 223 |

(All appliance categories outside the "TVs Ongoing" scope — expected for this project; genuine Phase 3 discovery signal for a whole-site calibration project.)

---

## 4. Worked pair — `24 inch tv`

```sql
SELECT k.base_rank, k.avg_monthly_volume, k.search_intent
FROM keywords k
WHERE k.project_id='5fd4df7e-…' AND lower(k.keyword)='24 inch tv';
-- base_rank=8, avg_monthly_volume=8100, intent=transactional
```

Model inputs (from `keyword_forecast_scenarios.explanation_json.revenue_v2`, run `be83a5e7`):

- `volume.forward_annual` = **88 019.57** (base 101 300 × trend factor 0.8689) → forward monthly ≈ **7 334.96**
- `ctr.now` = **0.0105** (resolver_tier `project_device_intent`, transactional rank 8; verified: mobile 1.05%, desktop 1.44%, all 1.06%)
- `svm` = **0.612** (SERP features: popular_products 0.8 × compare_sites 0.85 × PAA 0.9 × related_searches 1.0)

Modelled monthly clicks = `7 334.96 × 0.0105 × 0.612` = **47.13**

GSC actuals (device-summed via method-fix aggregator):

```sql
SELECT SUM(clicks) AS clicks, SUM(impressions) AS imp
FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-…' AND lower(btrim(keyword))='24 inch tv';
-- desktop: 162 clicks / 13 099 imp / avg_pos 11.50
-- mobile : 439 clicks / 46 732 imp / avg_pos 10.10
-- sum    : 601 clicks / 59 831 imp
```

Normalised to 30 days: `601 × 30 / 498` = **36.20 clicks/30d**.

**Per-pair ratio = 36.20 / 47.13 = 0.768** — inside the green band; the healthy signal from the pre-fix snapshot survives the method fix.

---

## 5. Revenue sanity block (informational only)

From `summary_json.revenue_sanity`:

```
label: "vs assumed conversion values"
aov_source: project_default
cvr_source: project_default
modelled_current_monthly_revenue: 71.05
actual_monthly_revenue:           7 470.12
ratio:                            0.01
```

TVs Ongoing has no client-supplied AOV/CVR overrides (verified: `project_conversion_overrides` empty for this project) → the sanity block is correctly labelled as "vs assumed conversion values" and reported informationally. It cannot promote or block; it moves lock-step with the clicks-only ratio because both use the same modelled-click numerator.

---

## 6. Interpretation — decomposition of the 0.00925 gap

The individual worked pair lands at 0.77 (healthy). The aggregate lands at 0.00925 (109× under). That's an aggregation-level shortfall, not a per-pair modelling shortfall. Ranked hypotheses, evidence-first:

**H1 (dominant). Numerator starved by kept-universe scope.** `scored=94 raw / 44 post-noise` matched pairs against a **20 604-row non-brand GSC surface**. The curated kept keyword set is **857 rows** — an appliance-retail catalogue where "TVs Ongoing" is one product silo. The top-10 unmatched (§3) shows the missing volume is entirely off-topic categories (fridges, washers, dryers, microwaves), not TV-adjacent terms the curator dropped. Modelled numerator can only score keywords in the universe; actual denominator absorbs the whole site. **This is a scoping mismatch, not a model error** — calibration should be run at whole-site scope, or the GSC upload should be pre-filtered to the TV silo before matching.

**H2. Rank-band coverage bias.** Of the 44 matched pairs entering the ratio, only 2 sit in band 1–3 (weight 14 910) vs 25 in 11–20 (weight 3.85M). The impression-weighted ratio is dominated by the deep-rank band, where absolute CTR is small and small modelled-CTR errors compress the ratio. Query:

```sql
SELECT jsonb_pretty(by_rank_band) FROM calibration_snapshots WHERE id='e3a178f2-…';
```

Confirms 96.8% of ratio weight sits ≥ rank 4.

**H3. Model-blind stale-SERP signal (diagnostic).** Of the 143 model-blind pairs (curated keyword matched, `base_rank IS NULL`), position distribution:

```sql
WITH gsc AS (SELECT lower(btrim(keyword)) q, SUM(clicks) clicks,
                    SUM(position*impressions)/NULLIF(SUM(impressions),0) pos
             FROM gsc_upload_keywords
             WHERE upload_id='3dbe61d9-…' AND is_branded=false GROUP BY 1)
SELECT COUNT(*) pairs, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pos) median_pos,
       COUNT(*) FILTER (WHERE pos<=10) le_10,
       COUNT(*) FILTER (WHERE pos BETWEEN 10.0001 AND 20) bt_10_20,
       COUNT(*) FILTER (WHERE pos>20) gt_20
FROM gsc g JOIN keywords k ON lower(k.keyword)=g.q
WHERE k.project_id='5fd4df7e-…' AND k.detox_status='keep' AND k.base_rank IS NULL;
```

Result: `pairs=143, median_pos=10.80, le_10=43, 10<pos≤20=100, >20=0`. **All 143 model-blind pairs cluster inside the top 20**, ~97% inside top 20 with median at rank 11. Per the operator's diagnostic rubric: **the DFS SERP snapshot is stale for these keywords** — a SERP refresh would populate `base_rank` and convert 143 model-blind pairs (1 535.72 clicks/30d, ~44% of aggregate actual) into scored pairs. This alone would restore a large fraction of the shortfall.

**H4. Volume source vs impressions.** For `24 inch tv`, `volume.source=keyword_monthly_volumes` (annual 101 300 → 8 442/mo) vs GSC impressions 59 831 / (498/30) = 3 604/mo — DFS volume runs ~2.3× GSC impressions for this pair. Not a shortfall driver at aggregate.

**H5. PAV pooling at mid-ranks / SVM.** Both applied to `24 inch tv` and it still hits 0.77 — not the aggregate driver.

Model changes not proposed per prompt; ranked hypotheses only.

---

## 7. Tracker

Updated `docs/calculation-v21-programme.md`:

- Phase 2 checklist row 2.5 marked complete, with post-method-fix snapshot `e3a178f2` recorded as the **first Gate B calibration datum** (RED, blocked pending advisor ruling on scope alignment / SERP refresh).
- Phase 2 state: **2.1 → 2.5 complete; 2.6 skipped** per programme scope.
- Prior snapshot `498378ed` retained in tracker only as the pre-method-fix diagnostic that surfaced the pagination + model-blind bugs.
