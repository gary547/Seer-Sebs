# Calculation v2.1 Programme — tracking

## Conventions

The following conventions govern every prompt in this programme. They are non-negotiable unless explicitly amended in a later approved plan.

- **Version tagging.** HAR model changes are tagged `model_version = "har_v2.1.0"`; revenue changes are tagged `model_version = "revenue_v2.1.0"`. Prior scenario rows and `calc_run_registry` rows are **never** rewritten — v2.0.0 outputs remain immutable for comparison and rollback.
- **Additive migrations only.** Every database migration in this programme adds new tables or new nullable columns. No column drops, no type changes on existing columns, no destructive backfills.
- **No client-facing v1 changes.** No client-facing page or component that reads `keyword_forecasts` (v1) is modified. All new UI lands under `/admin/calculations` or a new admin-only route. Client surfaces continue to read v1 until Gate B promotion.

## Checklist

### Phase 1 — Calibration & correctness

- [x] 1.1 comparison-card labelling
- [x] 1.2 p_att redefinition
- [x] 1.3 expected-value decomposition
- [x] 1.4 synthetic client LPS default
- [x] 1.5 unranked-keyword revenue
- [x] 1.6 SVM wiring
- [x] 1.7 scoring-config wiring
- [ ] 1.8 forward-window monthly split
- [ ] 1.9 content-fit diagnostics
- [x] 1.10 run pinning in admin card

## Gate A — PASSED 17 Jul 2026

Phase 1 closed with the run-picker verification report + Gate A review + three closure fixes (card scenario-merge defect, site-architecture score preservation, this tracking note). Advisor-approved caveats to carry into the evidence pack:

- **(a) Evidence-pack scope.** The TVs Ongoing evidence pack is a **within-v2.1 trajectory** (earliest `har_v2.1.0` era vs latest `har_v2.1.0` era after the content-fit fix). No literal `har_v2.0.0` runs exist on this project. A true v2.0 vs v2.1 comparison is available on **Laptops — General** via the run picker for auditors who require it.
- **(b) v1-vs-v2 divergence caveat (§8, verbatim).** The v1 keyword_forecasts baseline this project's comparison card scopes to (593 rows) was last computed before the current v2.1 kept-keyword set (857 rows) was established. Divergence tiles are therefore comparing partially mismatched keyword populations — treat divergence numbers as directional, not exact, until a v1 recompute realigns the baseline.
- **(c) p_att cross-scenario non-monotonicity is BY DESIGN.** `p_att` is a per-scenario conditional (probability of hitting **that scenario's** target rank), not a monotonic probability across ambition tiers. Gate B calibration tests `p_att` against observed outcomes, not against ordering between scenarios.
- **(d) serp_features truncation follow-up (2026-07-19).** Part-4 remediation missed two fetch sites: `compute-forecasts-v2` used unpaginated `selectIn` and `har-calculation-v2` used a raw `.in(...)`. Both now paginate and dedupe by `(keyword_id, result_type)` first-wins (`serp_features` has no snapshot column, so schema-level "latest snapshot" is not derivable — a follow-up ticket remains open). Both functions redeployed 2026-07-19 12:31:34 UTC. The post-B TVs Ongoing combo run supersedes the Part-4 baseline for that project — see `docs/serp-features-truncation-part-c-report.md` for run IDs, `rows_fetched.serp_features` (expected ≈ 19,756) and `serp_features_distinct` (expected ≈ 4,088), and the corrected metric-matched §3 table.



### Phase 2 — Data quality & CTR

- [ ] 2.1 GSC import upgrade
- [x] 2.2 is_branded classification — full coverage, idempotent; brand-terms override on clients (explicit tokens bypass ≥3-char filter, word-boundary matched); rule-type filter corrected to brand/own_brand (whitelist removed); AO/TVs Ongoing post-fix branded click-share 58.6% (see docs/ao-brand-classification-postfix-verdict-2026-07-19.md).
- [ ] 2.3 device-aware branded-excluded CTR curves
- [x] 2.4 trend-adjusted volume — clamped ±30% forward-volume factor gated by trend_confidence (medium/high); 494/500 signals applied on TVs Ongoing, median factor 0.935 → realistic tp_abs −2.16% vs `c20b602c`; monthly totals conserve to `forward_annual`; `label_mode = forward_projected` preserved. Verification: `docs/prompt-2-4-trend-adjusted-verification-2026-07-20.md`.
 - [x] 2.5 calibration card — edge function deployed; RLS/grants hotfix + aggregation-formula fix + writer-fence + curve restore + CTR-unit fix + base_rank authority + rank-tail (r21–30) coverage complete. **Current Gate B datum (2026-07-20 20:22Z):** snapshot `888002bc-ff56-4c05-89dd-da646d60e052`, `overall_ratio = 1.766861` → **RED, gate not eligible** (transactional 2.169 red; band 4–10 2.87 red; band 11–20 1.35 amber; band 1–3 1.06 green). Base_rank backfill converted 58/143 previously model-blind pairs into scored (kept-keyword `base_rank_source` split: 286 serp_results / 168 dfs_labs / 403 unranked); tier=none scored pairs now **0** (was 7), max ranked pair at r29. Dispersion **widened**: median per-pair 1.94 (was 1.57), IQR 0.86–5.07 (was 0.80–3.31), green share 14% (was 44%), red share 59% (was 37%). Recovered cohort of 58 skews right (median 2.33, ratio 3.35) and accounts for essentially all portfolio over-shoot. Residual is systematic bias on head terms — DFS volume ≫ realised GSC demand on bands 4–10 and r21+ head-brand terms. Verification: `docs/prompt-2-5-calibration-post-baserank-tailcov-verification-2026-07-20.md`. Predecessor `fe5e3d42` retained as pre-fix Gate B baseline.
 - [~] 2.6 content-fit coverage backfill — **skipped** per programme sequencing. **Phase 2 closed** (2.1, 2.2, 2.3, 2.4, 2.5 complete; 2.6 skipped) — Phase 3 awaits advisor ruling on Gate B posture given the H1/H2 decomposition.

### Phase 3 — Discovery, funnel & SERP intelligence

- [ ] 3.1 DFS Labs probe
- [ ] 3.2 funnel schema + module
- [ ] 3.3 funnel wiring + admin card
- [ ] 3.4 discovery function
- [ ] 3.5 GSC long-tail seeds
- [ ] 3.6 SERP-overlap clustering
- [ ] 3.7 cannibalisation v2 rollup
- [ ] 3.8 SERP volatility signal

## Blockers / concerns

Audited against the current codebase (`rg -n "keyword_forecast_scenarios" src supabase`).

- **None material.** The only client-side readers of `keyword_forecast_scenarios` are admin-gated:
  - `src/components/admin/HarV1V2ComparisonCard.tsx`
  - `src/components/admin/RevenueV1V2ComparisonCard.tsx`

  Both are surfaced exclusively under `/admin/calculations`. No page in `src/pages/` (outside `src/pages/admin/`), no hook in `src/hooks/`, and no briefing component reads scenarios. The "no client-facing v1 reader is modified" convention holds as stated.

- **Watch-item — `useForecastResolver` (planned in Phase 2/3):** when the resolver is introduced it must default to v1 whenever `calculations_v2_visible_enabled = false` on the project. This is a wiring-time discipline, not a current blocker.

- **Watch-item — downstream consumers of v1 forecasts:** any future prompt that would wire a scenario read into `src/pages/project/*`, `src/pages/DashboardPage.tsx`, `src/components/briefing/*`, `roadmap-to-success`, `content-plan-generate`, or `export-performance-slides` must first pass through Gate B (the v2 promotion gate). Until Gate B, these consumers remain on v1.

## Deferred refactors / open flags

- **Smart Sync — site-architecture stall (2026-07-20).** Two consecutive Smart Sync invocations on TVs Ongoing left 31 keywords unfulfilled with no client-side error surfaced. Needs edge-function log capture from the `site-architecture` function on the next attempt; triage post Gate B.

- **base_rank ↔ HAR SERP source disagreement (2026-07-20).** On TVs Ongoing, 606/857 kept non-brand keywords have `base_rank IS NULL` with `ranking_lookup_no_match=true` (DFS Labs `ranked_keywords/live` returned no organic row for `target=ao.com`). Yet on 203/606 (33.5%) of those, the HAR `serp_results` snapshot has `ao.com` in the top 20. Root cause is DFS-side (Labs vs SERP endpoint scoping, or vintage skew — `ranking_lookup_checked_at=2026-05-05` vs `serp_results.fetched_at=2026-07-20`). Advisor to rule on whether to re-run ranking-url-lookup, switch Labs to a different endpoint, or backfill `base_rank` from `serp_results`. This unresolved gap keeps ~143 calibration pairs (~1,536 monthly clicks) in the model-blind bucket. See `docs/calibrator-per-pair-dump-2026-07-20.md`.


- **SERP deflator sophistication — Gate B:** round-2 seeds (`ai_overview` intent tiers, `images`, `people_also_search`, `find_results_on`) are **landed** and reduced `svm_unmatched_features` from 142 → 11 on the TVs Ongoing verification run. Still open: calibrate all provisional `serp_feature_ctr_adjustments` multipliers (especially `ai_overview` intent tiers: informational 0.65 / commercial 0.85 / transactional 0.90 / navigational 0.95 / generic 0.80) against GSC actuals before promotion. Later: AI Overview ownership check (client cited within the overview → suppression reduced or turned positive), and device-specific AIO tiers if calibration shows mobile/desktop divergence. Also still open: review the round-1 provisional seeds (`popular_products`, `compare_sites`, `video`, `discussions_and_forums`, `related_searches`) and the alias drift (`image_pack` ↔ `images`, `video_carousel` ↔ `video`).

- **Redeploy verification pattern.** The round-2 `compute-forecasts-v2` redeploy was proven functionally rather than by boot-log timestamp: the new `summary_json.totals` block — which only the new build writes — was present in the first post-deploy run. Recording this as an acceptable (arguably stronger) verification pattern for future edge-function deploys where boot logs are unavailable or unreliable.

- **`missing_svm` drift watch.** Observed a +5 `missing_svm` drift between two runs of identical scope on TVs Ongoing (same HAR snapshot). Not actioned now — treated as noise for a single occurrence. Flag: SERP feature rows shouldn't age between runs that share a HAR snapshot, so if this drift recurs it warrants a look at the SERP-feature read path in `serp-visibility-v2` / `revenue-v2`.

- **Intent-classification quality feeds AIO calibration.** During round-2 verification, the keyword "65 inch" was classified as informational (and therefore received the ×0.65 AIO deflator). The intent tiers are only as good as the underlying intent labels, so Gate B calibration should treat intent-label quality and multiplier calibration as a joint exercise — calibrating multipliers against mislabelled intents would bake the label error into the deflator.

- **Standardise `*_jobs` tables.** Five per-feature job trackers now exist (`detox_jobs`, `categorisation_jobs`, `content_plan_jobs`, `har_jobs`, `brand_classification_jobs`). Deferred: consolidate into one polymorphic `background_jobs` pattern (kind + payload_json) so status polling, resume semantics, and cron cleanup live in one place.

- **Brand classifier — idiom over-match on "no brainer".** "no brainer" is both the client brand and an English idiom; the classifier flags idiom queries (e.g. "no-brainer meaning") as branded. Full-coverage run inflated GSC branded rows from 37 → 73. Harmless for curve exclusion (idiom queries have negligible click volume and are correctly excluded from branded curves regardless). Revisit only if `is_branded` ever feeds client-facing brand reporting.

- **Brand classifier — uncertain re-adjudication on re-runs.** `brand-classification` currently re-routes persisted-uncertain queries to Claude on every run, so idempotent re-runs still show `ai_calls = 1`, not 0. Outcome is idempotent (verdict unchanged). Optional future optimisation: skip Claude for queries already classified in the last N days if AI spend ever becomes material.

- **Brand classifier — short-brand token derivation gap.** The ≥3-character token rule yields zero tokens for `AO` / `ao.com`; this is currently covered by the `brand_terms` override list. Verify token derivation on every new client's first classification, especially for short brand names (2-character brands, single-word brands like `AO`, `EE`, `O2`).

- **Truncation audit — see `docs/truncation-audit-2026-07-18.md`.** Nine sites audited across the v2 calc functions; remediation authorised and shipped (2026-07-18 23:50:35 UTC). `rows_fetched` observability added to every touched function's `summary_json`. Any future mismatch between `rows_fetched` and the true in-scope table count is a truncation regression and must be investigated.

- **Detox/categorisation quality upgrade —** current pipeline is functional but basic; becomes financially load-bearing when category-scope AOV/CVR lands (categoriser output is the pricing join key). Revisit post-Gate-B alongside category conversions.

- **CTR curve regularisation — PAV stopgap (deployed 2026-07-19 18:59 UTC).** `ctr-curves-from-gsc` applies unweighted pool-adjacent-violators isotonic regression per (device, intent) bucket over the ranks actually written, so GSC average-position dilution artifacts (head-bucket inversions like mobile/tx r1 0.31 / r3 0.40 / r7 1.61) no longer flow into pricing. Pre-PAV blended values persisted in `ctr_curve_metadata.raw_ctr_percentage`; per-bucket `ranks_adjusted` / `max_adjustment_pp` in `summary_json`. Deeper fix candidates for Gate B: position-variance-aware bucketing (split queries whose true positions straddle rank boundaries), or per-query impressions-weighted curve building (weight PAV pools by impressions rather than unit). Related observability gap: resolver `curve_confidence` is not copied into scenario `explanation_json` (per first-project-curve report §4) — surface alongside the Gate B curve work.

- **Post-remediation baseline reset — TVs Ongoing.** Pre-remediation registry totals on TVs Ongoing (`8d2213cf-641f-48b1-adc0-9e1e4a549ed2` era and earlier) were computed on truncated reads and are no longer directly comparable. **Canonical post-remediation baseline (Phase-1, supersedes Part-C §2 pair `a8c84ef2…` / `23930e06…`):** HAR `020f70bd-6f2c-4923-8ff7-e055960314e0` (`har_v2.1.0`) + Revenue `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe` (`revenue_v2.1.0`), 2026-07-19 12:52 UTC — cons 244 kw / £2.39M abs / £2.24M inc · real 707 / £11.13M / £10.70M · stretch 835 / £22.33M / £21.65M · current £441,480; identity `Σtp_abs − Σtp_inc − tp_abs_without_incremental.sum ≤ current` passes for all three scenarios directly from `summary_json`. Note: **serp_features union-of-history semantics — no vintage column exists.** See `docs/serp-features-truncation-part-c-3-baseline.md`.

- **`serp_features` vintage stamping — write-side shipped (2026-07-19).** Additive migration added `captured_at timestamptz NOT NULL DEFAULT now()` and nullable `serp_result_id uuid` to `public.serp_features`, plus a `(keyword_id, captured_at DESC)` index. Existing rows carry the migration timestamp as one indistinguishable legacy "union-of-history" snapshot by design (documented on the column via `COMMENT`). Writers updated to stamp `captured_at` explicitly on every insert: `supabase/functions/har-calculation/index.ts` (DataForSEO SERP ingestion, `har-calculation` redeployed 2026-07-19) and `src/components/SerpDataSection.tsx` (CSV import, ships with next frontend build). `serp_result_id` left NULL in both writers — non-organic feature items and CSV imports have no originating `serp_results` row in hand. **Read-side unchanged by design:** `har-calculation-v2`, `compute-forecasts-v2`, and `_shared/serp-visibility-v2.ts` still consume union-of-history via first-wins dedupe by `(keyword_id, result_type)`; the staleness risk remains until Gate B pre-work. **Gate B pre-work item:** once stamped history has accumulated across at least one full refresh cycle per active project, re-scope `serp_features` fetches in `har-calculation-v2` and `compute-forecasts-v2` to the latest `captured_at` batch per keyword; treat rows carrying the migration timestamp as one legacy snapshot for that transition. Only then can the calibration-distortion risk be closed out.

- **v1 setup-page CTR display — cosmetic bug, deferred (2026-07-19).** `src/components/CtrCurveSection.tsx` on the setup page renders stored decimal CTR with a `%` suffix (100× understatement) and shows raw float noise on unformatted values. This is a v1-surface presentation bug only — stored data is correct and the resolver / revenue path is unaffected. **Deferred:** the canonical v2 viewing surface for project curves is `src/components/admin/CtrCurvesCard.tsx` on `/admin/calculations` (Prompt 2.3 runtime verification), which reads `ctr_curves.ctr_percentage` as-stored and renders correctly. The v1 setup-page component is superseded for all v2 work and will not be modified.

- **Cross-tier CTR coherence — Gate B.** `ctr_now` and `ctr_tp` are resolved independently by the CTR resolver, so a rank improvement can occasionally produce `ctr_tp < ctr_now` when the two lookups land on different tiers (observed on 3 keywords on `864ce929` — see monotonicity-identity section of `docs/curve-regularisation-verification-2026-07-19.md`). Candidate fix: prefer a common tier for both lookups (e.g. resolve at the higher of the two tiers, or lock tp to the same tier as now). Deferred to Gate B alongside curve refinement.

- **Calibration GSC read not paginated — Prompt 2.5, awaits advisor ruling.** `supabase/functions/calibration-compute/index.ts:153-156` calls `sb.from("gsc_upload_keywords").select(...).eq("upload_id", ...)` with no `pageThrough`/`selectIn` wrapper, so PostgREST's implicit 1,000-row cap truncates the input. Observed on TVs Ongoing: 1,000 of 25,000 rows read → snapshot notes `gsc_rows=1000 · gsc_non_brand=281` and 36 matches vs 237 available under a full-read SQL join. Same class of bug the `_shared/pgrst-in.ts` utility already fixes elsewhere. Verification: `docs/prompt-2-5-calibration-verification-2026-07-20.md`.

- **Kept-keyword `base_rank` coverage — cross-tier, Gate B.** On TVs Ongoing 606 of 857 kept non-brand keywords (70.7%) carry NULL `base_rank`, which forces `modelledMonthly = 0` in the calibrator for any matched pair without a rank and quietly drags the calibration ratio toward zero. Same NULL rank also affects HAR ladder inputs and Revenue `ctr_now` resolution. Feeder question for Gate B: whether to require a base_rank floor before a keyword can enter the calibrator, and/or to backfill base_rank from GSC average-position when curated rank is missing.

- **DFS close-variant / cluster-normalised volume double-counted per surface form — Gate B.** On TVs Ongoing 585 of 835 kept keywords with a full 12-month volume series (70.1%) sit in a duplicate-annual-volume group; 95.0% of pair-level Σ modelled comes from those groups. Root cause: `keywords_data/google_ads/search_volume/live` returns Google Ads close-variant-normalised (cluster) volume; both writers persist per surface form and discard the `keyword_properties.core_keyword` cluster identifier. Bounded counterfactuals (dedup-by-group max / mean) move the portfolio calibration ratio from 1.77 to 1.11 (max) or 0.61 (mean) — either bound lands green. Evidence: `docs/volume-duplication-diagnostic-888002bc-2026-07-20.md`. No remedy proposed; advisor to rule between cluster-identifier persistence, detox-side de-duplication, or calibrator-side cluster credit.





## Conversion values — provenance register


Navigator projects are **category-scoped**: a single client domain routinely runs multiple projects, one per commercial category (e.g. AO's `TVs Ongoing` vs `TV - World Cup 2026`, Music Magpie's `Laptops - Apple` vs `Laptops - General`). CVR and AOV therefore legitimately differ between projects on the same domain, and the revenue calculation is expected to use the per-project value, not a domain-level one.

The table below is the current provenance register for every active (non-archived) project. Provenance defaults to `assumed — industry standard` unless a client has supplied numbers. Update this table whenever a project's conversion inputs change source.

| Client | Project | CVR (%) | AOV (£) | Provenance |
| --- | --- | ---: | ---: | --- |
| AO | Laundry V1 2026 | 1.00 | 395 | assumed — industry standard |
| AO | Q4 2026 Laundry Campaign | 1.60 | 150 | assumed — industry standard |
| AO | Test | 0.50 | 150 | assumed — industry standard |
| AO | TV - World Cup 2026 | 1.20 | 150 | client-supplied (AOV £150, CVR 1.2%) |
| AO | TVs Ongoing | 1.00 | 400 | assumed — industry standard |
| Bulk | Bulk | 3.00 | 48 | assumed — industry standard |
| Bulk | Health And Wellbeing | 2.20 | 34 | assumed — industry standard |
| Bulk | Sports nutrition | 3.00 | 48 | assumed — industry standard |
| Music Magpie | Books | 3.50 | 10 | assumed — industry standard |
| Music Magpie | DVD/Bluray | 4.50 | 8 | assumed — industry standard |
| Music Magpie | Laptops - Apple | 1.20 | 550 | assumed — industry standard |
| Music Magpie | Laptops - General | 1.60 | 280 | assumed — industry standard |
| Music Magpie | Mobiles - Android | 1.80 | 210 | assumed — industry standard |
| Music Magpie | Mobiles - iPhone | 2.20 | 320 | assumed — industry standard |
| Music Magpie | Music - CDs | 4.00 | 10 | assumed — industry standard |
| Music Magpie | Music - Vinyl | 2.50 | 30 | assumed — industry standard |
| No Brainer Agency | NB Marketing - May 2026 | 2.50 | 40000 | assumed — industry standard |
| No Brainer Agency | SEO | 2.50 | 40000 | assumed — industry standard |
| PillTime | Weightloss | 2.00 | 135 | assumed — industry standard |
| Touchstone Education | Pitch Keywords (1224 AoV 0.2 CVR) | 0.20 | 1224 | assumed — industry standard |
| Touchstone Education | Pitch Keywords (459 AoV 0.27 CVR) | 0.27 | 459 | assumed — industry standard |

> **Open question — operator confirmation required.** `TVs Ongoing` AOV £400 vs `TV - World Cup 2026` AOV £150 — a 2.6× gap between two TV categories on the same AO domain. Confirm which figure reflects category reality (event-driven promotional bundle vs everyday full-range basket) and update provenance for the losing side. No values are being changed here; this is a flagged discrepancy for review.


## Corrections

- **17 Jul 2026 — content-fit zero semantics corrected.** `docs/content-fit-score-in-har-v2.md`'s claim that "0 never means missing URL" was found **false** on 17 Jul: the `site-architecture` edge function's three deterministic branches (Phase 0a no-volume → `watch`; Phase 0b no-URL + volume → `create_content`; `ruleClassify` no-URL + volume < 50) were stamping `relevancy_score = 0` on every keyword they could not evaluate. HAR v2 was reading those zeros as an evaluated-irrelevant verdict and applying a −0.8 content-fit penalty, artificially depressing HAR (and therefore Revenue) on ~2,053 keywords across live projects. Branches now write `NULL`, which HAR v2 correctly treats as "not evaluated" (neutral 0.5 with a confidence penalty). Historical zeros back-filled to `NULL` on non-ranking keywords only — genuine evaluated zeros on ranking keywords (134 rows across TV — World Cup 2026 and Weightloss) preserved. Reserved semantics from this point: `NULL = not evaluated`, `0 = genuine AI/rule evaluated-irrelevant verdict`.

## Phase 2 debt register

Carried forward from Gate A §6 (10 items) plus the two Gate A closure fixes marked resolved-at-closure.

| # | Item | Origin | Status |
| ---: | --- | --- | --- |
| 1 | Partial-status semantics on `calc_run_registry` (currently binary succeeded/failed; `partial` never emitted despite warnings) | Gate A §6 | open |
| 2 | Scenario spread compression — cons/real/stretch HAR positions land within 1–2 ranks on high-confidence keywords, blunting ambition-tier separation | Gate A §6 | open |
| 3 | `scoring_config.config_version` recorded as `"har_v2.0.0"` on v2.1.0 runs (label drift only, no calc impact) | Gate A §6 | open |
| 4 | SVM long tail — 11 `svm_unmatched_features` remain post round-2 seeds; alias drift (`image_pack`↔`images`, `video_carousel`↔`video`) | Gate A §6 | open |
| 5 | Deferred refactor — `_shared/har-v2.ts` scoring branches share code with `revenue-v2.ts` and could DRY out via a shared `applyScoringConfig` helper | Gate A §6 | deferred |
| 6 | Deferred refactor — `compute-forecasts-v2` prefetch loop is O(kw); could parallelise the `selectIn` fetches | Gate A §6 | deferred |
| 7 | Deferred refactor — admin comparison-card queries duplicate scenario-merge logic between HAR and Revenue cards | Gate A §6 | deferred |
| 8 | AI Overview ownership check — client cited within the AIO should suppress the deflator or turn it positive | Gate A §6 / DR #62 | open |
| 9 | Device-specific AIO deflator tiers if mobile/desktop calibration diverges | Gate A §6 / DR #62 | open |
| 10 | Redeploy verification pattern — codify "presence of new-build-only field in `summary_json`" as the fallback when boot logs are unavailable | Gate A §6 / DR #64 | open |
| 11 | **Card scenario-merge defect** — `.limit(1000)` on `keyword_forecast_scenarios` truncated mid-keyword on projects ≥ 333 kw (e.g. TVs Ongoing "100 inch tv" realistic cell empty). Fixed at Gate A closure: keyword-scoped cap with paged fetch. | Gate A Part 1 | **resolved-at-closure** |
| 12 | **Site-architecture score preservation** — deterministic branches overwrote evaluated scores with NULL when a keyword transiently dropped from the SERPs. Fixed at Gate A closure: `site_architecture.last_evaluated_at` + preserve-if-prior-non-null in the three deterministic branches; genuine evaluation paths stamp `last_evaluated_at = now`. | Gate A Part 2 | **resolved-at-closure** |
| 13 | **Trend estimator emits extreme trend_pct at medium confidence** — observed +20,765% on at least one keyword; the ±30% clamp in Revenue v2.1 is the effective control. Estimator robustness (winsorised slopes / confidence recalibration) is a Gate B adjacent item — calibration data (Prompt 2.5) will show whether clamped keywords systematically miss. | Prompt 2.5 pre-work | open |




## Admin QoL notes

- **17 Jul 2026 — /admin/calculations collapsed layout.** All ten diagnostic cards (GSC readiness, Volume History, Demand signals, Demand intelligence, SERP visibility v2 preview, Link Power Score, Content-fit diagnostics, HAR v1↔v2, Revenue v1↔v2, Recent runs) are now wrapped in `CollapsibleSection` (per-page prefix `seer-admin-calc-sections`, all collapsed on first visit). Section bodies are `lazyMount` — heavy child components and their `useQuery` calls do not fire until first expand; the four parent-level queries (`kept-keywords`, `coverage`, `latest-backfill`, `monthly-coverage`, `calc-runs`, `gsc-uploads`) are gated behind `isSectionOpened(id)` to preserve fast page load. LPS card converted from load-more to prev/next pagination (500 rows/page) matching HAR/Revenue cards.
- **Remaining pagination candidates (deferred).** Volume History project probe table, Demand Intelligence inspector table, SERP visibility v2 preview table — all render un-paginated inside their now-collapsed sections. If any becomes annoying at scale, mirror the HAR/Revenue paged-fetch pattern.

## Baselines — TVs Ongoing

- **First forecast on measured project CTR curves (2026-07-19 18:24Z).** HAR `5161f23b-6893-4728-8033-6fc16b9f921b` + Revenue `413f53d2-d683-4a81-b811-45f9193fad4f`. First Revenue v2 run after the CTR provenance-hotfix regeneration (`0dae210f`, 2026-07-19 ~17:49 UTC). CTR provenance flipped from 100% fallback-tier to 100% project-tier; totals moved sharply lower (realistic tp_incremental £10.70M → £0.82M, −92.3%). Full evidence in `docs/first-project-curve-forecast-verification-2026-07-19.md`. **This pair supersedes `020f70bd` / `81a76dc5` as the successor baseline going forward.**
 - **Last seed-curve baseline (2026-07-19 12:52Z).** HAR `020f70bd-6f2c-4923-8ff7-e055960314e0` + Revenue `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe`. Kept on record for historical comparison — this is the final pair that read the seed fallback CTR curves before project-measured curves went live for TVs Ongoing.
 - **Measured-curve (pre-PAV) baseline (2026-07-19 18:24Z).** HAR `5161f23b-6893-4728-8033-6fc16b9f921b` + Revenue `413f53d2-d683-4a81-b811-45f9193fad4f`. First fully project-measured pair; exposed the head-bucket inversions that motivated PAV regularisation.
 - **Regularised-measured baseline (2026-07-19 19:01Z).** CTR `2f06f121-077d-4ee6-83d7-3eb67ca75b13` + HAR `864ce929-d53f-4e7c-8ddc-12d5cb9a7482` + Revenue `c20b602c-03a3-4d2e-9b5d-15e0f7ffb9ee`. Last pair before the trend-adjusted era; retained for Prompt 2.4 delta comparisons. Verification: `docs/curve-regularisation-verification-2026-07-19.md`.
 - **Trend-adjusted baseline (2026-07-20 13:21Z) — current working baseline for Prompt 2.5.** CTR `2f06f121` (unchanged) + HAR `6ddacc39-eaa9-4d17-821a-0feaa62df8c5` + Revenue `be83a5e7-865a-4be2-b4f5-c2afc2c932bc`, supersedes `864ce929`/`c20b602c`. Lineage: seed-curve era → measured-curve era → regularised-measured era → **trend-adjusted era**. Verification: `docs/prompt-2-4-trend-adjusted-verification-2026-07-20.md`.

## Global CTR fallback ladder restored (2026-07-19)

Cleanup of v1 junk fallbacks in migration `20260719174843` also removed the per-project seed ladders (1,280 rows across 25 projects, pre-delete count logged via `RAISE NOTICE`). Replaced by a single global ladder at `project_id IS NULL, is_fallback = true` (**360 rows**: 3 devices × 6 intent slots × 20 ranks, values sourced verbatim from `STANDARD_CTR` in `supabase/functions/ctr-curves-from-gsc/index.ts`). Per-project fallback copies are retired as an architecture; resolver tiers 5-7 in `_shared/ctr-resolver-v2.ts` are now backed by the global ladder as intended. Caller query (`compute-forecasts-v2` line ~250) already fetches these via `is_fallback.eq.true`; no code change required. Unique index rebuilt on `COALESCE(project_id::text,'')` so global rows cannot duplicate. Verification report: `docs/global-fallback-ladder-verification-2026-07-19.md`.

## Programme north star

End-state onboarding pipeline: **client setup** (domain, competitors, funnel-aware AOV/CVR) → **keyword intake from all sources** (DFS Labs discovery for own + competitor ranking keywords, SAfS upload where GSC access exists, manual additions) → **detoxification + categorisation** (remove unfit keywords — number strings, foreign-language, unrelated — and categorise by product type, BEFORE any paid per-keyword enrichment spend) → **SERP/link/volume drawdown on kept keywords only** → **v2 calculations**. Clients without GSC access forecast on the global fallback CTR ladder at honest fallback provenance; SAfS upload upgrades them to measured project curves with no other change. Every remaining prompt is checked against this flow.
