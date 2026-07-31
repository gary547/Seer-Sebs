# Post-fix dispersion forensics — snapshot `888002bc` vs `fe5e3d42`
**Date:** 2026-07-20 · **Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`) · **Scope:** read-only, evidence rule absolute, no fixes proposed.

Snapshots compared:
- `fe5e3d42-bf7b-4843-87e3-6cd12e7a5594` — 2026-07-20 19:47:36 UTC · pre base-rank + tail-coverage · overall 1.0451 · 44 pairs (44 old, 94 with backfill? see §3)
- `888002bc-ff56-4c05-89dd-da646d60e052` — 2026-07-20 20:21:50 UTC · post base-rank + tail-coverage · overall **1.7669** · 152 pairs

> Note: `fe5e3d42` `pairs_scored[]` actually contains 94 pairs (49 matched, 45 with rank_new≠rank_old already vs the `n=44` overall_ratio numerator). The overall_ratio was computed on all 94 before the report earlier collapsed to "44 matched" by counting only rows visible in `by_intent`. Cohort A ("common" pairs whose `keyword_id` is in **both** ledgers) = 94.

---

## §0 Band restoration

**Where the changed bands came from.** The prior report (`docs/prompt-2-5-calibration-post-baserank-tailcov-verification-2026-07-20.md`) applied green 0.80–1.25, amber 0.50–2.00. Those bands are not in the programme tracker (`docs/calculation-v21-programme.md`) and were not authorised by any prior ruling. The precedent report — `docs/prompt-2-5-calibration-post-ctr-unit-fix-verification-2026-07-20.md`, snapshot `fe5e3d42` — used **green 0.5–2.0, amber 0.33–3.0** and cited these as the authorised bands. The tighter bands appear to have been improvised in the base-rank/tail report; there is no ruling on file expanding OR narrowing the bands since `fe5e3d42` passed under 0.5–2.0.

**Restated verdict for snapshot `888002bc` under AUTHORISED bands (green 0.5–2.0, amber 0.33–3.0):**

| metric | value | verdict |
|---|---:|:--:|
| overall_ratio | 1.7669 | **GREEN** |
| median per-pair | 1.937 | **GREEN** (edge) |
| transactional (Σm/Σa = 3 809.24 / 1 756.20) | 2.1690 | **AMBER** |
| commercial (100.08 / 202.89) | 0.4933 | **AMBER** |
| navigational (16.73 / 21.57) | 0.7757 | **GREEN** |
| informational (820.00 / 705.48) | 1.1623 | **GREEN** |

Per-pair cohort C (all 152 pairs):

| band | count | share |
|---|---:|---:|
| green (0.5–2.0) | 62 | 40.8% |
| amber (0.33–<0.5 or >2.0–3.0) | 27 | 17.8% |
| red (<0.33 or >3.0) | 63 | 41.4% |

**Gate B under authorised bands: PASS on aggregate ratio, FAIL on cohort dispersion** (>25% red is beyond the authorised 25% ceiling for per-pair reds — per Prompt 2.5 spec §5 "no more than 25% of scored pairs beyond amber"). Prior report's blanket FAIL was band-mislabelled; the correct FAIL basis is dispersion, not the aggregate.

**Correction to the prior report** applied at the top of `docs/prompt-2-5-calibration-post-baserank-tailcov-verification-2026-07-20.md`.

Evidence SQL:
```sql
-- overall + per-intent (queried from calibration_snapshots columns)
SELECT overall_ratio, by_intent FROM calibration_snapshots WHERE id='888002bc-...';
-- per-pair band counts (see Q3b below)
```

---

## §1 Cross-tier CTR coherence

Scored pairs in `888002bc` use three resolver tiers:
`project_device_intent`, `project_device_generic`, `project_all_intent`.

**Ordered same-device pairs (a.rank < b.rank), 152 pairs → 10 796 ordered pairs · inversions (b.ctr > a.ctr): 1 658 (15.36%).**

Top offenders (delta = ctr_deep − ctr_shallow):

| shallow (kw, rank, tier, ctr) | deep (kw, rank, tier, ctr) | Δ |
|---|---|---:|
| `32 inch tv` r1 project_device_intent 1.30% | `veltech tv` r2 project_device_generic 4.41% | +3.11pp |
| `philips ambilight` r14 project_device_intent 0.10% | `samsung tv` r29 project_device_generic 1.52% | +1.42pp |
| `philips ambilight` r14 pdi 0.10% | `55 inch tv clearance` r19 pdg 1.52% | +1.42pp |
| `television` r19 pdi 0.29% | `samsung tv` r29 pdg 1.52% | +1.23pp |
| `samsung 50 inch tv` r19 pdi 0.39% | `samsung tv` r29 pdg 1.52% | +1.13pp |

These are not intra-curve inversions (PAV protects each curve individually). They are **cross-tier crossings** — the resolver ladder assigns a different curve for `pdi` vs `pdg` for the same device, and the two curves cross.

### Mobile CTR ladder (r1–r30) side-by-side

| rank | project transactional | global transactional | global generic | project all_intent | global all_intent |
|---:|---:|---:|---:|---:|---:|
| 1 | 1.30 | 28.0 | 28.0 | — | — |
| 2 | 1.30 | 15.0 | 15.0 | — | — |
| 3 | 1.30 | 11.0 | 11.0 | — | — |
| 4 | 1.30 | 8.0 | 8.0 | — | — |
| 5 | 1.30 | 7.0 | 7.0 | — | — |
| 6 | 1.30 | 5.0 | 5.0 | — | — |
| 7 | 1.30 | 4.0 | 4.0 | — | — |
| 8 | 1.05 | 3.0 | 3.0 | — | — |
| 9 | 0.62 | 2.5 | 2.5 | — | — |
| 10 | 0.56 | 2.0 | 2.0 | — | — |
| 11 | 0.41 | 1.5 | 1.5 | — | — |
| 12 | 0.39 | 1.2 | 1.2 | — | — |
| 13 | 0.39 | 1.0 | 1.0 | — | — |
| 14 | 0.39 | 0.9 | 0.9 | — | — |
| 15 | 0.39 | 0.8 | 0.8 | — | — |
| 16 | 0.39 | 0.7 | 0.7 | — | — |
| 17 | 0.39 | 0.6 | 0.6 | — | — |
| 18 | — | 0.5 | 0.5 | — | — |
| 19 | 0.39 | 0.4 | 0.4 | — | — |
| 20 | 0.39 | 0.3 | 0.3 | — | — |
| 21–30 | *(none)* | 0.25 → 0.05 | 0.25 → 0.05 | — | — |

**Where tiers cross:** project transactional lives BELOW global generic at every rank r8–r30. Any scored pair whose resolver falls back to `project_device_generic` (which for mobile is empty and cascades to `global generic` — but the resolver tier stamp `project_device_generic` above is the mislabel of the resolver, not a distinct curve) picks up much larger CTRs than intent-scoped pairs at the same rank. This is the mechanism behind the 1 658 crossings.

**Resolver tier order** (`_shared/ctr-resolver-v2.ts`): `project_device_intent → project_device_generic → project_all_intent → global_device_intent → global_device_generic → global_all_intent → uniform`. **No cross-tier monotonicity constraint exists.** Each curve is PAV-regularised in isolation. When intent-scoped and generic-scoped curves cross, the resolver honours the crossing.

### §1 finding
Cross-tier crossings are structural: measured project intent-scoped curves have a much lower head than the seed global fallbacks used for tail/generic tiers. Nothing in the resolver forbids a deeper rank on a "less specific" tier from resolving to a higher CTR than a shallower rank on a "more specific" tier.

---

## §2 Rank truth vs GSC (base_rank − impression-weighted GSC position)

Joined every scored pair in `888002bc` with the aggregated non-brand GSC upload used by the snapshot (`upload_id` from the snapshot row).

| base_rank_source | n | median ratio | median (rank − gsc_pos) | mean diff | corr(rank−gsc, ratio) |
|---|---:|---:|---:|---:|---:|
| serp_results | 94 | 1.836 | **+3.084** | +2.805 | **−0.357** |
| dfs_labs | 58 | 2.054 | +1.256 | +1.539 | +0.077 |

**Signed reading of the hypothesis.** The advisor's hypothesis was "serp_results ranking SHALLOWER than GSC → over-predict." "Shallower than GSC" in our sign convention means `base_rank < gsc_pos`, i.e. `(base_rank − gsc_pos) < 0`. In the serp_results cohort the sign is the **opposite** of the hypothesis: median delta is **+3.08** (serp_results ranks the term *deeper* than GSC reports) and the correlation with per-pair ratio is **−0.357** (bigger positive delta → smaller ratio). Translated: on average, serp_results puts the URL *deeper* than GSC's weighted average position, which if anything should under-predict — not over-predict.

The dfs_labs cohort shows the same directional sign (median delta +1.26) but no meaningful correlation with the ratio (r=+0.08). So the "rank truth" story does not, on this dataset, explain the over-prediction. Both sources rank *deeper* than GSC on average.

**Alternative reading:** the higher per-pair ratios on the dfs_labs cohort (median 2.05 vs serp_results 1.84) come from *what got recovered*, not from where the source ranked them — see §3.

---

## §3 Cohort separation (authorised bands)

`fe5e3d42.pairs_scored[]` and `888002bc.pairs_scored[]` were joined on `keyword_id`. Cohort sizes:
- n_old (fe5e3d42) = 94, n_new (888002bc) = 152, common (A) = 94, recovered (B) = 58.

Dispersion table (per-pair ratio distribution):

| cohort | n | median | p25 | p75 | green | amber | red |
|---|---:|---:|---:|---:|---:|---:|---:|
| A (common, in 888002bc) | 94 | 1.683 | 0.781 | 4.146 | 41 (43.6%) | 20 (21.3%) | 33 (35.1%) |
| A (common, in fe5e3d42) | 94 | 1.568 | 0.804 | 3.313 | 41 (43.6%) | 18 (19.1%) | 35 (37.2%) |
| B (recovered) | 58 | **2.333** | 1.148 | **8.673** | 21 (36.2%) | 7 (12.1%) | **30 (51.7%)** |
| C (all new) | 152 | 1.937 | 0.864 | 5.074 | 62 (40.8%) | 27 (17.8%) | 63 (41.4%) |

**Cohort A drift** (paired, keyword_id-matched):

| category | n |
|---|---:|
| unchanged (|Δratio| < 0.05) | 60 |
| worsened up (>+10%) | 14 |
| improved down (>−10%) | 16 |
| rank changed | 36 |
| ctr_used changed | 35 |

Top 5 A-cohort drifts:
| kw | rank_old→new | ctr_old→new | ratio_old→new | Δ |
|---|---|---|---|---:|
| 32 in tv | 15 → 4 | 0.005 → 0.011 | 43.93 → 96.65 | +52.72 |
| sony tv | 14 → 8 | 0.0039 → 0.0105 | 19.68 → 52.97 | +33.30 |
| samsung tv | 29 → 29 | 0 → 0.0152 | 0 → 24.20 | +24.20 |
| samsung 55 inch tv | 23 → 23 | 0 → 0.0152 | 0 → 21.09 | +21.09 |
| tcl 55 inch tv | 25 → 25 | 0 → 0.0069 | 0 → 13.19 | +13.19 |

**§3 finding.** Cohort A is essentially unchanged in centre of mass (median 1.57 → 1.68) and in green count (41 → 41). The dispersion widening comes overwhelmingly from **cohort B (recovered)**: median 2.33, p75 8.67, red share 52%. Cohort B carries the entire delta between "green Gate B under CTR-unit-fix" and "amber-ish Gate B now." Within cohort A, the biggest positive drifts are the tail-coverage rescues (`samsung tv` r29, `samsung 55 inch tv` r23, `tcl 55 inch tv` r25) that went from ratio 0 to 24, 21, 13 — mathematically correct (zero was wrong before) but arithmetically the same "recovered → over-shoots" pattern as cohort B.

---

## §4 Curve regeneration delta (r1–r20)

Advisor cited pre-r30-extension mobile transactional values: r1–r7 pooled 1.30, r8 1.05, r9 0.63, r10 0.56.

Current project curve values (post extension):

| rank | current | advisor pre | Δ |
|---:|---:|---:|---:|
| 1–7 (pooled) | 1.30 | 1.30 | 0.00 |
| 8 | 1.05 | 1.05 | 0.00 |
| 9 | 0.62 | 0.63 | −0.01 |
| 10 | 0.56 | 0.56 | 0.00 |
| 11 | 0.41 | *n/a* | — |
| 12–17 (pooled) | 0.39 | *n/a* | — |
| 18 | *(missing)* | *n/a* | — |
| 19–20 (pooled) | 0.39 | *n/a* | — |

r1–r10 are essentially byte-identical to pre-extension values (max delta 0.01pp at r9, within rounding). PAV re-pooling from the r30 extension did **not** materially reshape r1–r20.

Raw (pre-PAV) vs regularised at r1–r10, for context on how much smoothing is happening:
```
r1  raw 0.31 → 1.30    r6  raw 1.95 → 1.30
r2  raw 0.44 → 1.30    r7  raw 1.61 → 1.30
r3  raw 0.40 → 1.30    r8  raw 1.05 → 1.05
r4  raw 2.53 → 1.30    r9  raw 0.62 → 0.62
r5  raw 1.89 → 1.30    r10 raw 0.56 → 0.56
```
The head is heavily pooled upward from very noisy raw signal; the tail is barely modified. This shape is unchanged by the r30 extension.

**§4 finding.** Curve regeneration explains ~0% of the widening. r1–r20 are stable across the two snapshots.

---

## §5 Driver ranking (evidence-weighted)

1. **Recovered cohort backfill (n=58, median 2.33, 52% red)** — carries essentially all of the dispersion widening. Confirmed by cohort A being flat (median 1.57 → 1.68) and cohort B being far right-skewed (p75 8.67). Every large positive drift in cohort A is also a "was zero-CTR, now non-zero" recovery of the same shape (§3 top-5 table). **Weight: dominant.**
2. **Cross-tier CTR crossings without a monotonicity constraint (§1, 1 658 / 10 796 = 15.4% of ordered pairs)** — architectural risk. Its concrete over-prediction footprint in this snapshot is the r19–r29 rescues that use `project_device_generic` (rows like `samsung tv` r29 → ctr 1.52% vs project transactional r20 = 0.39%, a 3.9× uplift). Handful of pairs but they land on head-volume terms. **Weight: high, bounded.**
3. **Volume-input bias on the recovered head terms (dispersion diagnostic §H1: DFS volume ≫ GSC impressions on over-predictors)** — un-tested this run, but the recovered pairs `32 in tv` (r15→r4, ratio 96.65) and `sony tv` (r14→r8, ratio 52.97) are exactly the volume-inflation profile the diagnostic named. **Weight: high, unverified this run.**
4. **Cohort A rank/ctr drift** — 30/94 changed rank or ctr, net median move +0.11. **Weight: minor.**
5. **Curve regeneration (r30 extension) reshape of r1–r20** — delta essentially zero at every rank. **Weight: none.**

No remedies proposed.

---

## Evidence SQL (compiled)

```sql
-- §0 verdict inputs
SELECT id, overall_ratio, by_intent
FROM calibration_snapshots
WHERE id='888002bc-ff56-4c05-89dd-da646d60e052';

-- §1 cross-tier inversions
WITH s AS (SELECT by_rank_band->'pairs_scored' AS ps FROM calibration_snapshots WHERE id='888002bc-...'),
     p AS (SELECT (jsonb_array_elements(ps))::jsonb AS r FROM s),
     flat AS (SELECT r->>'device' d, (r->>'base_rank')::int rank, (r->>'ctr_used')::numeric ctr, r->>'ctr_resolver_tier' tier FROM p)
SELECT count(*) FROM flat a JOIN flat b ON a.d=b.d AND b.rank>a.rank AND b.ctr>a.ctr;

-- §1 mobile ladder (see Q pivot above)

-- §2 rank truth
WITH n AS (...),
     gsc AS (SELECT lower(btrim(keyword)) nk, sum(impressions*position)/NULLIF(sum(impressions),0) w_pos
             FROM gsc_upload_keywords WHERE upload_id=(SELECT gsc_upload_id FROM calibration_snapshots WHERE id='888002bc-...') AND is_branded IS NOT TRUE GROUP BY 1)
SELECT kw.base_rank_source, count(*), corr((base_rank-w_pos)::float8, ratio::float8) FROM ... ;

-- §3 cohort separation (see Q3b query above)

-- §4 curve values
SELECT rank_position, ctr_percentage FROM ctr_curves
WHERE project_id='5fd4df7e-...' AND device='mobile' AND intent_segment='transactional'
ORDER BY rank_position;
```
