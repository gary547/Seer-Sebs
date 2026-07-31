# Post-Fix Calibration Verification — base_rank authority + rank-tail coverage
Project: **TVs Ongoing** (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
Snapshot under test: **`888002bc-ff56-4c05-89dd-da646d60e052`** — 2026-07-20 20:21:50 UTC
Predecessor: **`fe5e3d42-bf7b-4843-87e3-6cd12e7a5594`** — 2026-07-20 19:47:36 UTC
Evidence rule: every figure is queried; SQL is shown. `pairs_scored[]` used verbatim.

---

## 1. Run outcome

```sql
SELECT id, created_at, window_days, overall_ratio, keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots WHERE id='888002bc-ff56-4c05-89dd-da646d60e052';
```
| field | value |
|---|---|
| id | `888002bc-ff56-4c05-89dd-da646d60e052` |
| created_at | 2026-07-20 20:21:50 UTC |
| window_days | 498 |
| overall_ratio | **1.766861** |
| keywords_matched | 66 |
| keywords_unmatched | 14 724 |
| notes | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=152 · model_blind=85 · overall=Σm/Σa=4746.04/2686.14=1.766861` |

Hand check of Σm/Σa (from `by_rank_band.totals`):
`sum_modelled_monthly = 4746.044009363335`
`sum_actual_monthly   = 2686.144578313253`
`4746.044009 / 2686.144578 = 1.766861` ✓ (matches `overall_ratio` to 6 dp)

Redeploys applied since `fe5e3d42`:
- `ctr-curves-from-gsc` — r1–30 writer + PAV, boot line `[ctr-curves-from-gsc] boot @ 2026-07-20T18:xxZ writer_rank_ceiling=30 pav=true`, curves regenerated.
- `_shared/ctr-resolver-v2.ts` — `roundPositionV1` ceiling raised to 30 (r31+ tier=none by design).
- `base-rank-backfill` — first invocation.
- Global fallback rows for r21–30 (180 rows) inserted (INSERT-only migration).
- `calibration-compute` — unchanged since snapshot `fe5e3d42` (CTR-unit fix boot line still current).

## 2. Headline

> **Correction 2026-07-20 (post-report):** the bands used in the original §2 (green 0.80–1.25, amber 0.50–2.00) were not authorised. AUTHORISED bands per the programme are **green 0.5–2.0, amber 0.33–3.0** (as applied in `docs/prompt-2-5-calibration-post-ctr-unit-fix-verification-2026-07-20.md`, snapshot `fe5e3d42`). See `docs/dispersion-forensics-888002bc-2026-07-20.md` §0 for the full restated verdict.

**Overall ratio: 1.7669** — **GREEN** under authorised bands (was mis-labelled RED). Gate B on aggregate: **PASS**. Gate B on dispersion: **FAIL** (63/152 = 41% of scored pairs red under authorised bands — beyond the 25% ceiling in Prompt 2.5 §5).

### by_intent (from `by_intent.*`) — under authorised bands
| intent | Σ modelled | Σ actual | ratio | matched | median per-pair |
|---|---:|---:|---:|---:|---:|
| transactional | 3 809.24 | 1 756.20 | **2.1690** (amber) | 60 | 1.0723 |
| informational |   820.00 |   705.48 | 1.1623 (green) | 2 | 1.6321 |
| commercial   |   100.08 |   202.89 | 0.4933 (amber) | 3 | 0.5173 |
| navigational |    16.73 |    21.57 | 0.7757 (green) | 1 | 0.7757 |
| unknown      |     0.00 |     0.00 | —              | 0 | — |

### by_rank_band (from `by_rank_band.*`)
| band | Σ modelled | Σ actual | ratio | matched pairs | median per-pair |
|---|---:|---:|---:|---:|---:|
| 1–3   |   172.15 |   162.47 | 1.0596 (green) | 4  | 0.9252 |
| 4–10  | 1 391.70 |   485.66 | **2.8656** (red) | 17 | 1.8840 |
| 11–20 | 2 515.28 | 1 865.24 | 1.3485 (amber) | 42 | 0.8942 |

**Gate verdict: FAIL** — portfolio ratio exceeds the amber ceiling of 2.00 on transactional; band 4–10 is 2.87×; bands 1–3 and 11–20 individually within amber; commercial is red-low.

## 3. Dispersion

```sql
-- from by_rank_band->pairs_scored (n=152)
SELECT COUNT(*), min, max, p25, median, p75,
       green (0.8–1.25), amber (0.5–<0.8 ∪ >1.25–2.0), red (<0.5 ∪ >2.0)
FROM ps;
```
| stat | value |
|---|---:|
| n scored pairs | 152 |
| min per-pair ratio | 0.0511 |
| p25 | 0.8641 |
| **median** | **1.9370** |
| p75 | 5.0739 |
| max | 96.6464 |
| green | **21** (13.8 %) |
| amber | 41 (27.0 %) |
| red | **90** (59.2 %) |

Pairs do **not** cluster near 1.0 — the distribution has a wide right tail (p75 ≈ 5.07, max ≈ 97). The portfolio does not "average to 1"; the sum-of-sums is 1.77 with the median at 1.94 and 90 of 152 pairs red.

**Top 5 over-predictions** (ratio ↓):
| keyword | dev | rank | ctr | svm | vf | modelled | actual | ratio |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 32 in tv           | mobile | 4  | 0.0110 | 0.612 | 342 475 | 192.13 | 1.99 | **96.65** |
| tv 40 inch smart   | mobile | 8  | 0.0105 | 0.648 | 331 596 | 188.01 | 2.17 | **86.70** |
| hisense tvs        | mobile | 12 | 0.0039 | 0.612 | 422 200 |  83.98 | 1.33 | **63.36** |
| 32 inch television | mobile | 12 | 0.0039 | 0.612 | 342 475 |  68.12 | 1.14 | **59.51** |
| sony tv            | mobile | 8  | 0.0105 | 0.720 | 146 898 |  92.55 | 1.75 | **52.97** |

**Top 5 under-predictions** (ratio ↑):
| keyword | dev | rank | ctr | svm | vf | modelled | actual | ratio |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 55 inch tv          | mobile | 14 | 0.0039 | 0.684  | 30 030 |  6.68 | 130.72 | **0.0511** |
| buy tv              | mobile | 20 | 0.0039 | 0.452  | 33 866 |  4.98 |  31.57 | 0.1577 |
| tcl 75 inch tv      | mobile | 19 | 0.0039 | 0.612  |  3 300 |  0.66 |   3.43 | 0.1912 |
| tv deals uk         | mobile | 20 | 0.0089 | 0.612  | 21 183 |  9.61 |  40.12 | 0.2397 |
| cheap tvs for sale  | mobile | 16 | 0.0039 | 0.366  | 40 182 |  4.78 |  19.22 | 0.2489 |

## 4. Matching anatomy

From `notes` + `by_rank_band`:
- GSC rows: 25 000; non-brand rows: 20 604; distinct normalised queries: 14 961.
- Kept keyword universe: 857.
- Matched: **66 keywords → 152 scored pairs** (device split).
- Model-blind: **85 pairs** (all `reason=base_rank_null`); Σ actual/30d = **635.36**; median GSC position = **11.2**.
- Noise-floor exclusions: identical to `fe5e3d42` (writer unchanged); GSC queries under the noise floor were dropped before match.
- Unmatched: 14 724 GSC normalised queries.

Top 10 unmatched by clicks (from `by_rank_band.top_unmatched`) — all off-vertical for TVs, confirming the scoping mismatch is preserved:
1. fridge freezer (64 481) · 2. washing machine (24 803) · 3. tumble dryer (23 193) · 4. microwave (22 175) · 5. condenser tumble dryer (15 356) · 6. aeg comfort 6000 (13 606) · 7. integrated fridge freezer (11 983) · 8. american fridge freezer (10 480) · 9. integrated washing machine (10 468) · 10. appliances online (10 223).

## 5. Worked pair — '24 inch tv'

Ledger row (`by_rank_band.pairs_scored[]` verbatim):
```json
{
  "device": "mobile", "intent": "transactional", "keyword": "24 inch tv",
  "keyword_id": "11933010-d609-4aae-9af7-f7d98943a43d",
  "base_rank": 20, "ctr_curve_key": "mobile|transactional|20",
  "ctr_resolver_tier": "project_device_intent", "ctr_used": 0.0039,
  "svm_used": 0.612,
  "annual_volume": 101300, "months_used": 12, "annual_volume_source": "keyword_monthly_volumes",
  "trend_applied": true, "trend_factor": 0.8689, "trend_confidence": "high",
  "volume_forward_used": 88019.57,
  "actual_clicks_raw": 601, "actual_monthly": 36.204819277108435,
  "modelled_monthly": 17.507092473, "per_pair_ratio": 0.48355696348053256
}
```
Arithmetic: `88019.57 × 0.0039 × 0.612 / 12 = 17.5074` ≈ modelled 17.5071 ✓ (curve at r20 is 0.39 pp; PAV writer wrote the r1–30 tail with monotone decay).
Ratio: `17.5071 / 36.2048 = 0.4836` ✓.

vs. fe5e3d42: previously ctr_used=0.0105 (r-band average curve at r ≤ 20), modelled 47.13, ratio 1.30. The r20-specific value from the regenerated PAV curve is 0.39 pp, materially lower than the 1.05 pp used before; this is the new head-fall shape for mobile-transactional.

## 6. Revenue sanity block (informational)

From `by_rank_band.revenue_sanity`:
| field | value |
|---|---|
| label | **vs assumed conversion values** |
| aov_source | `project_default` |
| cvr_source | `project_default` |
| actual_monthly_revenue | £ 10 744.58 |
| modelled_current_monthly_revenue | £ 18 984.18 |
| ratio | 1.767 |

Revenue ratio tracks the clicks ratio 1:1, as expected — the CVR/AOV are common multipliers.

## 7. Interpretation

Residual is **systematic bias combined with severe dispersion**, dominated by two mechanisms visible in the ledger:

- **B1 — head-band over-prediction (band 4–10, ratio 2.87).** The 4–10 band contains the 5 worst offenders (ratios 53–97). Common signature: high `volume_forward_used` (146 k–422 k) with low realised GSC clicks (1–2 /mo). This is the same "DFS volume ≫ realised demand" signature diagnosed on `fe5e3d42` — but now amplified because more head terms are correctly ranked into band 4–10 by the `serp_results` backfill. The bias is not in the curve; it is in the volume input on head terms.

- **B2 — new r21–30 pairs are large over-predictions.** Every previously tier=none pair now scored (§B below) except `48 inch tv` is red-over: `samsung tv` r29 → 24.2×, `samsung 55 inch tv` r23 → 21.1×, `tcl 55 inch tv` r25 → 13.2×, `samsung s95f` r21 → 12.3×, `50 inch tv` r21 → 1.68×, `philips ambilight tv 65` r25 → 4.34×. The rank-tail seed curves are non-zero (0.69–1.52 pp) so any head-brand term at r21+ generates non-trivial modelled clicks against near-zero real clicks. The tail-coverage fix eliminated the zero-floor artefact but exposed the same volume-inflation pattern one rank band deeper.

- **B3 — 55 inch tv under-prediction (0.051).** Volume 30 k, r14, actual 130.7/mo — implied real CTR ≈ 14 %, which is head-band behaviour. Either the r14 SERP snapshot is stale (true rank higher) or the volume figure is a fraction of realised demand for this cluster. Either way, symmetric evidence of volume-input error rather than curve error.

- **Compositional evidence.** Bands 1–3 (n=4) and 11–20 (n=42) sum-of-sums land in green/amber; the transactional intent bucket is red only because bands 4–10 and 21+ pull it. Median per-pair (1.94) sits materially above the sum-of-sums (1.77), indicating right-skew, not tight clustering.

No fixes proposed.

## 8. Tracker

Current Gate B datum: **`888002bc-ff56-4c05-89dd-da646d60e052` — RED (1.7669)**. Supersedes `fe5e3d42` as the post-baserank+tail-coverage reference; `fe5e3d42` is retained as the pre-fix Gate B baseline for delta accounting.

---

## Deltas vs `fe5e3d42`

### A. Model-blind delta

| metric | fe5e3d42 | 888002bc | Δ |
|---|---:|---:|---:|
| model_blind pairs | 143 | **85** | −58 |
| Σ actual /30d (blind) | (prev report) | **635.36** | — |
| median GSC position | — | 11.2 | — |
| distinct blind reasons | 1 (`base_rank_null`) | 1 (`base_rank_null`) | — |

**Converted from blind → scored:** `58` pairs (recovered cohort; see below).

`keywords.base_rank_source` counts today (backfill outcome):
```sql
SELECT base_rank_source, COUNT(*) FROM keywords
WHERE project_id='…5fd4df7e…' AND detox_status='keep' GROUP BY 1;
```
| source | rows |
|---|---:|
| `serp_results` | **286** |
| `dfs_labs` | 168 |
| NULL (still unranked) | 403 |
| total kept | 857 |

That is 286 keywords now sourced from fresh SERP snapshots and 168 retained from Labs — consistent with the derivation rule (SERP wins when host matches and snapshot is newer; Labs otherwise retained).

### B. Tier-none delta

- Scored pairs resolving `tier=none`: **0** (was 7).
- Max `base_rank` now carrying a curve: **29** (was 20).
- Resolver tier distribution across the 152 scored pairs:

| resolver tier | pairs | rank range covered |
|---|---:|---|
| `project_device_intent`  | 135 | 1–20 |
| `project_all_intent`     |  13 | 18–25 |
| `project_device_generic` |   4 |  2–29 |

The seven previously-zero pairs, all now non-zero (values from `pairs_scored[]`):
| keyword | dev | rank | ctr_used | tier | modelled | actual | ratio |
|---|---|---:|---:|---|---:|---:|---:|
| samsung tv              | mobile | 29 | 0.0152 | `project_device_generic` | 421.30 | 17.41 | 24.199 |
| samsung 55 inch tv      | mobile | 23 | 0.0152 | `project_device_generic` | 104.18 |  4.94 | 21.089 |
| tcl 55 inch tv          | mobile | 25 | 0.0069 | `project_all_intent`     |  21.46 |  1.63 | 13.193 |
| samsung s95f            | mobile | 21 | 0.0069 | `project_all_intent`     |  49.77 |  4.04 | 12.332 |
| philips ambilight tv 65 | mobile | 25 | 0.0069 | `project_all_intent`     |   5.22 |  1.20 |  4.337 |
| 50 inch tv              | mobile | 21 | 0.0069 | `project_all_intent`     | 225.06 | 134.28 |  1.676 |
| 48 inch tv              | mobile | 24 | 0.0069 | `project_all_intent`     |  20.55 | 21.08 |  0.975 |

Rank-tail coverage confirmed: zero pairs at r21–29 remain at `tier=none`; every one carries a curve value; `48 inch tv` at 0.975 lands green.

### C. Dispersion delta

| stat | fe5e3d42 | 888002bc | direction |
|---|---:|---:|---|
| n scored | 94 | 152 | +58 (recovered cohort) |
| median per-pair | 1.5680 | **1.9370** | **widened up** |
| p25 | 0.8040 | 0.8641 | ≈ flat |
| p75 | 3.3130 | **5.0739** | **widened up** |
| min | — | 0.0511 | — |
| max | — | 96.6464 | — |
| green (0.8–1.25) | 41 (44 %) | **21 (14 %)** | **collapsed** |
| amber | 18 (19 %) | 41 (27 %) | grew |
| red   | 35 (37 %) | **90 (59 %)** | **widened** |

**Dispersion widened.** The portfolio ratio moved from green (1.05) to red (1.77) and the distribution became materially worse: green share fell from 44 % to 14 %, IQR widened from 0.80–3.31 → 0.86–5.07, and 59 % of pairs are now red. The extra 58 pairs recovered by the base_rank backfill did not cluster around 1.0.

### Recovered cohort — how the 58 formerly-blind pairs distribute

```sql
-- pairs in 888002bc.pairs_scored whose keyword_id was in fe5e3d42.pairs_model_blind
```
| stat | value |
|---|---:|
| n recovered | 58 |
| median per-pair | 2.3333 |
| p25 | 1.1483 |
| p75 | 8.6726 |
| min | 0.2397 |
| max | 86.6957 |
| green | 6 |
| amber | 15 |
| red | 37 |
| Σ modelled /mo | 3 013.52 |
| Σ actual /mo   |   900.36 |
| cohort ratio (Σm/Σa) | **3.347** |

The recovered cohort skews **badly right** (median 2.33, red = 64 %, cohort ratio 3.35). These pairs were not simply invisible — they were hiding a large upward bias that the previous `base_rank_null` gate had suppressed. The recovered cohort alone accounts for `3013.52 − 900.36 = 2113.16` of the `4746.04 − 2686.14 = 2059.90` portfolio over-shoot, i.e. essentially all of it. Bands 4–10 and rank-tail head-brand terms are the dominant sub-cohorts within this group (§7 B1/B2).
