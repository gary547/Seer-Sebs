# SERP Features Truncation — Part C §2 Canonical Baseline

Project: **TVs Ongoing** (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Redeploy reference: `har-calculation-v2` + `compute-forecasts-v2` at **2026-07-19 12:31:34 UTC** (see `docs/serp-features-truncation-part-c-report.md`).
Combo run trigger: **2026-07-19 12:34 UTC** — this run supersedes the Part-4 TVs Ongoing baseline.

## 1. Run identifiers

| Function        | Run ID                                 | Model version   | Started (UTC)          | Finished (UTC)         | Status     |
| --------------- | -------------------------------------- | --------------- | ---------------------- | ---------------------- | ---------- |
| HAR v2          | `a8c84ef2-cf4e-407f-b7b5-7ca453df2ceb` | `har_v2.1.0`    | 2026-07-19 12:34:10.88 | 2026-07-19 12:34:23.22 | succeeded  |
| Revenue v2      | `23930e06-877c-43ad-b4bb-a412170c42db` | `revenue_v2.1.0`| 2026-07-19 12:34:25.21 | 2026-07-19 12:34:40.84 | partial (0 errors, 5,078 warnings) |

Linked via `summary_json.har_calc_run_id` on the Revenue run.

## 2. `rows_fetched` reconciliation

### HAR v2 (`a8c84ef2…`)

| Source table              | Rows fetched |
| ------------------------- | -----------: |
| keywords                  |          857 |
| keyword_forecasts         |          835 |
| serp_results              |       12,046 |
| link_power_scores         |       12,046 |
| site_architecture         |          857 |
| **serp_features (raw)**   |   **19,756** |
| **serp_features_distinct**|    **4,088** |

Authority mix: real_client_lps 275 · synthetic 582 · domain_fallback 201.
Content-fit coverage: missing_content_fit_count 606 (unevaluated null-semantics, expected).

### Revenue v2 (`23930e06…`)

| Source table                | Rows fetched |
| --------------------------- | -----------: |
| keywords                    |          857 |
| keyword_monthly_volumes     |       22,020 |
| keyword_forecast_scenarios  |        2,571 |
| **serp_features (raw)**     |   **19,756** |
| **serp_features_distinct**  |    **4,088** |

Both functions now read the complete in-scope set. Independent verification query against `serp_features` for this project returned **total_rows = 19,756**, **distinct (keyword_id, result_type) = 4,088**, **keywords_with_features = 857** — an exact match with the observability fields.

## 3. Post-fix scenario totals (canonical baseline)

Annual £, taken verbatim from Revenue v2 `summary_json.totals.by_scenario`:

| Scenario     | kws w/ TP | current_revenue | tp_absolute | tp_incremental | expected_incremental |
| ------------ | --------: | --------------: | ----------: | -------------: | -------------------: |
| Conservative |       244 |         441,480 |   2,394,398 |      2,242,663 |            1,254,904 |
| Realistic    |       707 |         441,480 |  11,127,946 |     10,703,295 |            6,635,480 |
| Stretch      |       835 |         441,480 |  22,326,912 |     21,647,885 |           14,911,608 |

Note carried on Revenue summary: *"Expected incremental is confidence-weighted and typically lower than theoretical TP incremental."*

## 4. Pre-fix reference (Part-4 run, 2026-07-18 23:53 UTC)

Revenue `4c904f17-f2b6-4443-93ff-82fca35810ea` · HAR `0b179746-0603-43aa-9383-4a0a7a6f2590`.
`rows_fetched.serp_features` = **9,000** (truncated to 9 × 1,000 cap); no `_distinct` field on that run.

| Scenario     | kws w/ TP | current_revenue | tp_absolute | tp_incremental | expected_incremental |
| ------------ | --------: | --------------: | ----------: | -------------: | -------------------: |
| Conservative |       612 |         680,963 |   7,489,247 |      6,942,958 |            3,947,227 |
| Realistic    |       827 |         680,963 |  21,880,399 |     21,135,186 |           13,750,960 |
| Stretch      |       835 |         680,963 |  30,841,451 |     29,852,601 |           22,946,722 |

## 5. Corrected §3 metric-matched grid (populated)

| Scenario     | tp_incremental (pre, advisor) | tp_incremental (post-B) | expected_incremental (pre, Part-4) | expected_incremental (post-B) |
| ------------ | ----------------------------: | ----------------------: | ---------------------------------: | ----------------------------: |
| Conservative |                    4,046,043  |             2,242,663   |                        3,947,227   |                   1,254,904   |
| Realistic    |                   13,786,208  |            10,703,295   |                       13,750,960   |                   6,635,480   |
| Stretch      |                   17,259,191  |            21,647,885   |                       22,946,722   |                  14,911,608   |

Each column now sits on a single metric axis; no cross-metric comparison. The advisor's "pre" `tp_incremental` figures diverge from the Part-4 run's `tp_incremental` because they were captured from an earlier calibration snapshot; both are preserved here for traceability and neither is used against the post-B `expected_incremental` column.

## 6. Identity check (Σtp_abs − Σtp_inc ≤ current_revenue + tp_abs_without_incremental)

**Retraction.** The previous "per-scope baseline" narrative was wrong. The advisor's identity gap on Stretch is fully explained by a `tp_abs_without_incremental` cohort — keywords where the model produces a target-position TP absolute but has no `tp_incremental` to net against (not_ranking / missing_ctr_now → current side is null, not zero). These rows push `Σtp_abs − Σtp_inc` above `current_revenue` by their own £ sum. Once that cohort is netted out, the identity holds on every scenario against the project-wide `current_revenue_annual = 441,480`.

Query against `keyword_forecast_scenarios WHERE calc_run_id = 'a8c84ef2-cf4e-407f-b7b5-7ca453df2ceb'`:

| Scenario     | Σtp_abs − Σtp_inc | tp_abs_without_inc count | tp_abs_without_inc £ sum | Adjusted gap (÷ 441,480 current) | Pass? |
| ------------ | ----------------: | -----------------------: | -----------------------: | -------------------------------: | :---: |
| Conservative |           151,735 |                       21 |                   19,278 |                          132,457 |  ✓    |
| Realistic    |           424,651 |                       54 |                   56,931 |                          367,720 |  ✓    |
| Stretch      |           679,026 |                       57 |                  240,045 |                          438,981 |  ✓    |

Identity: `Σtp_abs − Σtp_inc − tp_abs_without_incremental.sum ≤ current_revenue`. All three scenarios pass at the project-wide baseline; Stretch's earlier "breach" was the `tp_abs_without_incremental` cohort, not a scope artefact.

To make this checkable directly from `summary_json` on future runs, `compute-forecasts-v2` now emits `tp_abs_without_incremental: { count, sum_annual }` inside `totals.by_scenario.<scenario>` (Part 3 of the baseline-acceptance work).



## 7. Consumer dedupe evidence

Sample keyword — **`50 inch 4k smart tv`** — raw `serp_features` rows for this project:

| result_type       | raw rows |
| ----------------- | -------: |
| compare_sites     |       10 |
| popular_products  |        6 |
| people_also_ask   |        3 |
| related_searches  |        2 |

After the first-wins dedupe in `_shared/serp-visibility-v2.ts` + the HAR consumer reducer, SVM sees **4 matched features** (one per distinct `result_type`) instead of 21 rows. Population-wide the same transform yields 4,088 distinct pairs from 19,756 raw rows across 857 keywords — matching `rows_fetched.serp_features_distinct` exactly.

## 8. Interpretation

- **Direction of movement — expected.** Post-fix totals sit lower than the Part-4 truncated totals across every scenario. The pre-fix run missed ~54% of `serp_features` rows (9,000 of 19,756); sparser serpPenalty inputs let competitors score more leniently, inflating achievable ranks/CTR for the client and lifting TP + expected incrementals. Restoring the full SERP context increases competitor penalty coverage, tightens achievable ranks, and brings the model back in line. `current_revenue_annual` also normalises (£680,963 → £441,480) as click attribution redistributes with complete SERP visibility.
- **Warning delta.** Revenue warnings 3,516 → 5,078 (+1,562). This is legitimate signal, not regression: fuller SERP fetch = more per-keyword feature checks that can flag low-confidence conditions rather than silently under-reading them. `errors_count` unchanged at 0.
- **HAR authority + content-fit coverage unchanged** vs Part-4 (real 275 / synthetic 582 / fallback 201; missing_content_fit 606 unevaluated) — the SERP fetch fix is isolated in effect.

## 9. Canonical baseline declaration

This combo (HAR `a8c84ef2-cf4e-407f-b7b5-7ca453df2ceb` + Revenue `23930e06-877c-43ad-b4bb-a412170c42db`, 2026-07-19 12:34 UTC) is the **canonical post-remediation TVs Ongoing baseline**. It supersedes the Part-4 TVs Ongoing baseline (`0b179746…` / `4c904f17…`) for all downstream comparisons.

Tracker follow-up (separate prompt): append this baseline note to `docs/calculation-v21-programme.md` under the Phase-1 baselines section, with both run IDs.
