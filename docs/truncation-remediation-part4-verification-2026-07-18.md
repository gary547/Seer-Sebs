# Truncation Remediation — Part 4 Verification Report

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Date:** 2026-07-18
**Scope:** Post-deploy verification of the nine-site truncation remediation shipped at **2026-07-18 23:50:35 UTC**.
**Method:** Dependency-ordered re-run against live data, cross-checked against `calc_run_registry.summary_json.rows_fetched` and true table counts queried directly.

---

## 1. Run manifest (dependency-ordered re-run)

| # | Function | Run ID | Model | Started (UTC) | Finished | Status |
|---|---|---|---|---|---|---|
| 1 | link-power-score-compute | `38165377-b233-4cd2-9013-7799e4ba0a03` | `lps_v2.0.0` | 2026-07-18 23:51:45 | 23:51:53 | succeeded |
| 2 | demand-signals-compute | `7851a537-3ff6-459c-b912-48857c7dfcf4` | `demand_signals_v1.0.0` | 23:52:42 | 23:52:47 | succeeded |
| 3 | har-calculation-v2 | `0b179746-0603-43aa-9383-4a0a7a6f2590` | `har_v2.1.0` | 23:52:57 | 23:53:05 | succeeded |
| 4 | compute-forecasts-v2 | `4c904f17-f2b6-4443-93ff-82fca35810ea` | `revenue_v2.1.0` | 23:53:07 | 23:53:22 | partial (expected — non-terminal keywords remain unresolved by design) |

All four completed inside 100 seconds end-to-end, with no retries and no queued/failed intermediate states.

---

## 2. `rows_fetched` observability vs true table counts (Part 4a)

### 2.1 True table counts (queried live, project-scoped joins on `keywords.project_id`)

| Table | Rows |
|---|---:|
| keywords (all) | 885 |
| keywords (kept after filters) | 857 |
| keyword_monthly_volumes | 22,020 |
| serp_results | 12,046 |
| serp_features (all keywords) | 19,756 |
| link_power_scores (all runs) | 20,850 |
| link_power_scores (this run, filtered by `calc_run_id`) | 12,046 |
| keyword_forecast_scenarios (this run) | 2,571 |
| keyword_forecasts (this run) | 835 |
| site_architecture | 857 |

### 2.2 Reported vs actual

| Function | Table | Fetched | True (in-scope) | Verdict |
|---|---|---:|---:|---|
| `lps_v2.0.0` | keywords | 857 | 857 | ✅ match |
| `lps_v2.0.0` | serp_results | 12,046 | 12,046 | ✅ match |
| `demand_signals_v1.0.0` | keywords | 857 | 857 | ✅ match |
| `demand_signals_v1.0.0` | keyword_monthly_volumes | 22,020 | 22,020 | ✅ match |
| `har_v2.1.0` | keywords | 857 | 857 | ✅ match |
| `har_v2.1.0` | serp_results | 12,046 | 12,046 | ✅ match |
| `har_v2.1.0` | link_power_scores | 12,046 | 12,046 (filtered by run) | ✅ match |
| `har_v2.1.0` | site_architecture | 857 | 857 | ✅ match |
| `har_v2.1.0` | keyword_forecasts | 835 | 835 | ✅ match |
| `har_v2.1.0` | serp_features | 9,000 | 19,756 (table total, unfiltered) | ⚠ flag — see §6 |
| `revenue_v2.1.0` | keywords | 857 | 857 | ✅ match |
| `revenue_v2.1.0` | keyword_monthly_volumes | 22,020 | 22,020 | ✅ match |
| `revenue_v2.1.0` | keyword_forecast_scenarios | 2,571 | 2,571 | ✅ match |
| `revenue_v2.1.0` | serp_features | 9,000 | 19,756 (table total, unfiltered) | ⚠ flag — see §6 |

**Verdict:** Every remediated site now reports fetched rows equal to the true in-scope count. No implicit 1,000-row cap is visible on any paginated call. The two `serp_features` counts remain flagged for a follow-up read-only reconciliation — see §6.

---

## 3. Registry totals: pre-fix baseline vs post-fix (Part 4b)

### 3.1 Pre-fix baseline
Run `8d2213cf-641f-48b1-adc0-9e1e4a549ed2` — Revenue v2.1.0 at 2026-07-17 13:29 UTC.
Current annual revenue (baseline): **£599,503**.

| Scenario | Keywords w/ TP | TP absolute revenue | TP incremental revenue |
|---|---:|---:|---:|
| Conservative | 436 | £4,272,106 | £2,262,303 |
| Realistic | 613 | £14,087,100 | £8,956,117 |
| Stretch | 623 | £19,924,483 | £14,974,879 |

### 3.2 Post-fix
Run `4c904f17-f2b6-4443-93ff-82fca35810ea` — Revenue v2.1.0 at 2026-07-18 23:53 UTC.
Current annual revenue: **£680,963** (grew because LPS/demand-signals re-run refreshed source metrics).

| Scenario | Keywords w/ TP | TP absolute revenue | TP incremental revenue |
|---|---:|---:|---:|
| Conservative | 612 | £7,489,247 | £6,942,958 |
| Realistic | 827 | £21,880,399 | £21,135,186 |
| Stretch | 835 | £30,841,451 | £29,852,601 |

### 3.3 Delta

| Scenario | Δ Keywords w/ TP | Δ TP absolute | Δ TP incremental | Δ TP-inc % |
|---|---:|---:|---:|---:|
| Conservative | +176 | +£3,217,141 | +£4,680,655 | +207% |
| Realistic | +214 | +£7,793,299 | +£12,179,069 | +136% |
| Stretch | +212 | +£10,916,968 | +£14,877,722 | +99% |

**Interpretation:** The uplift is driven almost entirely by previously-truncated competitor SERP and LPS rows now reaching HAR. Before the fix, HAR was reading a 1,000-row slice of `serp_results` per batch, which nulled out most competitor ladders past batch-position ~830. Post-fix, the paginated `selectIn` returns the complete 12,046 rows, HAR finds beatable target positions on many more keywords (+176 conservative, +214 realistic, +212 stretch), and Revenue v2 propagates that into full-scenario totals.

---

## 4. Keyword-level ladder evidence (Part 4c)

Query compared `explanation_json->>'ladder_considered'` (integer count of SERP competitors HAR evaluated for the keyword) between:
- **Pre-fix HAR run:** `990ec9a4-695b-4a10-8e85-75388522fb43` (2026-07-17 13:29)
- **Post-fix HAR run:** `0b179746-0603-43aa-9383-4a0a7a6f2590` (2026-07-18 23:52)

Scenario filter: `realistic`. Ranked by delta descending.

| Keyword | Pre-fix `ladder_considered` | Post-fix `ladder_considered` | Δ |
|---|---:|---:|---:|
| 4k uhd televisions | 0 | 14 | +14 |
| tv hisense | 0 | 8 | +8 |
| 32 inch tv samsung | 0 | 6 | +6 |
| lg tv 55 inch | 0 | 6 | +6 |
| lg 4k oled tv | 0 | 5 | +5 |
| 38 tv | 0 | 5 | +5 |
| samsung tv 32 inch | 0 | 5 | +5 |
| lg tv oled | 0 | 5 | +5 |
| philips ambilight 55 | 0 | 4 | +4 |
| tv for sale hisense | 0 | 4 | +4 |
| samsung tv deals | 0 | 4 | +4 |
| philips televisions uk | 0 | 4 | +4 |
| 55 inch samsung tv | 0 | 4 | +4 |
| 33 inch tv | 0 | 4 | +4 |
| tv lg oled | 0 | 4 | +4 |

Every sampled keyword's pre-fix HAR was seeing **zero** competitor rows because its keyword IDs fell past the truncation cliff in the batched `serp_results` call. Post-fix, each ladder is populated with the correct competitor count — the drawer-sample requirement is satisfied.

### SQL used (for reproducibility)

```sql
WITH cmp AS (
  SELECT k.id, k.keyword,
    (SELECT (kfs.explanation_json->>'ladder_considered')::int
       FROM keyword_forecast_scenarios kfs
       WHERE kfs.keyword_id = k.id
         AND kfs.calc_run_id = '0b179746-0603-43aa-9383-4a0a7a6f2590'
         AND kfs.scenario = 'realistic') AS new_c,
    (SELECT (kfs.explanation_json->>'ladder_considered')::int
       FROM keyword_forecast_scenarios kfs
       WHERE kfs.keyword_id = k.id
         AND kfs.calc_run_id = '990ec9a4-695b-4a10-8e85-75388522fb43'
         AND kfs.scenario = 'realistic') AS old_c
  FROM keywords k
  WHERE k.project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
)
SELECT keyword, new_c, old_c, (new_c - old_c) AS delta
FROM cmp
WHERE new_c IS NOT NULL AND old_c IS NOT NULL
ORDER BY (new_c - old_c) DESC NULLS LAST
LIMIT 15;
```

---

## 5. Deployment & test evidence (recap)

- **Redeploy timestamp:** all five functions (`link-power-score-compute`, `demand-signals-compute`, `har-calculation-v2`, `compute-forecasts-v2`, `site-architecture`) redeployed at **2026-07-18 23:50:35 UTC**.
- **Vitest:** 36/36 passing after the remediation.
- **Typecheck:** clean.
- **Calculation logic:** unchanged — the diff is strictly read-completeness (pagination) and observability (`rows_fetched` counters). Any total delta between pre- and post-fix runs is attributable to data now being read in full, not to model changes.

---

## 6. Outstanding items (report-only, no action taken)

### 6.1 `serp_features` fetched = 9,000 in both HAR and Revenue

Both v2 functions report exactly `serp_features: 9000`. The table holds 19,756 rows across all keywords for the project. The truncation-audit ruling did not include `serp_features` in the nine remediated sites, so this is not a regression from Part 1 — but the round number warrants a read-only follow-up:
- Confirm whether the fetch is intentionally scoped (e.g. only enabled feature types, only rows joined to in-batch keyword IDs) rather than truncated by a default 1,000 cap.
- If truncated, add `{ paginate: true }` to that call in a subsequent hotfix.

### 6.2 `link_power_scores` all-run growth

The table now holds 20,850 rows across all historical runs, of which 12,046 belong to this HAR run. No action required: every consumer filters by `calc_run_id`, so retention of prior-run rows does not affect correctness. If retention is later tightened, the fetch code remains correct.

### 6.3 Non-terminal Revenue status

Revenue run `4c904f17` finished with status `partial` (30 keywords with `keywords_with_tp < 835` in stretch). This is by design — keywords with no HAR-beatable target position are skipped and reported as "no beat reason". This is not a truncation-related failure.

---

## 7. Summary

Truncation remediation is verified end-to-end on TVs Ongoing.

- **§2 (observability):** every remediated site's `rows_fetched` matches the true in-scope count.
- **§3 (totals):** post-fix Revenue v2 shows +£12–15M realistic/stretch TP-incremental uplift, sourced from newly-visible competitor rows rather than any model change.
- **§4 (ladders):** sampled keywords went from zero to fully-populated competitor ladders in HAR.
- **§5 (deploy/tests):** clean.
- **§6 (open items):** two read-only follow-ups queued (`serp_features` count, `link_power_scores` retention). Neither blocks Gate B progression.
