# Seer® Calculation Improvements — Lovable Alignment Response

**Prepared for:** Jake McCreith / No Brainer Agency
**Purpose:** Direct answers to the other LLM's alignment document, grounded in the actual Seer code and live database. Confirms what is factually correct, corrects anything that is not, and answers all 38 open questions in section 8.
**Status:** Analysis only. No code, schema, migration, edge-function, secret, or UI change has been made. This document is intended as an input to the next brainstorming round, ahead of prompt-sequence drafting.
**Primary input:** `seer_calculation_improvements_alignment_response.md` (uploaded), plus prior `calculation-improvements-viability-review.md`.

---

## 1. Executive alignment

We agree with the framing. The programme should be additive, shadow-mode, versioned, and gated by a project-level flag. The 10-phase sequencing (v2 scaffolding → CTR from GSC → SERP deflators → Link Power Score → HAR v2 → Revenue v2 → Demand Intelligence → admin inspector → user-facing UI → later API workstreams) matches what Seer's current data model can safely absorb.

Three framing corrections carry over into the answers below:

1. **Authority signals for Link Power Score / HAR v2 do not live on `har_results` or `keyword_forecasts`.** They live on `serp_results` (per SERP position: `url_rating`, `domain_rating`, `ahrefs_rank`, `referring_domains`, `backlinks`) and on `client_domain_metrics` (per project domain). Earlier notes that implied "already stored on `keyword_forecasts` / `har_results`" were wrong; the fields exist, just on the SERP table. This does not change the conclusion — inputs are already stored — it only changes the join path.
2. **Demand Intelligence is currently gated hard by data coverage.** Live audit: 2,528 keywords with any monthly history, **min = median = max = 12 months** per keyword, range `2025-04-01 → 2026-05-01`. Multi-year YoY and seasonally-adjusted trend detection is not possible on current data. Only the "≈12 months" MVM model applies today.
3. **`gsc_uploads` has no date-range columns.** Only `uploaded_at`. `ctr_curve_metadata.date_range_start / date_range_end` cannot be filled from existing rows without new columns on `gsc_uploads` (or a CSV re-parse). Confirmed in section 8.2 below.

Otherwise, the alignment document is directionally correct and ready to move into prompt sequencing once section 8 answers are agreed.

---

## 2. Confirmations — item-by-item verdict

| # | Alignment doc claim | Verdict | Ground truth |
|---|---|---|---|
| 1 | v1 HAR uses URL Rating alone (`client UR ≥ competitor UR`) | ✅ Confirmed | `supabase/functions/har-calculation/index.ts` compute loop; `har_results` stores `client_url_rating`, `har_competitor_ur` only |
| 2 | Missing competitor authority can produce a **spuriously high** HAR (not null) | ✅ Confirmed | Competitors with null UR collapse to 0 in the comparator; the HAR loop then treats client as beating them at rank 1 |
| 3 | `har_revenue_gain_annual` is absolute TP revenue, not incremental gain | ✅ Confirmed | `compute-forecasts/index.ts` L228-236, `useDashboardData.ts`, `ProjectOverviewPage.tsx`, `PerformanceDashboardSection.tsx`, `HarAnalysisSection.tsx`, `ForecastTabHeader.tsx`, `roadmap-to-success/index.ts`, `PerformanceOutputSection.tsx`, `CaptureWindowPage.tsx` all read it as an absolute figure |
| 4 | `ctr_curves` schema is `(project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback)` | ✅ Confirmed. It also has a `uuid id` PK | information_schema |
| 5 | `gsc_upload_keywords` has no `device` and no brand flag; device comes via `gsc_uploads` | ✅ Confirmed | Cols: `id, upload_id, keyword, clicks, impressions, ctr, position (numeric), search_intent`. Parent `gsc_uploads` carries `device` and `project_id` |
| 6 | Seasonality fields already on `keyword_forecasts` (`seasonal_urgency`, `is_in_capture_window`, `months_to_peak`, `peak_source`) | ✅ Confirmed | Populated by `compute-forecasts/index.ts` |
| 7 | Use `serp_features` (per-keyword aggregate) for CTR deflation, `serp_landscape` (per-position) for HAR difficulty | ✅ Confirmed as the right split | `serp_features` = 1 row/keyword; `serp_landscape` = many rows/keyword with `ranking_url`, `owned`, `device` |
| 8 | Demand Intelligence gated by monthly-volume coverage; current ingest may be ~12 months | ✅ Confirmed **and stricter than assumed**: 100% of stored keywords sit at exactly 12 months. No 24m+ tail today | Live query on `keyword_monthly_volumes` (2,528 keywords, p25=median=p75=max=12) |
| 9 | Manual HAR override via `keyword_forecasts.har_is_manual` already exists | ✅ Confirmed | `compute-forecasts/index.ts` L221-224 |
| 10 | Link Power Score inputs (UR, DR, ahrefs_rank, referring_domains, backlinks) already stored | ✅ Confirmed **but** on `serp_results` (per SERP position) + `client_domain_metrics` (per project). Not on `har_results` or `keyword_forecasts` | information_schema |
| 11 | Existing seasonality columns can be extended, not duplicated, by demand-signal tables | ✅ Confirmed. Keep `keyword_forecasts.seasonal_urgency` / `is_in_capture_window` untouched | — |
| 12 | Should split Link Power Score before HAR v2 | ✅ Agree — LPS is validatable independently and feeds HAR v2 as one input |  — |
| 13 | SERP deflators can ship earlier because inputs exist | ✅ Agree. `serp_features` is already computed on every synced keyword |  — |
| 14 | Brand/non-brand CTR splitting can be deferred | ✅ Agree. There is precedent for brand-token matching inside `keyword-categorisation` via `keyword_rules(rule_type IN ('own_brand','competitor_brand'))`, but it is not exposed as a shared helper. Extracting it is doable, just not free |  — |
| 15 | Admin v1↔v2 inspector must ship before user-facing scenario UI | ✅ Agree. Change-management justification is genuine — expected uplift will be materially lower than current TP revenue for most keywords | — |

**One item to strike from the alignment doc:** the phrase "Ahrefs data on `har_results` / `keyword_forecasts`" (implied in the earlier viability review). Replace with "on `serp_results` per SERP position + `client_domain_metrics` per project domain". Everything else in section 4 of the alignment doc is accurate.

---

## 3. Answers to the 38 open questions (§8)

### 8.1 Data availability

**Q1. Distribution of `keyword_monthly_volumes` months per keyword.**
Live query result today:

```
keywords_with_history: 2,528
min:    12
p25:    12
median: 12
p75:    12
max:    12
earliest month: 2025-04-01
latest month:   2026-05-01
```

Every keyword with volume history has **exactly 12 months**, always the trailing 12 from the DataForSEO fetch date. There is no distribution to draw from — coverage is uniform at 12.

**Q2. Does DFS enrichment usually store exactly 12 months, or can it store more?**
Currently it stores exactly 12. The DFS `keyword_data` / `search_volume` endpoints Seer calls return a `monthly_searches` array capped at the last 12 months, and the ingest writes one row per returned month. To get more, we would either need to call the historical-search-volume endpoint (higher cost, deeper history) or persist prior fetches instead of overwriting them. Recommendation: **write-append with a `fetched_at` per row**, so successive syncs accumulate history, rather than switching to the historical endpoint immediately.

**Q3. Is `keyword_monthly_volumes.month` a full date?**
Yes. `data_type: date`, stored as `YYYY-MM-01` (project memory rule already codifies this). Year is fully preserved — the 12-month limit is an ingest-side constraint, not a schema constraint.

**Q4. Is `serp_landscape` reliably populated for every HAR-analysed keyword?**
It is populated on every keyword that completes a SERP fetch via `serp-feature-upsert` (called during the HAR SERP-task pipeline and during `ranking-url-lookup`). Coverage is therefore effectively 1:1 with HAR-analysed keywords, but the row set only reflects positions returned in the top-N of the SERP response (`rank_absolute` from `serp_results`) — features beyond that window are not landed. Safe to consume for HAR difficulty; not safe to assume it contains every possible SERP element.

**Q5. Is `serp_features` always populated when HAR completes?**
Yes — the HAR SERP task upserts a `serp_features` row (aggregate) alongside the `serp_landscape` rows. If HAR skipped a keyword (no volume, no manual, or job failure), `serp_features` may be absent. Treat "missing `serp_features`" as a data-quality flag rather than an assumption failure.

### 8.2 GSC uploads & CTR curves

**Q6. Can every `gsc_upload_keywords` row be reliably joined to `gsc_uploads.project_id` and `.device`?**
Yes. `gsc_upload_keywords.upload_id` is `NOT NULL` with `ON DELETE CASCADE` to `gsc_uploads`. Both `project_id` and `device` on the parent are `NOT NULL`. The join is safe.

**Q7. Does `gsc_uploads` contain date-range fields for `ctr_curve_metadata`?**
**No.** `gsc_uploads` columns: `id, project_id, uploaded_at, device, row_count`. There is no `date_range_start` / `date_range_end`. Options: (a) add two `date NULL` columns and populate on upload from the CSV; (b) skip range in `ctr_curve_metadata` v1 and only record `generated_at` + `sample_impressions`; (c) infer from the earliest / latest `gsc_upload_keywords` row per upload if the CSV carries dates. Recommendation: option (a) — add `date_range_start`/`date_range_end` to `gsc_uploads` in the Phase 1 scaffolding migration; back-fill left NULL for historical uploads and treated as "unknown range" in the UI provenance chip.

**Q8. Is `gsc_upload_keywords.position` decimal? Round, floor, or bucket?**
Yes, `data_type: numeric` — GSC exports decimal average positions (e.g. `4.72`). Recommendation: **round to nearest integer, clamp to 1–20**, and drop rows where `position > 20.5`. This is symmetric with `compute-forecasts`' `Math.round(position)` treatment and preserves interpretability. Any decimal-aware bucketing (e.g. 0.5 buckets) is worth revisiting only if sample sizes become the bottleneck.

**Q9. `ctr_curves` primary key or mirror grain?**
`ctr_curves` has a `uuid id` PK. Cleanest link is `ctr_curve_metadata.ctr_curve_id → ctr_curves.id` with a unique index on `(project_id, device, intent_segment, rank_position)` on `ctr_curves`. Recommendation: **reference the id**, and enforce the composite unique constraint on `ctr_curves` so the metadata cannot fork from the curve set.

**Q10. Curves at project or client level?**
Project first, as proposed. Client-level roll-up can be a materialised view later; nothing in the current pipeline reads across projects. Confirming your preference.

### 8.3 Brand / non-brand handling

**Q11. Any existing brand-token matcher?**
There is precedent, not a shared helper. `keyword_rules` accepts `rule_type IN ('whitelist','blacklist','competitor_brand','own_brand')` (`supabase/migrations/20260319153821_...sql`), and `keyword-categorisation/index.ts` L621-622 fetches those rules to steer categorisation. There is **no exported utility** that classifies an arbitrary keyword string as own-brand / competitor / neither. Building one is a ~50-line change (rule loader + tokenised match against keyword text) but it is a new module, not a "reuse existing helper" — hence the "defer" recommendation.

**Q12. Would adding a keyword-level brand flag be small?**
Small on the schema side (one `text` column or a boolean pair). Medium on the ingest side — `keyword-categorisation` would need to emit the flag, `keyword-detox` would want to consume it (brand rescues), and the CTR generator would need to segment on it. It touches three edge functions and one table. Not trivial, not enormous. **Defer to v2.1 unless the CTR delta between brand and non-brand curves becomes a blocker during admin inspection.**

**Q13. Defer brand/non-brand CTR splitting?**
**Yes, defer.** Ship the first-cut CTR generator on `project | device | intent | position`. Add brand splitting after LPS + HAR v2 + Revenue v2 stabilise.

### 8.4 HAR v2 and Link Power Score

**Q14. `link_power_scores` own table or components on `keyword_forecast_scenarios`?**
**Own table (Option A).** Two reasons: (i) LPS should be shippable and inspectable before HAR v2 exists, so it can't be embedded in a scenarios row that doesn't yet write; (ii) LPS is per-URL, not per-scenario — repeating six identical component columns across three scenarios wastes storage. Keep components on `link_power_scores`, then let `keyword_forecast_scenarios.link_power_score` and `link_gap_score` be scalar references.

**Q15. LPS per keyword/SERP URL, per project URL, or both?**
Both, but computed once. Compute per `serp_results` row (per-URL) — that gives the competitor scores HAR v2 needs. Aggregate the client's own domain into a project-level LPS via `client_domain_metrics` for UI headlines. Store per-URL rows in `link_power_scores`; derive project aggregate in a view or on read.

**Q16. Can `site_architecture.relevancy_score` be reliably joined to keyword+URL?**
Partially. `site_architecture` rows are written by `site-architecture/index.ts` and `useNavigatorSync.ts` for keywords that have gone through the architecture pass; the join key is `keyword_id + matched_url`. Coverage is not 100% — keywords whose architecture run failed, or projects that have not run architecture yet, will have `relevancy_score = NULL`. Treat missing as "unknown", not zero.

**Q17. Safest content-fit fallback when `site_architecture` is missing?**
**Neutral score (0.5) with a `content_fit_source = 'fallback'` flag**, plus a data-quality penalty applied downstream in the HAR v2 scoring config. Do not use a category match score as fallback — it double-counts intent, which is already an input.

**Q18. HAR v2 standalone function, or share utilities with v1?**
**Standalone function (`har-calculation-v2`) that imports pure helpers from a new `supabase/functions/_shared/har.ts` module.** Do not touch the v1 function. Any code v1 needs must be duplicated into the shared module first, then referenced from both — refactor v1 to consume it in a later, isolated PR after v2 is stable.

### 8.5 Revenue v2

**Q19. Which UI hooks/surfaces consume `keyword_forecasts.har_revenue_gain_annual`?**
Full list from a repo scan:

- `src/hooks/useDashboardData.ts` (client dashboard TP Revenue Uplift headline)
- `src/pages/project/ProjectOverviewPage.tsx` (Briefing OS TP revenue metric + priority splits)
- `src/pages/CaptureWindowPage.tsx` (`harRevenueGain` field)
- `src/components/HarAnalysisSection.tsx` (HAR-with-revenue count + total)
- `src/components/PerformanceDashboardSection.tsx` (`totalHarRevenueGain`, priority breakdown)
- `src/components/PerformanceOutputSection.tsx` (CSV export column)
- `src/components/forecast/ForecastTabHeader.tsx` (forecast tab header metrics)
- `supabase/functions/roadmap-to-success/index.ts` (roadmap prompt input as `tp_revenue_uplift`)
- `supabase/functions/har-calculation/index.ts` (documentation only — the compute lives in `compute-forecasts`)
- `supabase/functions/compute-forecasts/index.ts` (writes the column)

Any v2 resolver must keep every one of these paths pointing at v1 numbers until the project's `calculations_v2_visible_enabled` flag flips.

**Q20. Scenario-aware hook or a v2 view?**
**Both, but hook first.** Introduce `useProjectForecasts({ scenario })` (or an equivalent) which reads `keyword_forecast_scenarios` when the v2 flag is on and falls back to `keyword_forecasts` otherwise. Add a database view (`v_keyword_forecasts_scenario`) later only if PostgREST filtering ergonomics become painful. A view alone is not enough because callers need scenario-selection semantics that don't collapse cleanly into a single view.

**Q21. Show v2 expected incremental alongside v1 TP revenue in the same card?**
Only in the admin inspector. In user-facing surfaces the answer is no — show v2 replacing v1 (with a small "Model: v2 realistic" chip) once visibility is on, and v1 alone until then. Two side-by-side revenue numbers in the same headline card is exactly the confusion the shadow-mode gating is meant to avoid.

**Q22. Wording when v2 expected < v1 TP?**
Recommended labels:

- **v1**: "TP Revenue (theoretical)"
- **v2 realistic**: "Expected uplift (12-month)"
- **v2 stretch**: "Upside range"
- **v2 conservative**: "Downside range"

Explainer copy in the drawer: *"Expected uplift multiplies the theoretical top-position revenue by the model's confidence that this keyword can actually attain that position. Lower than TP Revenue is the expected behaviour."*

### 8.6 Conversion overrides

**Q23. Where should the conversion override UI live?**
Under a new tab on the existing project workspace: `/clients/:clientId/projects/:projectId/settings/conversions`, or as a sub-section of `NavigatorProjectFormPage` (Project Setup → Conversions). Do not put it on `ClientOnboardingPage` — that is client-level, and overrides are project-scoped.

**Q24. Who can edit overrides?**
**`admin` and `super_admin` only** at RLS level. `user` can read (so forecasts still explain themselves), `view_only` reads through the standard `is_visible_project` gate. This matches the existing Admin/Users RBAC pattern.

**Q25. Require notes/reason on change?**
Yes, at least for URL-level and category-level overrides. Site-wide / intent-wide overrides could be optional. Enforce via a `NOT NULL notes` column when `scope_type IN ('url','category')` via a CHECK constraint.

**Q26. Include override provenance in explanation JSON?**
Yes. `explanation_json.conversion_source = { cvr: 'url_override', aov: 'project_default', override_id: '…' }`. That is what makes forecasts auditable.

### 8.7 Feature flags and rollout

**Q27. One flag or two?**
**Two flags** — the added complexity is a single extra boolean and one extra guard in each read site. `calculations_v2_compute_enabled` (server-side scheduler gate) and `calculations_v2_visible_enabled` (client-side reader gate). This is what makes admin inspection viable — compute must run without users seeing the outputs.

**Q28. Nightly compute for all synced projects, or selected only?**
Selected projects first, admin-flipped one at a time until compute stability is verified (particularly for HAR v2 SERP-diff logic). Then enable a nightly `pg_cron` sweep over all projects with `calculations_v2_compute_enabled = true`.

**Q29. Where should the admin inspector live?**
Under `/admin` (existing area — `UsersPage`, `ArchivePage` already live there): `/admin/calculations` with sub-routes for run history, per-project diffs, and per-keyword drilldowns. Not in project settings — analysts should be able to compare across projects.

**Q30. Should `view_only` see calculation runs?**
No for inspector detail. Yes for the final chosen scenario values, once visibility is on for a project. Enforce at RLS with `has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'super_admin')` for the inspector tables; standard `is_visible_project` for the scenario outputs.

### 8.8 Exports and downstream AI

**Q31. How many export surfaces use v1 forecast numbers?**
Three today: `src/components/PerformanceOutputSection.tsx` (CSV export), `src/lib/exportSlides.ts` (client-side slide export), `supabase/functions/export-performance-slides/index.ts` (server-side slide export). All three read `har_revenue_gain_annual` and `yearly_revenue_gain_rank1`. Any v2 model must add a version stamp to each of these outputs before it can be shared externally.

**Q32. Can slide exports be version-stamped?**
Yes, cheaply. Add a `Forecast model: v1` / `Forecast model: v2 realistic` line to the export header block in both slide exporters and to the CSV filename (`…_v1.csv` / `…_v2_realistic.csv`). This is a small string addition; not a blocker.

**Q33. Should roadmap and content-plan payloads use v2 as soon as computed, or only when visible?**
**Only when `calculations_v2_visible_enabled = true`** for the project. Otherwise the roadmap prose diverges from what the user sees on-screen — worst-of-both-worlds. Roadmap and content-plan prompts must read from the same resolver hook as the UI.

**Q34. Extra numeric fields in roadmap payloads — prompt drift risk?**
Low if fields are added as explicitly-named JSON keys with unit suffixes (e.g. `expected_incremental_revenue_annual_gbp`) rather than as free prose. The current roadmap prompt already accepts a structured `tp_revenue_uplift` per keyword; adding `expected_uplift`, `confidence`, `scenario` alongside it does not require prompt-copy changes, only a schema-note update. Do add a one-line note to the prompt like *"Prefer expected_uplift over tp_revenue_uplift when both are present"* to prevent the model averaging them.

### 8.9 RLS and migrations

**Q35. RLS pattern for new project-scoped v2 tables.**
Match the existing `gsc_uploads` / `keyword_forecasts` pattern:

```sql
ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to <table>"
  ON public.<table> FOR ALL TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'user'))
  WITH CHECK (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'user'));

CREATE POLICY "View-only see assigned <table>"
  ON public.<table> FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'view_only') AND public.is_visible_project(project_id));
```

For tables that lack a direct `project_id` (e.g. `link_power_scores` if you scope it by URL not project — but you shouldn't; keep `project_id` on every v2 table), route via `public.is_visible_project((SELECT project_id FROM parent WHERE …))` as the existing `gsc_upload_keywords` policy already does. **Every v2 table must carry `project_id` as a column** — do not shortcut this even for lookup tables like `serp_feature_ctr_adjustments` (that one is global config, keep it admin-only).

**Q36. Should `project_conversion_overrides` be RLS-restricted or UI-guarded?**
**RLS-restricted.** UI guards alone are bypassable via direct PostgREST calls. Write policies must check `has_role(auth.uid(),'admin')` or `has_role(auth.uid(),'super_admin')`.

**Q37. Migration-order constraints from generated Supabase types?**
One: `src/integrations/supabase/types.ts` is regenerated after every migration. If a migration introduces a table that another migration in the same PR references (e.g. a foreign key), split them so each migration compiles independently. Otherwise no ordering constraint. Also: `har_scoring_config` and `serp_feature_ctr_adjustments` must be seeded in the same migration that creates them, or edge functions written against empty tables will crash on first invocation.

**Q38. One scaffolding migration or split by family?**
**Split into four migrations** in this order, purely for reviewability and rollback safety:

1. `calculation_model_runs` + shared enums + feature flags on `navigator_projects`.
2. `ctr_curve_metadata` + `serp_feature_ctr_adjustments` + `har_scoring_config` (+ their seed rows).
3. `link_power_scores` + `keyword_forecast_scenarios`.
4. `project_conversion_overrides` + `keyword_demand_signals` + `category_demand_signals`.

Grants and RLS in the same migration as the table (per project memory rule).

---

## 4. Amendments to the v2 scaffolding plan

Small changes to section 6 of the alignment doc.

- **6.7 `ctr_curve_metadata`**: reference `ctr_curves.id` via `ctr_curve_id uuid REFERENCES ctr_curves(id) ON DELETE CASCADE`; add a `UNIQUE (ctr_curve_id)` constraint. Add a `UNIQUE (project_id, device, intent_segment, rank_position)` on `ctr_curves` itself to guarantee 1:1.
- **6.7 date ranges**: cannot be filled from `gsc_uploads` today. Add `date_range_start date`, `date_range_end date` to `gsc_uploads` in the same migration; leave NULL for legacy rows.
- **6.3 `link_power_scores`**: add `serp_result_id uuid REFERENCES serp_results(id)` and `rank_absolute int`. This is what makes per-position LPS joinable back to the SERP.
- **6.4 `keyword_demand_signals`**: add `data_coverage_months smallint NOT NULL` so the reader can suppress badges when history is thin (which is today's universal state).
- **6.9 `har_scoring_config`**: add `is_active boolean` and require exactly one active row per `version` band; edge functions read the active row on start.
- **6.10 Feature flags**: two flags as recommended in Q27. Default both `false`. Admin UI toggles them per project.

Everything else in section 6 stands.

---

## 5. UI / UX overlay — additive-only surfacing

None of the following alters v1 surfaces until `calculations_v2_visible_enabled = true` on a given project.

- **`ProjectOverviewPage.tsx`** — under the current "TP Revenue Uplift" card, add a secondary "Expected uplift (v2)" line with the model chip. When v2 visibility is on, promote it to the primary metric and demote v1 to a tooltip labelled "Theoretical TP revenue".
- **`ForecastTabHeader.tsx`** — add a scenario toggle (`Conservative | Realistic | Stretch`) to the header, initialised to Realistic. Only rendered when v2 visibility is on.
- **`HarAnalysisSection.tsx`** — add a "Why this HAR?" drawer that reads `keyword_forecast_scenarios.explanation_json` and shows the Link Power Score gap, the SERP visibility multiplier, and the observed-rank clamp status. Available in admin inspector even when v2 visibility is off.
- **`CtrCurveSection.tsx`** — provenance chip (source, sample impressions, confidence) fed from `ctr_curve_metadata`. Renders whether v2 visibility is on or off — the chip is a data-quality signal, not a v2 output.
- **`CaptureWindowPage.tsx`** — new filter for demand trend (`declining | stable | growing`) fed from `keyword_demand_signals`. Muted / hidden when `data_coverage_months < 24` — which is today's universal state — with a tooltip explaining why.
- **`ContentPlanDetailPage.tsx`** and roadmap views — read via the shared resolver; nothing UI-specific to build.
- **Slide + CSV exports** — model version stamped in the header line and filename, as per Q32.
- **Admin `/admin/calculations`** — new area, three tabs (Runs, Per-project diff, Per-keyword drilldown). Shows v1 vs v2 side-by-side, flags divergence over the configurable threshold (default ±35%).

No new primitive components required beyond what the existing Briefing OS already offers (`BriefingCard`, `DeltaChip`, `InsightQuote`, `MetricHelp`). Scenario toggle can reuse the existing shadcn `ToggleGroup`.

---

## 6. Guardrails & cross-cutting notes

- **Batch/URL-length pitfalls**: `compute-forecasts/index.ts` L138-148 documents a real production incident where `.in()` filters with ~500 UUIDs silently returned zero rows and produced £0 TP Revenue. Every v2 edge function that fans out over `keyword_ids` must respect `LOOKUP_BATCH ≈ 100`. Enforce via a shared `chunkedIn` helper in `supabase/functions/_shared/`.
- **Rate limits**: v2 does not add DFS or Ahrefs calls in phases 1–6 (all inputs reuse stored data). The first phase that introduces new external calls is any expansion beyond ~12 months of monthly volume history in Phase 7 — cost this out separately.
- **Telemetry**: add a lightweight `calculation_run_metrics` row (or reuse `calculation_model_runs.summary_json`) per run recording `n_keywords`, `v1_vs_v2_revenue_delta_median`, `v1_vs_v2_revenue_delta_p90`, `n_keywords_over_threshold`. The admin inspector reads this directly.
- **Migration ordering**: as answered in Q38.
- **AI usage**: the v2 calculation programme adds **zero new LLM calls**. Guardrail 24-25 in the alignment doc is correct and unambiguous — no LLM is producing HAR, CTR, CVR, AOV, LPS, or revenue.
- **Existing project memory**: dark theme + Briefing OS primitives already codify how v2 surfaces should look. No new visual system needed.

---

## 7. Residual items needing a product decision

These are the questions Lovable cannot answer from code alone. They need a call from Jake:

1. **Monthly-volume history strategy**: append historical DFS rows (write-append with `fetched_at`), or switch to the historical-volume endpoint? Cost-vs-value call.
2. **Threshold for v1↔v2 divergence flagging in the admin inspector** — default proposed is ±35%; is that the No Brainer analyst comfort zone?
3. **When to actually flip `calculations_v2_visible_enabled` on the first live client** — needs criteria (e.g. "median absolute divergence < X% for at least N keywords" plus manual analyst sign-off).
4. **User-role edit rights on `project_conversion_overrides`** — recommended admin-only, but confirm.
5. **Brand-flag deferral timing** — is v2.1 acceptable, or should brand splitting be pulled into v2 before user-facing rollout because agency clients frequently ask "brand vs non-brand" during forecast reviews?

---

## 8. Bottom line

The alignment document's direction is factually sound and every scoping call (Additive v2, LPS before HAR v2, SERP deflators pulled forward, GSC/GA4 APIs and brand splitting deferred, admin inspector before user UI) matches what Seer's code and data can support without destabilising v1.

The two facts that most tighten the plan versus the current draft:

- **Demand Intelligence has no 24m+ tail to draw from today.** Ship the ≈12-month MVM model only, and treat historical volume expansion as its own workstream.
- **`gsc_uploads` has no date-range columns.** Add them in Phase 1, or accept that `ctr_curve_metadata` will carry only sample-size and confidence for the first release.

Otherwise, once the section 3 answers above are agreed with the other LLM, we are ready to move into prompt-sequence drafting.
