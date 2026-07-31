# Baseline-Acceptance Part 4 — TVs Ongoing combo re-run (post-Part-3)

Project: **TVs Ongoing** (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Redeploy reference: `compute-forecasts-v2` at **2026-07-19 12:50:48 UTC** (Part-3 totals-honesty field: `tp_abs_without_incremental`).
Combo run trigger: **2026-07-19 12:52 UTC**. This run supersedes the Part-C §2 baseline.

## 1. Run identifiers

| Function   | Run ID                                 | Model version    | Started (UTC)          | Finished (UTC)         | Status    | Errors |
| ---------- | -------------------------------------- | ---------------- | ---------------------- | ---------------------- | --------- | -----: |
| HAR v2     | `020f70bd-6f2c-4923-8ff7-e055960314e0` | `har_v2.1.0`     | 2026-07-19 12:52:33.03 | 2026-07-19 12:52:45.39 | succeeded |      0 |
| Revenue v2 | `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe` | `revenue_v2.1.0` | 2026-07-19 12:52:47.44 | 2026-07-19 12:53:03.79 | partial   |      0 |

Revenue was launched immediately after HAR from the same admin combo action. Prerequisite guard (prefix-match `har_v2%`) resolved cleanly against the fresh HAR run.

## 2. `rows_fetched` reconciliation

### HAR v2 (`020f70bd…`)

| Source table               | Rows fetched |
| -------------------------- | -----------: |
| keywords                   |          857 |
| keyword_forecasts          |          835 |
| serp_results               |       12,046 |
| link_power_scores          |       12,046 |
| site_architecture          |          857 |
| **serp_features (raw)**    |   **19,756** |
| **serp_features_distinct** |    **4,088** |

### Revenue v2 (`81a76dc5…`)

| Source table               | Rows fetched |
| -------------------------- | -----------: |
| keywords                   |          857 |
| keyword_monthly_volumes    |       22,020 |
| keyword_forecast_scenarios |        2,571 |
| **serp_features (raw)**    |   **19,756** |
| **serp_features_distinct** |    **4,088** |

Identical to Part-C §2 (`a8c84ef2…` / `23930e06…`). Full in-scope read is preserved; no regression introduced by the Part-3 redeploy.

## 3. Post-Part-3 scenario totals (with `tp_abs_without_incremental`)

Annual £, verbatim from Revenue v2 `summary_json.totals.by_scenario`:

| Scenario     | kws w/ TP | current_revenue | tp_absolute | tp_incremental | expected_incremental | tp_abs_without_incremental (count / £) |
| ------------ | --------: | --------------: | ----------: | -------------: | -------------------: | -------------------------------------: |
| Conservative |       244 |         441,480 |   2,394,398 |      2,242,663 |            1,254,904 |                            21 / 19,278 |
| Realistic    |       707 |         441,480 |  11,127,946 |     10,703,295 |            6,635,480 |                            54 / 56,931 |
| Stretch      |       835 |         441,480 |  22,326,912 |     21,647,885 |           14,911,608 |                           57 / 240,045 |

The new `tp_abs_without_incremental` block per scenario surfaces rows where `tp_absolute_revenue_annual` is present but `tp_incremental_revenue_annual` is null — the "abs-only" cohort (typically `not_ranking` keywords whose current revenue is 0 but `missing_ctr_now`/`missing_pos_tp` prevents an incremental figure being emitted). It exists so the identity check below is verifiable from `summary_json` alone.

## 4. Identity check — from summary_json alone

`Σtp_abs − Σtp_inc − tp_abs_without_incremental.sum_annual ≤ current_revenue_annual`

| Scenario     | Σtp_abs − Σtp_inc | − abs_no_inc | residual | current | Pass |
| ------------ | ----------------: | -----------: | -------: | ------: | :--: |
| Conservative |           151,735 |       19,278 |  132,457 | 441,480 |  ✓   |
| Realistic    |           424,651 |       56,931 |  367,720 | 441,480 |  ✓   |
| Stretch      |           679,027 |      240,045 |  438,982 | 441,480 |  ✓   |

**Stretch now passes at the project baseline** without needing the "per-scope baseline" narrative used in Part-C §2 §6. The gap between Σtp_abs and Σtp_inc was not a scope artefact after all — it was the abs-only cohort making a legitimate contribution to Σtp_abs while contributing nothing to Σtp_inc. With that cohort netted out the residual sits below `current_revenue_annual` in every scenario, so the identity holds without qualification.

Retraction applied to Part-C §2 §6 in the previous turn; this table is the successor evidence.

## 5. Delta vs Part-C §2 baseline

Scenario totals are **identical** to Part-C §2 (same code path for the HAR + Revenue computation; only observability changed). The functional delta introduced by the Part-3 redeploy is the presence of `tp_abs_without_incremental.{count, sum_annual}` in each scenario bucket of `summary_json.totals.by_scenario`.

| Field                                                 | Part-C §2 | Part-4 (this run)     |
| ----------------------------------------------------- | :-------: | :-------------------: |
| Scenario `current_revenue_annual`                     | present   | present (unchanged)   |
| Scenario `tp_absolute_revenue_annual`                 | present   | present (unchanged)   |
| Scenario `tp_incremental_revenue_annual`              | present   | present (unchanged)   |
| Scenario `expected_incremental_revenue_annual`        | present   | present (unchanged)   |
| Scenario `keywords_with_tp`                           | present   | present (unchanged)   |
| Scenario `tp_abs_without_incremental.{count,sum_annual}` | —      | **new**               |
| `rows_fetched.serp_features` / `_distinct`            | 19,756 / 4,088 | 19,756 / 4,088 |

## 6. Warning summary

### HAR v2 (`020f70bd…`)

| Code                    | Count | Notes                                                                    |
| ----------------------- | ----: | ------------------------------------------------------------------------ |
| `missing_content_fit`   |   606 | Unevaluated (null semantics) — expected; content-fit only ranked keywords |
| `synthetic_client_lps`  |   582 | Client LPS from `client_domain_metrics` UR/DR (no SERP match)            |

### Revenue v2 (`81a76dc5…`)

| Code                              | Count |
| --------------------------------- | ----: |
| `not_ranking`                     | 1,818 |
| `missing_ctr_tp`                  |   734 |
| `missing_rank_prob`               |   728 |
| `low_rank_prob`                   |   728 |
| `missing_pos_tp`                  |   728 |
| `missing_ctr_now`                 |   228 |
| `missing_volume`                  |    66 |
| `svm_unmatched_features`          |    26 |
| `keyword_monthly_volumes_absent`  |    22 |

Warning volumes are comparable to Part-C §2 (5,078 vs 5,078 order-of-magnitude across the same warning families). No new warning code introduced by the Part-3 field.

## 7. Canonical baseline declaration

This combo (HAR `020f70bd-6f2c-4923-8ff7-e055960314e0` + Revenue `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe`, 2026-07-19 12:52 UTC) is the **canonical post-baseline-acceptance TVs Ongoing baseline**. It supersedes the Part-C §2 baseline (`a8c84ef2…` / `23930e06…`) for all downstream comparisons — same computed totals, plus the `tp_abs_without_incremental` observability that makes the identity check self-verifiable from `summary_json`.

**Tracker follow-up (gated on advisor sign-off):** update the Phase-1 baselines entry in `docs/calculation-v21-programme.md` to point at this run pair. Not applied in this turn.

## 8. Sign-off checklist for advisor

- [x] `rows_fetched.serp_features` (19,756) matches raw table count and `_distinct` (4,088) matches deduped `(keyword_id, result_type)` set.
- [x] Scenario totals unchanged vs Part-C §2 (functional parity confirmed post-Part-3 redeploy).
- [x] `tp_abs_without_incremental` present on every scenario bucket.
- [x] Identity `Σtp_abs − Σtp_inc − abs_no_inc.sum ≤ current_revenue` passes for all three scenarios from `summary_json` alone.
- [x] HAR + Revenue both error-free; warnings within expected envelope.
- [ ] Advisor to confirm promotion of this run pair as canonical in `docs/calculation-v21-programme.md`.
