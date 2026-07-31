# Seer® Calculation Improvements — Lovable Response to Follow-Up Clarifications

**Prepared by:** Lovable (Seer engineering assistant)
**Responding to:** `seer_calculation_improvements_followup_for_lovable.md` (Jake McCreith / No Brainer + ChatGPT, 1,153 lines)
**Status:** Read-only alignment document. No code, schema, RLS, secrets or UI changes made. Ready for the next brainstorming round; prompt-sequence generation still deferred.

---

## 1. Executive alignment

We are aligned on every principle in §1 of the follow-up: additive, shadow-mode, versioned, manual-first, feature-flagged, deterministic, inspectable. Nothing in the current Seer codebase blocks that programme.

Three material updates since the previous alignment response:

1. **Demand Intelligence scope should widen to 24 months now.** Feasible via DataForSEO. Cost is modest at current keyword count. The blocker is not the endpoint — it's the fact that today's `keyword_monthly_volumes` writer *overwrites* (delete-then-insert) on every enrichment run, so we must fix the writer semantics before or during the backfill. Details in §3.1 and §4.1.
2. **GSC standard 16-month workbook import is viable, but device becomes the friction point.** The `Queries` sheet is genuinely mixed/all-device — there is no query × device breakdown in that export. Supporting `device = 'all'` in `ctr_curves` + a resolver fallback is materially lower-risk than forcing users to upload three device-filtered files. Details in §3.3 and §4.3.
3. **Feature-flag storage — direct columns on `navigator_projects` is the lower-risk choice** for this codebase, and later migration to a flags table is straightforward. Recommendation in §3.5 and §4.5.

Two framing corrections vs. the follow-up doc:

- The follow-up's line "Missing competitor UR collapses to zero" is broadly correct in symptom, but the specific mechanism is that HAR v1 walks positions and picks the first competitor whose `url_rating <= client_url_rating`; if the competitor row's `url_rating` is `null`, the comparison in JS coerces to `0` and the client "wins" trivially. Fix design in §3.4.
- The follow-up implies the migration `gsc_uploads.date_range_start / _end` is optional. We recommend it be **mandatory** and back-filled to `NULL` for legacy uploads — otherwise Demand Intelligence and CTR provenance can't safely time-window GSC-derived curves.

---

## 2. Confirmations table — re-verified against ground truth

| # | Follow-up baseline claim | Verdict | Ground truth |
|---|---|---|---|
| 2.1 | HAR v1 = `client UR ≥ competitor UR` | **Confirmed** | `supabase/functions/har-calculation/index.ts` — HAR loop iterates SERP rows in ascending position and picks first row where `client_url_rating >= competitor.url_rating`. |
| 2.1 (nuance) | Missing competitor UR causes spurious optimism | **Confirmed with correction** | Missing UR becomes `null → 0` at compare time in the current implementation; not `null` propagation. See §3.4 for mitigation. |
| 2.2 | `har_revenue_gain_annual` = absolute TP revenue, not incremental | **Confirmed** | `supabase/functions/compute-forecasts/index.ts` — comment block explicitly says `har_revenue_gain_annual = ABSOLUTE annual revenue at TP position (renamed semantic — column name kept to avoid migration)`. Consumers: `HarAnalysisSection`, `PerformanceDashboardSection`, `ForecastTabHeader`, `exportSlides.ts`, `export-performance-slides` edge function, `content-plan-generate`, `roadmap-to-success`. Do not rename. |
| 2.3 | `ctr_curves` columns = `project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback, id` — no `source / sample_size / confidence / date_range_*` | **Confirmed** | `src/integrations/supabase/types.ts` — `ctr_curves` Row matches exactly. `ctr_curve_metadata` is therefore **required**, not optional. |
| 2.4 | `gsc_upload_keywords.upload_id → gsc_uploads.id`; `gsc_uploads.project_id` and `gsc_uploads.device` are `NOT NULL`; no date-range columns | **Confirmed** | `types.ts` — `gsc_uploads` Row: `device: string, id: string, project_id: string, row_count: number, uploaded_at: string`. No `date_range_start / _end`. |
| 2.5 | Live `keyword_monthly_volumes` coverage is exactly 12 months per keyword; multi-year not possible from stored data alone | **Confirmed structurally** | `supabase/functions/keyword-enrichment/index.ts` at lines 408–409: `await supabase.from("keyword_monthly_volumes").delete().eq("keyword_id", id); if (monthRows.length) await supabase.from("keyword_monthly_volumes").insert(monthRows);` — every enrichment run wipes and re-writes the trailing 12 months returned by DataForSEO. We cannot confirm the exact per-keyword counts (2,528 keywords, min/median/p75/max = 12) without a live query, but the writer semantics make the follow-up's numbers plausible. |
| 2.6 | `serp_features` = per-keyword aggregate (CTR deflation); `serp_landscape` = per-position (HAR difficulty) | **Confirmed** | `types.ts` + `serp-feature-upsert/index.ts` — split matches. Continue using them for their respective v2 roles. |
| 2.7 | LPS inputs live on `serp_results (url_rating, domain_rating, ahrefs_rank, referring_domains, backlinks)` and `client_domain_metrics`, not `har_results` or `keyword_forecasts` | **Confirmed** | `types.ts` — `serp_results` carries those authority columns; `har_results` intentionally stores only the *outcome* (`har_position` + audit fields). LPS v1 must join `serp_results` (per-URL competitors) + `client_domain_metrics` (project-scope client authority). |

---

## 3. Feedback on Jake's suggested changes

### 3.1 DataForSEO 24-month historical volume backfill — **Feasible, with a writer-semantics fix first**

DataForSEO's `keywords_data/google_ads/search_volume/live` endpoint (already used by `keyword-enrichment`) returns exactly the trailing 12 months. For 24+ months we would need one of:

- **`keywords_data/google_ads/keywords_for_keywords`** (returns up to ~4 years of `monthly_searches` when available), or
- **`dataforseo_labs/google/historical_search_volume/live`** (Labs API; returns multi-year monthly volume when the account has Labs access).

We use DataForSEO Basic auth via `DATAFORSEO_API_KEY` today; whether the account has Labs access is a **product/account question we cannot confirm from code**. The cost per keyword for either endpoint is very small (~$0.00075–$0.002 per call, batched 700/keyword request). For Seer's current keyword volume (~2.5k) a one-off backfill is a few dollars.

**Critical blocker — must be fixed before or as part of the backfill:** `keyword-enrichment/index.ts` performs `DELETE ... WHERE keyword_id = X` then `INSERT`. Any historical months we store today are erased on the next enrichment run. Recommended fix:

1. Add `source text NOT NULL DEFAULT 'dataforseo_search_volume'` and `fetched_at timestamptz NOT NULL DEFAULT now()` to `keyword_monthly_volumes`.
2. Add composite unique `(keyword_id, month, source)` so upserts merge cleanly.
3. Replace the `DELETE + INSERT` pattern with `UPSERT ON CONFLICT (keyword_id, month, source) DO UPDATE`. Preserve rows whose `month` was not in the current DFS response.
4. Backfill runs write with `source = 'dataforseo_historical_backfill'` so the two ingest paths never collide.
5. Leave the existing `peak_month` derivation untouched — the query it runs (`MAX(volume) over trailing months`) continues to work identically because the new rows only widen the window.

**Do not** create a parallel `keyword_monthly_volume_history` table + compat view — it doubles the surface area for a marginal win and complicates every downstream query.

### 3.2 Preserve/append monthly volume rather than overwrite — **Confirmed, ships as part of 3.1**

Same migration covers this. Guardrails:

- Keep the existing `keyword_monthly_volumes` API surface unchanged for consumers (`compute-forecasts`, `SeasonalityBadge`, `useDashboardData`, `content-plan-generate` seasonality reads). They all query by `(keyword_id, month)` and take `volume`; adding `source / fetched_at` is additive.
- Do not deduplicate across sources at query time in v1 — expose a lightweight view `keyword_monthly_volumes_preferred` if a consumer needs a single canonical row per month (pick most-recent `fetched_at`).

### 3.3 GSC standard 16-month workbook importer — **Feasible; needs SheetJS + new upload path**

Current `gsc-intent-enrichment` is an intent-enrichment worker only — it does not parse Excel today. The upload path assumes device-filtered CSV. To support the standard workbook:

- Add a new edge function `gsc-workbook-import` that accepts the `.xlsx` file (via base64 or storage bucket URL), parses with a Deno-compatible XLSX library (SheetJS `xlsx@0.18.5` works in Deno via `esm.sh`), and produces:
  - `gsc_uploads` row with `device = 'all'` (see 3.4), `date_range_start`, `date_range_end` (both derived from `Chart` sheet min/max Date column), plus new `source = 'gsc_workbook_v1'`.
  - `gsc_upload_keywords` rows from the `Queries` sheet (`query, clicks, impressions, ctr, position`).
  - Optionally, `gsc_upload_pages` (new table) from the `Pages` sheet if URL-level context is wanted in Phase 2+.
- Add `date_range_start date` and `date_range_end date` to `gsc_uploads` in the scaffolding migration (Phase 1). Legacy rows get `NULL`; CTR v2 refuses to use a curve derived from a NULL-range upload.
- The `Filters` and `Devices` sheets are diagnostic-only for v1 — surface them in the admin inspector, don't act on them.

Two nuances the follow-up under-specifies:

- The `Chart` sheet's `Date` column is per-day; take `MIN`/`MAX` and validate the span is 90–500 days before accepting. Anything outside that band → require the user to input dates manually.
- `Position` on the `Queries` sheet is a *weighted average* — bucketing by `round(position)` is correct but the resulting CTR curve should be marked `source = 'gsc_workbook_average_position'` and confidence downgraded vs. a true GSC-API pull.

### 3.4 Missing competitor UR mitigation — **Should ship as part of HAR v2, and a small v1 hotfix is worth doing early**

The v2 composite score already replaces raw UR-vs-UR with LPS, so the "collapse to zero" bug disappears there. But it also affects HAR v1 today. Minimal v1 hotfix (small, low-risk, no schema change):

- In `har-calculation`, treat `competitor.url_rating IS NULL` as **skip the row** (do not consider it a "beaten" competitor). Rank attainment then only considers rows with observed authority. This is a two-line change and does not alter the algorithm's shape.

For v2 (composite HAR):

- Impute missing competitor authority with the **project-level p50** of competitor authority observed across the top-20 for that keyword, not zero. Store the imputation flag on the v2 result row so the inspector can show "N competitors had imputed authority — HAR confidence downgraded".

### 3.5 Semantic clean-up of `har_revenue_gain_annual` — **Do not rename. Add new columns.**

Confirmed. Introduce new v2 fields on a **new** table (`keyword_forecast_scenarios`, keyed `(keyword_id, model_run_id, scenario)`):

- `current_revenue_annual`
- `tp_absolute_revenue_annual` (mirrors v1's `har_revenue_gain_annual` semantic — for continuity)
- `tp_incremental_revenue_annual` (new — the true gain the follow-up wants)
- `expected_incremental_revenue_annual` (probability-weighted)
- `scenario_revenue` (per conservative/realistic/stretch)
- `monthly_revenue_json` (for the demand-adjusted view)

v1 columns on `keyword_forecasts` are untouched. Visibility flag governs which set the UI reads.

### 3.6 Admin calculation inspector early — **Agreed, and it should ship in Phase 1**

The inspector is the safety mechanism for the entire programme. Minimum viable inspector for Phase 1 (before any v2 compute runs):

- Route: `/admin/calculations` (super_admin + admin only).
- Tables: `calc_run_registry` (run header) + `calc_run_diff` (per-metric v1↔v2 diff summary per project).
- UI: run list, "trigger v2 run" button per project, run detail page showing per-family deltas, warnings, errors.
- Grows over Phases 3–9 as each family lands. No user-facing v2 surface can ship until this exists.

### 3.7 Model / run identifier scheme — **Confirmed, spec below**

Every v2-writing edge function receives / creates a `calc_run_id uuid` and writes it to every row it produces. Registry table:

```
calc_run_registry (
  id uuid pk,
  project_id uuid not null,
  triggered_by uuid,                -- auth.uid()
  trigger_source text,              -- 'manual_admin' | 'pg_cron' | 'test'
  model_version text not null,      -- e.g. 'har_v2.0.0', 'revenue_v2.0.0'
  scope jsonb,                      -- which families ran
  status text,                      -- 'queued'|'running'|'succeeded'|'failed'|'partial'
  started_at, finished_at, warnings jsonb, errors jsonb
);
```

All v2 tables (`keyword_forecast_scenarios`, `link_power_scores`, `keyword_demand_signals`, etc.) get `calc_run_id uuid references calc_run_registry(id) on delete cascade`. This gives clean rollback: delete the run, all its rows go with it. RLS: read via `is_visible_project`, write via `_require_admin()`.

---

## 4. Answers to the questions in §8 of the follow-up

### 8.1 DataForSEO 24-month historical volume

- **Q: Can we add a backfill preserving existing consumers and v1 peak_month?**
  Yes, provided we replace the `delete-then-insert` writer in `keyword-enrichment` with an upsert on `(keyword_id, month, source)` in the same migration. Without that fix, any historical rows will be wiped on the next standard enrichment run.
- **Q: Which endpoint, what cost, is the shape compatible?**
  Two candidates: `dataforseo_labs/google/historical_search_volume/live` (best fit — up to 4 years of monthly volume; requires Labs subscription — **we need Jake to confirm Labs access on the current DFS account**) or `keywords_data/google_ads/keywords_for_keywords` (fallback — often returns extended history but less predictable). Cost for ~2.5k keywords batched at 700/request is single-digit dollars for a one-off backfill. Response shape is a `monthly_searches` array of `{year, month, search_volumes}` — compatible with the existing `keyword_monthly_volumes` writer after minor mapping (`YYYY-MM-01`).
- **Q: Existing table + metadata, or new history table + compat view?**
  Existing table + additive columns (`source`, `fetched_at`, unique `(keyword_id, month, source)`). A separate history table + view is more surface area with no functional benefit for our current consumer shape.
- **Q: Can enrichment preserve/append without breaking peak_month?**
  Yes. `peak_month` derivation only reads `(month, volume)` for a keyword. Widening the row set never lowers a peak — it can only surface a *better* peak if a prior year's month was higher. If we want v1 peak_month to remain unchanged during shadow mode, gate peak-month recomputation to only consider rows where `source = 'dataforseo_search_volume'` until Demand Intelligence v2 is visible.

### 8.2 Demand Intelligence scope

- **If 24 months feasible:** Yes — YoY per-month change, trailing-12 vs prior-12, category-level roll-ups, volatility, seasonality strength, decline/growth classification, confidence. All computed by `demand-signals-compute` v2, written to `keyword_demand_signals` and `category_demand_signals`, both stamped with `calc_run_id`.
- **If 24 months not feasible:** Fallback to 12-month momentum + recent-3 vs prior-3 + volatility + peak/shoulder + `data_coverage_months` warning. Mark every downstream badge with `confidence = 'low'`.
- **Informational-only until admin validation:** Yes — trend must not modify the primary Revenue v2 number in the first release. Surface as a badge + explanation, not as a multiplier on money.

### 8.3 GSC workbook importer

- **Q: New workbook importer with the sheet responsibilities as listed?**
  Yes — new edge function `gsc-workbook-import`, SheetJS in Deno. Sheet mapping matches your list.
- **Q: Parse `date_range_start / _end` from the `Chart` sheet, prompt manually otherwise?**
  Yes, with the 90–500 day sanity band above. Requires the additive `date_range_start / _end` columns on `gsc_uploads`.
- **Q: Add `device = 'all' / 'mixed'` or require three separate exports?**
  Add `'all'`. Rationale: the standard export Jake uses is genuinely all-device; forcing three uploads is friction the workflow will not survive. Store `device = 'all'` and mark the derived CTR curves `source = 'gsc_workbook_all_device'`. When a project later uploads device-filtered CSVs (existing path), the resolver prefers device-specific over all-device.
- **Q: CTR resolver fallback order?**
  Yes, exactly the order proposed:
  1. `project / device / intent / position`
  2. `project / all-device / intent / position`
  3. `fallback / device / intent / position`
  4. `fallback / generic / position`
  Already partially implemented in `compute-forecasts/index.ts` `getCtr()`; we extend it to step 2 in the v2 resolver.

### 8.4 Manual v2 runs before cron

- **Manual admin runs only for v1 of the v2 programme?** Yes. `pg_cron` remains available for detox/categorisation but the calculation-v2 edge functions get triggered from `/admin/calculations` via `invoke()` only.
- **Ship `/admin/calculations` early as minimal run-history + delta inspector, then grow?** Yes — this is Phase 1 in the revised sequencing (see §5). It is the gating mechanism for the whole programme.

### 8.5 Feature flags — **Direct columns on `navigator_projects`. Recommended.**

- **Direct columns vs. `project_feature_flags` table?** Direct columns for this codebase, right now. Reasons:
  - We only need two flags to start (`calculations_v2_compute_enabled`, `calculations_v2_visible_enabled`).
  - `navigator_projects` already has 23 columns and clean RLS (`is_visible_project`). Two more booleans do not degrade it.
  - Zero new RLS policies, zero new grants, zero types-file complexity beyond regenerating `types.ts`.
  - Admin UI reads/writes are a single `UPDATE` — no join, no policy question.
- **Later migration to a flags table straightforward?** Yes. If we later need >4–5 flags or per-user overrides, migration is: `CREATE TABLE project_feature_flags`, backfill from the columns, add a resolver, drop the columns. One migration, one edge function update. Cheap.

### 8.6 Link Power Score / HAR v2

- **LPS as standalone before HAR v2, reading `serp_results` + `client_domain_metrics` only?** Yes — new edge function `link-power-score-compute`, writes `link_power_scores` table `(project_id, url, calc_run_id, lps_score, components_json)`. No new external API calls. Uses only stored authority signals.
- **HAR v2 uses LPS + content-fit + SERP difficulty + observed-rank clamp without touching v1?** Yes. New edge function `har-calculation-v2` writes to a new `har_results_v2` (or `keyword_forecast_scenarios` if we co-locate) table. `har-calculation` v1 is not modified.
- **Standalone edge function with shared pure helpers?** Yes — extract the CTR resolver, seasonality helpers, and authority-percentile helpers into `supabase/functions/_shared/calc-helpers.ts` so v1 and v2 can co-evolve without divergence.

### 8.7 Revenue v2

- **Introduce true incremental fields without renaming `har_revenue_gain_annual`?** Yes — new `keyword_forecast_scenarios` table, per §3.5.
- **User-facing surfaces read v1 until `calculations_v2_visible_enabled = true`?** Yes. Add a small resolver hook `useForecastResolver(projectId)` that returns either the v1 row set or the v2 scenario row set based on the flag. All display components consume the resolver, not the tables directly.
- **Roadmap / content-plan payloads use the same resolver so AI outputs match the UI?** Yes — `content-plan-generate` and `roadmap-to-success` edge functions must read the same v1/v2 selection. We add a shared server-side helper (`_shared/forecast-source.ts`) that returns the same row set the frontend would render. This is non-negotiable — if the AI outputs numbers that don't match the UI the whole programme loses trust.

### 8.8 Conversion overrides

- **`project_conversion_overrides` admin/super_admin writable, users/view_only read via project visibility?** Yes. Policy shape:
  ```sql
  create policy "read via visibility" on public.project_conversion_overrides
    for select to authenticated
    using (public.is_visible_project(project_id));
  create policy "write admin only" on public.project_conversion_overrides
    for all to authenticated
    using (public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'super_admin'))
    with check (public.has_role(auth.uid(),'admin') or public.has_role(auth.uid(),'super_admin'));
  ```
- **Notes/reasons mandatory for URL-level and category-level overrides?** Yes — enforce with `CHECK (override_scope <> 'project' OR note IS NOT NULL)` or a lightweight validation trigger (preferred, per project rules on trigger validation). Also stamped with `created_by` and shown in the inspector so overrides are auditable.

---

## 5. Updated shadow-mode v2 scaffolding (Phase 1)

Confirms/extends the previous alignment doc. All additive, all shipped in one reviewable migration set (four sub-migrations for reviewability):

**Migration A — flags + registry**
- `navigator_projects.calculations_v2_compute_enabled boolean not null default false`
- `navigator_projects.calculations_v2_visible_enabled boolean not null default false`
- `calc_run_registry` (schema in §3.7)
- Grants + policies

**Migration B — monthly-volume history preservation**
- `keyword_monthly_volumes.source text not null default 'dataforseo_search_volume'`
- `keyword_monthly_volumes.fetched_at timestamptz not null default now()`
- Drop existing unique/PK if any, add unique `(keyword_id, month, source)`
- **Also patches `keyword-enrichment` to upsert instead of delete-then-insert — this must ship in the same PR as the schema change.**

**Migration C — GSC workbook fields**
- `gsc_uploads.date_range_start date`
- `gsc_uploads.date_range_end date`
- `gsc_uploads.source text not null default 'legacy_csv'`
- Optional: `gsc_upload_pages` for `Pages` sheet (deferred to Phase 2 if not needed on day one)

**Migration D — v2 output tables + config**
- `ctr_curve_metadata` (per curve: source, sample_size, confidence, date range, calc_run_id)
- `serp_feature_ctr_adjustments` (config; seedable)
- `har_scoring_config` (per-project weights, admin editable)
- `link_power_scores`
- `keyword_forecast_scenarios` (all Revenue v2 fields per §3.5)
- `project_conversion_overrides` (with the note validation trigger)
- `keyword_demand_signals`, `category_demand_signals`
- All with `calc_run_id` FK, RLS, grants (`SELECT` to `authenticated` via `is_visible_project`, `ALL` to `service_role`, admin-write policies for config tables)

---

## 6. UI/UX overlay — no visual mockups, just the surface list

Nothing renders v2 until `calculations_v2_visible_enabled = true` for the project. When it does:

- **`ProjectOverviewPage` (Briefing OS dashboard)** — Existing `BriefingCard` for Revenue gains an additional inline value ("Expected: £X realistic") and a subtle model-version chip (`v2.0`). `SeasonalityBadge` gains a "Demand trend" chip (Growing/Stable/Declining/Volatile) with confidence tier.
- **`ForecastTabHeader`** — Scenario toggle (`Conservative / Realistic / Stretch`), model-version chip, and a small "CTR source" chip (`GSC / Fallback / Blended`).
- **`HarAnalysisSection`** — New "Explain HAR" drawer surfacing LPS breakdown (auth, content-fit, SERP difficulty, imputation flags), driven by `link_power_scores.components_json` and `har_v2_result.explanation_json`. v1 columns remain visible with a "v1" chip when both are computed.
- **`RankingUrlSection` / `KeywordChallengeSection`** — Unaffected in v2.0; challenges still driven by `keyword_challenges`. Later phase: challenge picker uses v2 revenue for tie-breaks.
- **`PerformanceDashboardSection`** — Adds "Expected incremental revenue (realistic)" alongside existing TP revenue. Existing bars use v1; a small "compare v2" toggle shows the v2 scenario band. Off by default.
- **`CaptureWindowPage`** — Adds Demand-trend filter (Growing / Declining) and an "urgent + growing" combined chip. Uses `keyword_demand_signals`.
- **`ContentPlanDetailPage` and roadmap views** — Consume forecast via the shared resolver (see 8.7). Text summarising revenue impact must state which model version generated the number ("Based on realistic scenario, model v2.0").
- **`/admin/calculations`** (new, admin/super_admin only) — Run list, trigger button per project, run-detail page with per-family diff tables, sample-keyword drilldown, warnings/errors JSON. Ships in Phase 1.
- **Slide exports (`exportSlides.ts` + `export-performance-slides` edge function)** — Every slide gets a footer chip `Seer model v1` or `Seer model v2.0`. Exports respect the project's visibility flag at export time (never mix v1 chart + v2 headline number).

---

## 7. Guardrails & sequencing (reconfirmed)

- **Read all keyword ID lookups in batches of ≤100.** The `LOOKUP_BATCH = 100` limit in `compute-forecasts/index.ts` exists specifically because larger `.in()` filters silently drop rows past the PostgREST URL length limit. Every new v2 edge function must observe it.
- **DFS rate-limits + Ahrefs cost** — HAR v2 does not add external API calls (uses stored `serp_results`). LPS same. Demand Intelligence backfill is a one-off DFS burst; standard enrichment cadence unchanged.
- **RLS + grants** — Every new public table gets `GRANT SELECT ON ... TO authenticated; GRANT ALL ON ... TO service_role;` in the same migration, per project standing rule.
- **Migration order** — A → B → C → D. Migration B carries a hard dependency on the `keyword-enrichment` code change being deployed simultaneously; that PR must include both.
- **Rollback** — Deleting a `calc_run_registry` row cascades all v2 rows for that run. Flags default to `false`; setting `calculations_v2_compute_enabled = false` stops new writes; setting `calculations_v2_visible_enabled = false` restores v1 view instantly.
- **pg_cron** — No new cron jobs in Phase 1. Manual-only until inspector validates ≥1 run per family per project.

Revised phase order (matches Jake's §4 with one adjustment — Phase 10 inspector pulled forward into Phase 1):

1. Scaffolding + flags + registry + inspector shell
2. GSC workbook importer
3. CTR curves from workbook
4. DFS 24-month backfill (contingent on Labs access confirmation)
5. Demand Intelligence v1
6. SERP-feature CTR deflators
7. Link Power Score
8. HAR v2
9. Revenue v2
10. User-facing v2 UI (behind visibility flag)
11. Cron (only after inspector validation)

---

## 8. Residual product decisions still needed from Jake

Code alone cannot answer these. Confirming them unblocks prompt-sequence generation:

1. **DataForSEO Labs access.** Is the current DFS account subscribed to the Labs API? (Determines whether Phase 4 uses `historical_search_volume` or falls back to `keywords_for_keywords`.)
2. **First project(s) to receive v2 compute.** Pick 1–2 low-risk projects to enable `calculations_v2_compute_enabled` on, so the inspector has real data to review before wider rollout.
3. **Divergence tolerance.** What v1↔v2 delta warrants a warning on the inspector? Suggested defaults: >30% revenue divergence at project level, >2 HAR position points at keyword level, but Jake should sign off.
4. **Brand-flag strategy** — remains deferred. Confirm we are OK deferring brand/non-brand CTR split to a later workstream (as §10.9 states), i.e. the first CTR-v2 curves treat brand and non-brand traffic mixed.
5. **Override auditability** — confirm `project_conversion_overrides.note` is mandatory only for URL-level and category-level overrides, not project-level defaults.

---

## 9. Bottom line

The follow-up plan is fully implementable as described, with two small structural adjustments Lovable is recommending:

- **Fix `keyword_monthly_volumes` writer semantics as part of Migration B**, or the historical backfill will be silently erased by the next standard enrichment.
- **Pull `/admin/calculations` inspector into Phase 1** so nothing else in the programme ships without a review surface.

Everything else — GSC workbook parsing, mixed/all-device CTR curves, LPS-then-HAR-v2 sequencing, Revenue v2 without renaming, manual-first runs, direct-column feature flags — is confirmed feasible against the current codebase, and preserves the additive/shadow-mode/versioned guarantees in §10 of the follow-up doc.

Ready for the next brainstorming round.
