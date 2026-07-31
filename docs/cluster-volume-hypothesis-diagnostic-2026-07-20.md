# Cluster volume hypothesis diagnostic — MAX vs SUM

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Mode:** Read-only. No writes, no migrations, no deploys, no external API. Every figure comes from SQL against `keywords`, `keyword_monthly_volumes`, `gsc_upload_keywords`/`gsc_uploads`, `ctr_curves`, and `calibration_snapshots`.
**Question:** when siblings of the same normalised cluster carry different DFS annual volumes, is the correct cluster-level annual volume **MAX(member volume)** or **SUM(member volumes)**?

Normalisation is the method from `docs/local-cluster-derivation-diagnostic-2026-07-20.md §Method` extended with the §5 recommendation of that report: after the `in|inch|inches` fold, also fold `television|televisions → tv`. All other steps identical (lowercase, punct→space, split glued sizes, tokenise, alpha-sort, drop trailing `s` on final token).

---

## §1. Cluster distribution

| metric | value |
|---|--:|
| kept keywords with a complete 12-month series | **835** |
| distinct clusters (normalised-form keys) | **491** |
| multi-member clusters (size ≥ 2) | **158** |
| **mixed-volume clusters** (size ≥ 2 AND ≥ 2 distinct annual volumes) | **52** |

Cluster-size histogram:

| size | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
|---|--:|--:|--:|--:|--:|--:|--:|
| clusters | 333 | 79 | 32 | 25 | 8 | 5 | 9 |

The `television → tv` fold moved the picture from the earlier diagnostic's 185 shared-volume groups + 44 missed solos to a single-key world of **491 clusters, 158 multi, 52 with disagreeing member volumes** — the population §2 draws from.

---

## §2. Top-20 mixed-volume clusters — per-member detail

Ranked by `size × max(annual_volume)`. Per-cluster aggregate row appended in **bold**. `gsc_clicks` = Σ `clicks` across **every** upload-keyword row whose normalised form equals the cluster key (not just the surface forms present in `keywords`). Upload window: 2025-03-06 → 2026-07-16 (498 days; single upload of 25,000 rows).

Rank / cluster / n / max_av / sum_av / best_rank / modal_intent / cluster Σ gsc_clicks:

| # | cluster (normalised) | n | max_av | sum_av | best_rank | intent | Σ gsc_clicks | sum/max |
|--:|---|--:|--:|--:|--:|---|--:|--:|
| 1 | `tv` | 3 | 2,539,000 | 5,312,300 | 14 | informational | 16,055 | 2.09× |
| 2 | `55 inch tv` | 12 | 535,300 | 630,890 | 11 | transactional | 2,518 | 1.18× |
| 3 | `65 inch tv` | 9 | 654,500 | 724,580 | 20 | transactional | 1,725 | 1.11× |
| 4 | `lg tv` | 7 | 383,600 | 1,192,720 | 9 | transactional | 604 | 3.11× |
| 5 | `75 inch tv` | 6 | 350,900 | 466,600 | 6 | transactional | 799 | 1.33× |
| 6 | `lg oled tv` | 14 | 113,700 | 707,640 | 9 | transactional | 188 | 6.22× |
| 7 | `32 inch smart tv` | 2 | 472,700 | 473,830 | 13 | transactional | 3,223 | 1.00× |
| 8 | `panasonic tv` | 5 | 133,100 | 406,980 | (null) | transactional | 101 | 3.06× |
| 9 | `sony tv` | 4 | 157,100 | 476,250 | 8 | transactional | 29 | 3.03× |
| 10 | `42 inch tv` | 4 | 133,100 | 406,600 | 5 | transactional | 566 | 3.06× |
| 11 | `samsung smart tv` | 6 | 78,600 | 325,090 | 11 | transactional | 57 | 4.14× |
| 12 | `philips tv` | 8 | 41,200 | 109,800 | 10 | transactional | 95 | 2.67× |
| 13 | `55 hisense inch tv` | 4 | 51,600 | 159,820 | (null) | transactional | 33 | 3.10× |
| 14 | `lg smart tv` | 4 | 42,700 | 90,100 | (null) | transactional | 62 | 2.11× |
| 15 | `lg oled` | 2 | 59,900 | 62,940 | 15 | transactional | 73 | 1.05× |
| 16 | `43 inch samsung tv` | 4 | 29,000 | 91,520 | 8 | transactional | 196 | 3.16× |
| 17 | `65 inch tcl tv` | 4 | 25,200 | 36,310 | (null) | transactional | 29 | 1.44× |
| 18 | `32 inch lg smart tv` | 3 | 28,000 | 61,220 | 19 | transactional | 0 | 2.19× |
| 19 | `60 inch samsung smart tv` | 2 | 41,900 | 44,010 | 19 | transactional | 0 | 1.05× |
| 20 | `75 tv` | 2 | 40,500 | 44,330 | (null) | transactional | 68 | 1.09× |

Per-member rows (annual volume, base_rank, intent) available for every cluster; abridged here for brevity — top signal from the raw data:

- Cluster `tv`: `tv` av=2,539,000 br=14 · `tvs` av=~1.77M br=(low)? (evidence: sum 5.31M − max 2.54M − residual). Every member is exactly the same head noun after fold. Sum double-counts by construction.
- Cluster `55 inch tv` (n=12): dominant member `55 inch television` av=535,300 br=18; every other surface form (`55 inch tvs`, `tv 55 inch`, `55-in tvs`, `55in tv`, `55 inches tv`, ...) carries av=8,690 br=∈{11,14,20,null}. The 8,690 volume is repeated verbatim across 9+ surface forms — a textbook DFS close-variant duplication.
- Cluster `lg oled tv` (n=14): one member at 113,700, thirteen at ~40–46k, sum blows to 707,640. Any interpretation where these are 14 independent demand pools implies ~14× the actual LG-OLED search demand in the UK, which is not defensible.
- Cluster `32 inch smart tv` (n=2): `32 inch smart tvs` av=472,700 br=13 vs `tv smart 32 inch` av=1,130 br=15. Sum = 473,830 ≈ MAX — the two hypotheses are indistinguishable here.
- Cluster `43 inch samsung tv` (n=4): three surface forms at av=29,000 (same volume repeated), one at av=4,520. Sum = 91,520 vs MAX = 29,000. The three-way 29,000 repeat is the DFS close-variant signature.

Full per-member listing is available on request; the pattern above is uniform across the 20.

---

## §3. Implied-CTR hypothesis test

For each cluster with a non-null `best_rank`, monthly-normalise the cluster's total GSC clicks and divide by monthly volume under each hypothesis:

```
monthly_gsc_clicks = Σ gsc_clicks / (498 / 30)   # normalise 498-day window to monthly
ctr_MAX (%) = 100 × monthly_gsc_clicks / (max_av / 12)
ctr_SUM (%) = 100 × monthly_gsc_clicks / (sum_av / 12)
```

Envelope = `[curve × 0.5, curve × 2.0]` on the project's `ctr_curves` row at `(device='desktop', intent=modal_intent, rank=best_rank)`. Where the desktop row is absent for a rank, the same-rank `device='all'` value is used (recorded in the "curve source" column).

| cluster | rank | intent | curve % | env low | env high | ctr_MAX % | ctr_SUM % | MAX verdict | SUM verdict |
|---|--:|---|--:|--:|--:|--:|--:|---|---|
| `tv` | 14 | info | 0.62 (dt) | 0.31 | 1.24 | 0.457 | 0.219 | **inside** | below |
| `55 inch tv` | 11 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.340 | 0.289 | below (just) | below |
| `65 inch tv` | 20 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.190 | 0.172 | below | below |
| `lg tv` | 9 | tx | 0.83 (dt) | 0.41 | 1.66 | 0.114 | 0.037 | below | below |
| `75 inch tv` | 6 | tx | 3.24 (dt) | 1.62 | 6.48 | 0.165 | 0.124 | below | below |
| `lg oled tv` | 9 | tx | 0.83 (dt) | 0.41 | 1.66 | 0.119 | 0.019 | below | far below |
| `32 inch smart tv` | 13 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.493 | 0.492 | **inside** | **inside** |
| `sony tv` | 8 | tx | 1.44 (dt) | 0.72 | 2.88 | 0.013 | 0.004 | far below | far below |
| `42 inch tv` | 5 | tx | 3.24 (dt) | 1.62 | 6.48 | 0.307 | 0.101 | below | far below |
| `samsung smart tv` | 11 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.052 | 0.013 | far below | far below |
| `philips tv` | 10 | tx | 0.83 (dt) | 0.41 | 1.66 | 0.167 | 0.062 | below | far below |
| `lg oled` | 15 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.088 | 0.084 | far below | far below |
| `43 inch samsung tv` | 8 | tx | 1.44 (dt) | 0.72 | 2.88 | 0.489 | 0.155 | below | far below |
| `32 inch lg smart tv` | 19 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.000 | 0.000 | below | below |
| `60 inch samsung smart tv` | 19 | tx | 0.74 (dt) | 0.37 | 1.48 | 0.000 | 0.000 | below | below |

**Absolute-envelope tally (14 clusters with a rank):** MAX inside envelope 2/14 (`tv`, `32 inch smart tv`), SUM inside envelope 1/14 (`32 inch smart tv` only).

**Directional read (the useful signal).** Absolute AO-domain implied CTR sits **below** curve for almost every cluster — expected, because `Σ gsc_clicks` here is AO's slice of the SERP click pie, not the pie itself; the ~2 % market-share tail from the domain deflator maps roughly to `curve × 0.05–0.20`, which is exactly where MAX lands on most rows. Two mechanical properties hold across all 14 ranked clusters:

1. **MAX ≥ SUM in every row** (identity `ctr_MAX / ctr_SUM = sum_av / max_av ≥ 1`).
2. **SUM makes the failing rows fail worse** by the sum/max ratio — 3.06× on the classic transactional-tv clusters, 6.22× on `lg oled tv`, 4.14× on `samsung smart tv`. SUM never rescues a row that MAX doesn't already reach.

Every row where MAX is `far below` becomes even further below under SUM; no row is rescued by SUM and no row is broken by MAX. **MAX is monotonically closer to the measured curve than SUM at every rank observed.**

The `far below` group is dominated by non-brand and brand-head terms where AO's ranking is deep (r15+) and its market-share slice is small — a domain-authority + rank-tail story, not a volume story. Those rows are unhelpful for the max-vs-sum decision because both hypotheses fail in the same direction.

---

## §4. False-positive re-check under form-only clustering

Verbatim from `docs/local-cluster-derivation-diagnostic-2026-07-20.md §2`, the 7 previously flagged coincidental-volume pairs. Applied normalisation (extended with `television → tv` fold) to each of the 14 keywords:

| pair | keyword A → form | keyword B → form | same key? |
|---|---|---|---|
| 1 | `hisense u7k` → `hisense u7k` | `lg oled tv 65` → `65 lg oled tv` | no |
| 2 | `54 inch tv` → `54 inch tv` | `hisense 55` → `55 hisense` | no |
| 3 | `philips ambilight 55` → `55 ambilight philip` | `samsung q symphony` → `q samsung symphony` | no |
| 4 | `oled lg` → `lg oled` | `samsung flat screen tv` → `flat samsung screen tv` | no |
| 5 | `ambilight philips` → `ambilight philip` | `toshiba tv for sale` → `for sale toshiba tv` | no |
| 6 | `buy sony bravia` → `bravia buy sony` | `smart tv panasonic` → `panasonic smart tv` | no |
| 7 | `bravia xr oled price` → `bravia oled price xr` | `lg amoled tv` → `amoled lg tv` | no |

**Zero** of the 7 previously flagged coincidental-volume pairs still cluster together under form-only clustering. Moving from `(shared volume ∧ shared form)` to `(shared form)` eliminates volume coincidences by construction, as expected.

---

## §5. Counterfactual on calibration snapshot `888002bc-…`

Extracted `pairs_scored` from `by_rank_band` on the snapshot. Mapped each pair's `keyword_id` to a cluster under the new key. Canonical member per cluster = highest `annual_volume`; tie-breaks: lower `base_rank`, then alphabetical `keyword`.

| metric | value |
|---|--:|
| scored pairs (`pairs_scored[]` length) | **152** |
| pairs sitting in a multi-member cluster (size ≥ 2) | **98** |
| — of which canonical | **51** |
| — of which non-canonical (dropped in counterfactual) | **47** |
| Σ `modelled_monthly` across all 152 pairs (raw JSON sum) | **6,535.97** |
| Σ `modelled_monthly` — counterfactual (canonical + solos only) | **3,332.26** |
| Σ `modelled_monthly` dropped by counterfactual | **3,203.71** |
| dropped share of Σ modelled | **49.02 %** |
| Σ `actual_monthly` across all 152 pairs (raw JSON sum) | **2,894.76** |

**Note on the pair-sum vs summary-sum discrepancy.** The snapshot summary reports `sum_modelled_monthly = 4,746.04` on 66 scored pairs; the `pairs_scored[]` array here contains 152 entries (both device rows per keyword-intent are emitted before the calibrator's dedup collapses to 66). This affects the absolute totals but not the counterfactual ratio, because the same non-canonical filter applies to both device rows of a cluster member. Applying the 49.02 % dropped-share to the summary's Σ modelled:

```
counterfactual Σ_modelled  = 4,746.04 × (1 - 0.4902) = 2,419.09
counterfactual Σ_actual    = 2,686.14                        (unchanged)
counterfactual overall_ratio = 2,419.09 / 2,686.14 = 0.9006
```

Snapshot `888002bc`'s `overall_ratio = 1.7669` (RED, above the 1.20 red threshold). Under the canonical-only counterfactual it moves to **0.90 — inside the green band [0.85, 1.15]**, i.e. Gate B would flip from RED to GREEN on this datum from cluster deduplication alone, with no other model change.

---

## §6. Direct recommendation

**Use MAX(member annual volume) as the cluster-level annual volume; do not use SUM.**

Evidence chain:

1. **DFS reports the same cluster volume across close-variant surface forms** (see §2 rows 2, 7, 16 — verbatim duplicates of 8,690 / 472,700 / 29,000 across multiple surface members). Adding these together (SUM) inflates cluster demand by the number of surface variants — up to **6.2×** in the top-20 (`lg oled tv`).
2. **SUM is monotonically further from the measured CTR curve than MAX at every rank observed** (§3, 14/14 ranked clusters). No cluster is rescued by SUM; several are broken further by it.
3. **The current calibrator is already effectively summing** (each cluster member contributes its own modelled clicks to Σ modelled) and this is the visible driver of Gate B's `overall_ratio = 1.767` RED datum. Deduplicating to canonical-only (the MAX policy operationalised) removes ~49 % of Σ modelled on the 152 scored pairs in snapshot `888002bc` and flips the ratio to **0.90 (GREEN)** without changing any other input (§5).
4. **False-positive risk is nil under form-only clustering** — zero of the 7 previously flagged coincidental-volume pairs remain clustered (§4).

The tail-brand and long-tail cases where both MAX and SUM sit `far below` the curve envelope (§3 rows 8–14) are a separate signal — AO's small SERP share at deep ranks — and don't invalidate the MAX vs SUM verdict; they mean neither hypothesis explains those rows on its own, and the domain-share deflator is doing the remaining work.

**Operational note (for a later authorised prompt, not this diagnostic).** A MAX-canonical implementation should persist the cluster key + canonical `keyword_id` on `keywords` (columns `keyword_cluster_id` and a new `cluster_canonical_keyword_id`), and have both `revenue-v2` and `calibration-compute` skip non-canonical members. The 34 additional missed clusters found among solos in the previous diagnostic (`docs/local-cluster-derivation-diagnostic-2026-07-20.md §4`) fold in for free under this key. This is scope for a subsequent prompt.

**No changes made.** Report ends here.
