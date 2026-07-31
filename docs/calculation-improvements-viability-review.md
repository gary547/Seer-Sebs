# Seer — Calculation Improvements Proposal: Viability Review

**Reviewer:** Lovable (grounded in current Seer code + schema)
**Source doc:** `SEER_Calculation_Improvements.md` (v2, 1,110 lines)
**Status:** Read-only analysis. No code, schema, prompt, or UI changes made.
**Companion refs:** `docs/data-and-calculations-audit.md`, `docs/ai-prompt-companion.md`, `src/integrations/supabase/types.ts`, `supabase/functions/*`.

---

## 1. Executive verdict

| Area | Verdict | Headline |
| --- | --- | --- |
| **Shadow-mode v2 layer** (§2, §12) | 🟢 Green | Fully feasible. Requires 4-6 additive tables + a versioned "run" concept. Zero risk to v1 if scoped strictly additive. |
| **HAR v2 composite score** (§5) | 🟢 Green | All input signals (`url_rating`, `domain_rating`, `ahrefs_rank`, `referring_domains`, `backlinks`, `relevancy_score`, `serp_features`) already land in the database. No new API calls required for the first cut. |
| **Revenue v2 (scenarios + monthly + expected incremental)** (§6) | 🟡 Amber | Formula is straightforward but the current model is *deeply* embedded in `compute-forecasts` and consumed by ~10 UI surfaces. Needs a v2 write-only path and a UI-level scenario resolver before any surface can safely toggle. |
| **CTR curves from GSC uploads** (§7.4) | 🟡 Amber | Data exists, but `gsc_upload_keywords` does **not** carry `device` (only the parent `gsc_uploads` row does) and carries no brand flag. `ctr_curves` has no `source` / `sample_size` / `confidence` columns yet — those must be added. |
| **GSC API integration** (§7.3) | 🟡 Amber | Correctly deferred. No OAuth infra, no refresh-token store, no GSC-property↔client mapping exists today. Confirmed serious lift. |
| **GA4 CVR/AOV + manual overrides** (§8) | 🟢 Green (overrides) / 🔴 Red (API integration this phase) | Manual `project_conversion_overrides` is a clean additive win. GA4 API integration should stay out of this workstream — nothing in the codebase supports it. |
| **SERP feature deflators** (§9) | 🟢 Green | Data already collected (`serp_features` per-keyword + `serp_landscape` per-result). Deflator table + CTR resolver hook is small. Must decide *which* table drives the multiplier. |
| **Demand Intelligence** (§10) | 🟡 Amber | Trend maths and category rollups are feasible, but multi-year detection depends on how many months `keyword_monthly_volumes` actually holds per keyword — this is a **data-availability question**, not a code question. |
| **Link Power Score** (§11) | 🟢 Green | All inputs already stored on `serp_results` and `client_domain_metrics`. First cut can ship without any new integration. |
| **Proposed schema additions** (§12) | 🟢 Green with corrections | Table shapes are broadly sound; several columns duplicate ones Seer already has (`har_is_manual`, `seasonal_urgency`, `is_in_capture_window`) — see §3 fact-check. |
| **10-phase plan** (§13) | 🟡 Amber | Sequencing needs 3 adjustments — see §6 of this review. |
| **Guardrails** (§14) | 🟢 Green | All 14 guardrails are compatible with Seer's current architecture. Adopt verbatim. |

---

## 2. What Seer actually does today (baseline snapshot)

Grounded in code, not memory. These are the facts every proposal claim must line up against.

### 2.1 HAR (from `supabase/functions/har-calculation/index.ts`, lines ~980–1050)

```ts
let kwClientUR = clientMetrics.url_rating;              // client-domain fallback
if (kw.ranking_url) kwClientUR = ahrefsMap[u]?.url_rating ?? kwClientUR;

for (const c of serps ?? []) {                          // walk SERP by rank_absolute asc
  const cur = ahrefsMap[c.url]?.url_rating ?? 0;
  if (kwClientUR >= cur) { pos = c.rank_absolute; break; }
}
```

- **Only signal used in the decision:** `url_rating`.
- **Signals fetched + stored but ignored in the loop:** `domain_rating`, `ahrefs_rank`, `referring_domains`, `backlinks`.
- **Manual override:** `keyword_forecasts.har_is_manual` (boolean) — respected inside `compute-forecasts`.
- **No confidence output.** Missing Ahrefs data collapses to `url_rating = 0`, which will *usually* let the client "win" position 1 spuriously. **The proposal's §5.8 concern is real.**

### 2.2 Revenue (from `supabase/functions/compute-forecasts/index.ts`, lines ~197–240)

```ts
const currentCtr = getCtr(device, intent, position);
const estCurrentClicksAnnual  = volume * currentCtr * 12;
const estCurrentRevenueAnnual = estCurrentClicksAnnual * cvr * aov;

// TP revenue = ABSOLUTE annual revenue at HAR position (column name misleading)
const ctrAtHar          = getCtr(device, intent, har);
const harTrafficAnnual  = volume * ctrAtHar * 12;
harRevenueGainAnnual    = harTrafficAnnual * cvr * aov;   // NOT a delta
harTrafficGainAnnual    = Math.max(harTrafficAnnual - estCurrentClicksAnnual, 0);
```

- Flat `× 12` annualisation — no monthly seasonality applied to revenue itself.
- `cvr` and `aov` are project-wide scalars from `navigator_projects`.
- `har_revenue_gain_annual` is **absolute TP revenue**, not the gain — the column name is preserved for compatibility. UI labels already read "TP Revenue". This mismatch matters for the proposal's incremental-revenue rework (§6.2).

### 2.3 CTR (from `compute-forecasts` `getCtr` resolver)

Fallback order: `device|intent|pos` → `device|generic|pos` → `device|<intent-priority>|pos` (transactional → commercial → informational → navigational) → `0`.

`ctr_curves` **actual columns**:

```
project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback
```

No `source`, no `sample_size`, no `confidence`, no `date_range`. The proposal's `ctr_curve_metadata` companion table (§12.5) is therefore mandatory, not optional.

### 2.4 Seasonality

- Producer: `keyword_monthly_volumes {keyword_id, month, volume}` — **no year metadata beyond `month` (a DATE)**, no `source`, no `confidence`.
- Peak detection: single peak month where `peak ≥ 1.4 × mean` with `≥ 6 months` and `mean ≥ 50`.
- Consumer fields already on `keyword_forecasts`: `months_to_peak`, `seasonal_urgency`, `is_in_capture_window`, `peak_source`.
- **No trend / slope / volatility field exists today.**

### 2.5 SERP features

- `serp_features` — one row per **keyword** (aggregate: `top_serp_feature`, `serp_feature_count`, `serp_feature_owned`, `snippet_opportunity`).
- `serp_landscape` — one row per **result** in a SERP (`ranking_url`, `result_type`, `serp_feature_raw`, `owned`, `device`).
- `serp_feature_index` — a reference dictionary mapping raw feature names → normalised `result_type` / `serp_intent`.

The proposal's SERP-deflator model must specify which of `serp_features` (fast, per-keyword) vs. `serp_landscape` (accurate, position-aware) drives the multiplier. My recommendation: **`serp_features` for CTR deflation** (matches the aggregate CTR curve) and **`serp_landscape` for HAR difficulty** (where above-organic position matters).

### 2.6 `keyword_forecasts` schema (confirmed columns)

```
current_ctr_pct, est_current_clicks_annual, est_current_revenue_annual,
expected_traffic_rank1_annual, har, har_is_manual, har_revenue_gain_annual,
har_traffic_gain_annual, is_in_capture_window, months_to_peak, opportunity,
peak_source, seasonal_urgency, weighted_sum, yearly_revenue_gain_rank1,
yearly_traffic_gain_rank1
```

No scenario columns, no confidence columns, no explanation JSON.

---

## 3. Fact-check table (proposal claim → reality)

| Proposal claim | Reality | Correction needed |
| --- | --- | --- |
| "HAR uses URL Rating as the only decision signal" (§5.1) | ✅ Correct. Confirmed in `har-calculation/index.ts` line ~1031. | None. |
| "Domain Rating, Ahrefs Rank, referring domains, backlinks … are collected but not used" (§5.1) | ✅ Correct. Stored on `serp_results` via `ahrefsMap` + `blMap`. | None. |
| "Missing Ahrefs data can fall to zero and produce null HAR" (§5.8) | ⚠️ Partially — it usually produces a **spuriously high HAR** (client "wins" against a zero-UR competitor), not a null. | Reword to "missing competitor authority collapses to zero and lets the client score win incorrectly". |
| "`ctr_curves` already supports source/is_fallback/sample_size/confidence" (§7.5, implied) | ❌ Only `is_fallback` exists. | Companion `ctr_curve_metadata` table (§12.5) is **required**, not optional. |
| "Existing `gsc_upload_keywords` can be tied to project_id and device" (§7.5) | ⚠️ `project_id` yes (via `gsc_uploads.project_id`). `device` yes but **only via the parent upload row**, not on the keyword row directly. No brand tag. | Curve generator must JOIN through `gsc_uploads` for device; brand tagging is a separate task. |
| "`keyword_monthly_volumes` may be enough for basic momentum" (§10.7) | ⚠️ Unknown — schema stores `{month, volume}` per keyword with no cap on rows, but the DFS ingest today writes ~12 months typically. **Needs runtime confirmation per project.** | Add to open questions. |
| "Manual HAR overrides must remain intact via `keyword_forecasts.har_is_manual`" (§5.9) | ✅ Correct. Verified in `compute-forecasts` line ~230: `existing?.har_is_manual ? existing.har : automatedHar`. | None. |
| "`site_architecture.relevancy_score` already exists as an AI-generated relevancy signal" (§5.4) | ✅ Correct. Produced by `supabase/functions/site-architecture/index.ts` via Gemini 3 Flash. | None. |
| "Seer already collects SERP features and currently does not use them in CTR or HAR confidence" (§9.1) | ✅ Correct. `serp_features` + `serp_landscape` + `serp_feature_index` populated; not consumed by CTR/HAR. | None. |
| "Revenue uses flat annualisation and generic CTR curves" (§1) | ✅ Correct. `× 12` flat, no monthly re-weighting. | None. |
| "`har_revenue_gain_annual` is the revenue *gain*" (implied throughout §6) | ❌ **It is the ABSOLUTE TP revenue**, not the gain. See §2.2. | Proposal's `tp_incremental_revenue = tp_revenue - current_revenue` math is right — but Seer's existing column is *already* absolute TP revenue, so the v2 model must add a **new** column (`tp_incremental_revenue_annual`) rather than reuse the misleading one. |
| "Add per-keyword `seasonal_urgency` / `is_in_capture_window`" (§10 implied via new schema) | ⚠️ These **already exist** on `keyword_forecasts`. | Extend, don't re-add. |
| "Add `keyword_source`, `source_confidence`, etc." (§7.6) | ✅ Missing — correctly identified as a separate future workstream. | None. |
| "GA4 API integration should not happen in this phase" (§8.2) | ✅ Agreed. No OAuth or GA4 client anywhere. | None. |

---

## 4. Section-by-section review

### §4 — Scenario model + primary UX

- **Viability:** 🟢 Green.
- **Backend:** needs `keyword_forecast_scenarios` (as proposed) + a project-level "primary scenario" preference (default `realistic`). A projection view (`keyword_forecasts_v2_realistic`) is the safest way to feed existing UI without ripping out queries.
- **Frontend:** the Briefing OS already has the right primitives — `BriefingCard`, `DeltaChip`, `EditorialSection`. Range display can reuse `Sparkline` for the band. Scenario toggle is new (a `SegmentedControl` component would fit; not present today — check `src/components/ui/`).
- **Risk:** the largest risk is that ~10 hooks/queries already assume `keyword_forecasts.har_revenue_gain_annual` = TP revenue. The v2 layer must resolve to the *same shape* or introduce a scenario-aware hook (`useProjectForecasts(scenario)`) that every existing consumer migrates through. See §5 of this review.

### §5 — HAR v2

- **Viability:** 🟢 Green for first cut using only stored data.
- **Backend to add:**
  - `authority_score_components` computation inside a new `har-calculation-v2` edge function (do NOT modify the v1 function).
  - Persist `authority_score`, `content_fit_score`, `serp_visibility_penalty`, `rank_attainment_probability`, `har_confidence`, `explanation_json` onto `keyword_forecast_scenarios`.
  - Config table `har_scoring_config {version, weights_json, thresholds_json, active}`.
- **Log-normalisation:** correct approach. Use `LOG(1 + n) / LOG(1 + MAX_IN_SERP)` per keyword's SERP, not globally, otherwise huge-domain SERPs squash smaller ones.
- **Observed-rank protection (§5.7):** trivial — clamp using `keywords.base_rank`. Already in `keyword_forecasts.opportunity` classification.
- **Frontend:** `HarAnalysisSection.tsx` needs a v2 mode toggle and a "why this HAR" drawer. `RankingUrlSection.tsx` is the natural home for the per-keyword explainer.

### §6 — Revenue v2

- **Viability:** 🟡 Amber (safe, but touches many surfaces).
- **Critical correction:** `keyword_forecasts.har_revenue_gain_annual` is already absolute TP revenue. Introducing a new "incremental" concept requires **new** columns, and the existing column name should be marked deprecated in docs (do NOT rename — too many downstream consumers).
- **Monthly modelling (§6.4):** feasible. Read `keyword_monthly_volumes` per keyword; if `< 6` rows, fall back to `avg_monthly_volume / 12`. Store `monthly_revenue_json` on the scenario row.
- **Expected × probability × confidence:** the multiplication of three < 1 values will **systematically reduce** the headline number vs. today's TP figure. Users will notice. Recommend framing v2 output as "**Expected uplift**" alongside legacy "TP Revenue" during shadow-mode co-existence, not as a replacement.
- **Frontend impact:** `ForecastTabHeader`, `PerformanceDashboardSection`, `useDashboardData`, `ProjectOverviewPage`, `useProjectNextAction`, exports in `exportSlides.ts`, `export-performance-slides` edge function. Each must be scenario-aware.

### §7 — CTR / GSC

- **Viability:** 🟡 Amber for CTR-from-uploads; 🔴 Red for GSC API this phase.
- **Immediate work:**
  - Add `ctr_curve_metadata` (source, sample_impressions, sample_clicks, confidence, date_range).
  - New edge function `ctr-curves-from-gsc` that JOINs `gsc_upload_keywords` → `gsc_uploads` (for `device`), buckets by `search_intent + rank_position`, applies smoothing, upserts `ctr_curves` rows with `is_fallback=false`.
  - Blend formula in §7.4 is sound; keep `prior_impressions` as a per-project config (start ~50).
- **Brand tagging:** proposal casually assumes brand/non-brand curves. Seer has no brand token stored on keywords today (only on `clients.own_brand_tokens`). Brand split for CTR needs a preprocessor. Recommend deferring brand split until v2.1.
- **Frontend:** `CtrCurveSection.tsx` needs a provenance chip (Fallback / GSC upload / GSC API future) and a sample-size tooltip. `useDashboardData` and forecast hooks don't need to change — they read curves through the resolver.

### §8 — GA4 / CVR / AOV

- **Viability:** 🟢 Green for `project_conversion_overrides`; 🔴 Red for GA4 API integration this workstream.
- **Backend:** table shape in §12.4 is correct. Add resolver order in `compute-forecasts` (or v2): url > category(tag_1[+tag_2]) > intent > project. Cache the resolver map per project run to avoid N queries.
- **Frontend:** new admin surface (probably under `/clients/:id/projects/:id/settings` or a new "Conversion" tab) — none exists today. Reuse `DataTable` for CRUD.
- **Risk:** URL-level overrides open a moderation surface (analysts can silently inflate revenue). Add an audit column (`created_by`, `updated_by`) and expose overrides in the forecast explainer.

### §9 — SERP feature deflators

- **Viability:** 🟢 Green. Cheapest wins on the whole roadmap.
- **Backend:**
  - `serp_feature_ctr_adjustments {feature_type, device, intent, multiplier, confidence, notes}` — seed from proposal's starting values.
  - CTR resolver becomes `adjustedCtr = baseCtr * deflatorForKeyword(keyword_id, device)`.
  - Decision: read from `serp_features` (per-keyword aggregate) not `serp_landscape`. Faster and matches the resolution of CTR curves.
- **Frontend:** in the HAR explainer + keyword table, show "SERP visibility: Reduced — Shopping pack + PAA — CTR 18.2% → 11.4%". No raw multiplier in UI (correct guidance §9.3).

### §10 — Demand Intelligence

- **Viability:** 🟡 Amber, gated on data availability.
- **Backend:**
  - `keyword_demand_signals` + `category_demand_signals` tables as proposed.
  - New edge function `demand-signals-compute` (nightly cron via `pg_cron`, cheap — pure SQL/JS, no external API).
  - Multi-year detection requires `keyword_monthly_volumes` to hold ≥ 24 months per keyword — Seer's current DFS ingest normally writes ~12. **This is the blocker.** Confirm with a quick production query before starting Phase 6.
- **Frontend:** dashboard "Demand Signals" section is new — reuse `EditorialSection` + `StatusMixBar`. Capture Window page (`CaptureWindowPage.tsx`) gets a trend-direction filter chip. Roadmap prompt (`roadmap-to-success`) should ingest `category_demand_signals` as evidence — a small addition to the payload, no prompt overhaul.
- **Caps (§10.8):** the ±25% / ±35% caps are sensible defaults; store in `har_scoring_config` alongside other tunables.

### §11 — Link Power Score

- **Viability:** 🟢 Green. All inputs already stored on `serp_results` + `client_domain_metrics`.
- **Backend:** pure derived score — can live as a Postgres generated column on a new `link_power_scores` table, or computed on-demand inside the v2 HAR function.
- **Weighting risk:** the proposed 0.35/0.15/0.20/0.10/0.05/0.10 sums to 0.95; add explicit "spam/low-quality penalty" definition (proposal leaves this as "0" for v1 — fine, but note it in code).
- **Frontend:** exposes as a badge on `HarAnalysisSection` + explainer drawer. `CompetitorBacklinkLandscape.tsx` becomes the natural comparison view.

### §12 — Schema additions

Broadly good. Corrections:

- `calculation_model_runs` — 🟢 as-is, but add `parent_run_id` for retries and a `git_sha` / `code_version` column for provenance.
- `keyword_forecast_scenarios` — 🟢 as-is. Note: some fields duplicate `keyword_forecasts` (e.g. `current_revenue_annual`) — that's fine for a shadow model; do not dedupe until v2 replaces v1.
- `keyword_demand_signals` / `category_demand_signals` — 🟢 as-is. Add `model_run_id` FK to `calculation_model_runs`.
- `project_conversion_overrides` — 🟢 as-is. Add UNIQUE on `(project_id, scope_type, scope_value)`.
- `ctr_curve_metadata` — 🟢 required (not optional). Add UNIQUE on `(project_id, device, intent_segment, rank_position)` mirroring the curve grain.

**RLS:** every new table must include the standard `is_visible_project(project_id)` predicate + explicit `GRANT SELECT/INSERT/UPDATE/DELETE ON <table> TO authenticated;` + `GRANT ALL ... TO service_role;` per project conventions (see core memory + `docs/data-and-calculations-audit.md`).

### §13 — Phasing

See §6 of this review for adjusted ordering.

### §14 — Guardrails

Adopt verbatim. Two additions I'd recommend:

- **G15:** Every v2 write must carry `model_run_id`; no orphan rows.
- **G16:** A single feature flag (`calculations_v2_enabled`) per project gates whether v2 outputs are *visible*, independent of whether they are *computed*.

---

## 5. UX overlay — where each change lands

Journey walkthrough. Files named are existing surfaces; anything else is new.

### 5.1 Project Overview (`src/pages/project/ProjectOverviewPage.tsx`)

- **Today:** headline TP revenue card, next-action CTA, capture-window strip.
- **After v2:** "Expected SEO Uplift" `BriefingCard` (realistic incremental), with a `DeltaChip` showing "range £74k → £231k · confidence Medium-High". Supporting cards remain, plus a new "Demand trend" chip (growing/stable/declining/volatile).
- **Refactor scope:** `useProjectNextAction` needs a new state for "v1/v2 divergence review" (only when shadow-mode diffs exceed a threshold). New hook `useProjectForecasts(scenario)` replaces direct `keyword_forecasts` reads in this file only initially.

### 5.2 Forecast tab (`src/components/forecast/ForecastTabHeader.tsx` + related)

- **Today:** single TP revenue figure, recompute CTA, HAR section.
- **After v2:** scenario selector `[Conservative | Realistic | Stretch]` (new primitive — no existing SegmentedControl), range-band chart (Recharts `Area` overlaid on `Line` — trivial), keyword table gets `Realistic HAR/TP`, `Expected incremental`, `Confidence`, `Demand trend` columns. Advanced toggle reveals the other scenarios + link gap + SERP deflator + trend adjustment.
- **Refactor scope:** `useRecomputeForecasts` invokes new function `compute-forecasts-v2` in shadow mode. `PerformanceDashboardSection` reads through the scenario-aware hook.

### 5.3 Ranking URLs & TP (`src/components/RankingUrlSection.tsx` + `HarAnalysisSection.tsx`)

- **New:** an expandable "Why this HAR" drawer per keyword showing Link Power Score, competitor score at TP, content fit %, SERP difficulty label, brand/SERP constraint, confidence %. `SiteArchitectureActionCard` already renders content-fit — reuse.
- **Refactor scope:** drawer is a new `HarExplainer` component; consumes `keyword_forecast_scenarios.explanation_json`.

### 5.4 Capture Window (`src/pages/CaptureWindowPage.tsx`)

- Adds filter chips: "Growing demand", "Declining demand", "High seasonal urgency", "High revenue impact". `SeasonalityBadge` already exists — extend with trend variant.

### 5.5 Roadmap & Content Plans

- **`roadmap-to-success/index.ts`:** payload gets `expected_incremental_revenue`, `demand_trend`, `link_gap_points_v2`, `authority_score`. Prompt already tolerant of new fields (no schema tool — just JSON). No prompt overhaul needed; add fields to payload only.
- **`content-plan-generate/index.ts`:** cluster ranking should use `expected_incremental_revenue` when available. Prompt unchanged.
- **UI:** roadmap markdown viewer needs no changes.

### 5.6 Exports (`src/lib/exportSlides.ts` + `export-performance-slides` edge function)

- Slide export must decide **before rollout** whether to export v1 or v2 numbers. Recommend an "export version" pin on the slide title so external audiences aren't confused when the model changes.

### 5.7 New surfaces required

- **Conversion overrides admin panel** — new sub-route under project settings.
- **Calculation Runs Inspector** — admin-only comparison table for v1 vs v2 per project. Not exposed to end users.
- **CTR Curve provenance chip** — small addition to `CtrCurveSection.tsx`.

---

## 6. Cross-cutting concerns

### 6.1 RBAC / RLS

- All new tables inherit the project-scoped RLS pattern (`is_visible_project(project_id)`). Follow the mandatory GRANT block for every new `public` table (core memory rule).
- `project_conversion_overrides` writes should be restricted to `admin`/`super_admin` at RLS level — mirrors `keyword_rules` policy shape.
- `calculation_model_runs` visible to `view_only` (read) but writable only by `authenticated` service-role invocations.

### 6.2 Shadow-mode plumbing

- One new edge function per family, versioned by suffix: `compute-forecasts-v2`, `har-calculation-v2`, `demand-signals-compute`, `ctr-curves-from-gsc`, `link-power-score-compute`.
- Each records a row in `calculation_model_runs` on start + completion. Add a `pg_cron` nightly job that runs v2 for every synced project (cheap; no external APIs beyond what already happens).
- **Do not modify v1 edge functions** during Phases 1-6. Modification comes only in Phase 7 UI-cutover.

### 6.3 Migration order (safe path)

1. Additive tables + GRANTs + RLS (`calculation_model_runs`, `keyword_forecast_scenarios`, `keyword_demand_signals`, `category_demand_signals`, `project_conversion_overrides`, `ctr_curve_metadata`, `serp_feature_ctr_adjustments`, `har_scoring_config`, `link_power_scores`).
2. Seed reference tables (`serp_feature_ctr_adjustments` starting values, `har_scoring_config` weights).
3. Deploy v2 edge functions (idle — no cron).
4. Add feature flag column on `navigator_projects.calculations_v2_enabled` (default `false`).
5. Enable cron per project via flag.
6. Ship inspector UI.
7. Ship user-facing scenario UI behind flag.

### 6.4 Backfill

- One-shot `pg_cron` on Phase 3 to populate `keyword_forecast_scenarios` for the last N days of synced projects.
- No historical CTR backfill — curves live forward.

### 6.5 Cost & rate-limit

- **No new AI calls.** All v2 work is deterministic arithmetic over already-collected data.
- **No new DFS calls** in Phases 1-6. Ahrefs / DFS already ingest the needed signals.
- **No new Anthropic tokens.** The roadmap + content-plan prompts get slightly larger payloads (~10-15 more numeric fields per keyword) — negligible cost.
- **GSC API (Phase 8):** distinct workstream, distinct budget conversation. Correctly deferred by the proposal.

### 6.6 Telemetry for v1 ↔ v2 comparison

- Add a `calculation_deltas` view: `keyword_id, v1_har, v2_har_realistic, delta_pct, v1_tp_revenue, v2_realistic_expected_incremental, delta_pct`.
- Alert (email or in-app banner) when project-level v1↔v2 divergence exceeds ±35%, so analysts investigate before end-users see the change.

---

## 7. Recommended sequencing adjustments to the proposal's 10-phase plan

| Proposal phase | Adjustment | Reason |
| --- | --- | --- |
| Phase 0 (viability audit) | ✅ Keep as-is. Use the open questions in §8 of this review as the audit checklist. | — |
| Phase 1 (scaffolding) | **Add `serp_feature_ctr_adjustments` + `har_scoring_config`** to the scaffolding migration. | They're config tables — cheaper to land together with the rest of the additive schema. |
| Phase 2 (CTR from uploads) | ✅ Keep first. | Everything downstream (revenue v2, expected uplift) needs believable CTRs. |
| Phase 3 (HAR v2 shadow) | **Split into 3a Link Power Score + 3b HAR v2 composite.** | LPS is independently useful in dashboards; decoupling reduces risk. |
| Phase 4 (Revenue v2 shadow) | ✅ Keep. | Depends on 2 + 3. |
| Phase 5 (SERP deflators) | **Pull earlier — run in parallel with Phase 2.** | Uses different data, no dependency, and improves Phase 2's CTR realism. |
| Phase 6 (Demand Intelligence) | ✅ Keep, but gate on data-availability audit answer. | If `keyword_monthly_volumes` doesn't hold enough history, Phase 6 becomes a DFS-historical-volume mini-project first. |
| Phase 7 (UI surfacing) | ✅ Keep, but insert a **7a Calculation Runs Inspector (admin only)** before 7b user-facing UI. | Lets the team validate divergence privately before analysts see scenario numbers. |
| Phase 8 (GSC API) | ✅ Keep as separate workstream. | — |
| Phase 9 (GA4 API) | ✅ Keep as separate workstream. | — |

---

## 8. Open questions to take back to the next brainstorm

These are the things the proposal assumes, that I cannot confirm without either a live-data query or a product-strategy decision:

1. **How many months of `keyword_monthly_volumes` does Seer actually store per keyword on live projects?** Blocks Demand Intelligence Phase 6 sequencing. (Answer with a quick `SELECT keyword_id, COUNT(*) FROM keyword_monthly_volumes GROUP BY 1` percentile check.)
2. **Is `serp_landscape` populated per-project reliably, or only for HAR-analysed keywords?** Determines whether the SERP deflator can be per-position (§9 accurate) or is stuck at per-keyword aggregate.
3. **Brand vs non-brand CTR curves — is this needed in v1, or acceptable to defer to v2.1?** Seer has no per-keyword brand flag today. Adding one is small but touches detox + categorisation.
4. **When `har_revenue_gain_annual` becomes semantically wrong (v2 introduces true "incremental"), do we rename the UI labels immediately, or maintain "TP Revenue" wording throughout the shadow period?** UX consistency call.
5. **Confidence-multiplied "Expected incremental" will produce visibly smaller headline numbers than today's TP Revenue.** How is this communicated to existing clients whose forecasts will "drop" overnight when v2 flips on? Change-management question, not a technical one.
6. **Should scenario selection be per-user (personal preference) or per-project (org-wide default with per-user override)?** Affects the scope resolver and the persistence layer.
7. **URL-level conversion overrides carry moderation risk — who is allowed to write them?** Suggest `admin` + `super_admin` only. Confirm with product.
8. **DFS historical search volume — what's currently subscribed?** Determines whether Demand Intelligence needs a new API line item.
9. **Where does the SERP deflator config live editorially — is it "science" (locked, code) or "content" (editable in admin UI)?** Table shape same either way, but affects whether we ship a CRUD screen.
10. **Slide exports (`export-performance-slides`) — do we version-stamp exports, or hard-cut to v2 at flag-flip?** Client-communication question.

---

## 9. Bottom line

The proposal is **directionally correct and technically viable**. Almost everything in it can be built additively on top of Seer's current schema — the only place where reality diverges from the proposal is (a) `ctr_curves` and `gsc_upload_keywords` are thinner than assumed, and (b) `har_revenue_gain_annual` is already absolute TP revenue rather than a delta. Neither is a blocker; both are documented above with the right correction.

Recommended sequence when the roll-out prompt series begins:

1. Scaffolding migration (Phase 1 + parts of Phase 5 config).
2. CTR-from-uploads + SERP deflators in parallel (Phases 2 + 5).
3. Link Power Score standalone (Phase 3a).
4. HAR v2 composite (Phase 3b).
5. Revenue v2 (Phase 4).
6. Demand Intelligence (Phase 6) — gated on data-availability answer.
7. Admin inspector, then user-facing scenario UI (Phase 7a + 7b).
8. GSC API (Phase 8), GA4 API (Phase 9) — separate workstreams.

All 14 proposal guardrails carry over unchanged. Add G15 (model_run_id required) and G16 (per-project feature flag) as noted in §4.
