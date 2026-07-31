# Calculation v2 — Phase 0.1 Baseline Report

**Prompt:** 0.1 — Confirm current codebase baseline before changes
**Mode:** Read-only. No code, migration, edge-function, secret, RLS, or UI edits.
**Verdict:** **Baseline confirmed.** No blockers. Prompt 1.1 can proceed as written.

---

## §1 Routes / components

| Purpose | File | Route (if applicable) | Notes |
|---|---|---|---|
| Project overview | `src/pages/project/ProjectOverviewPage.tsx` | `/project/:id` (via `ProjectWorkspaceLayout`) | Briefing OS composition — landing surface for v2 headline hook in Prompt 11.2 |
| Forecast tab / header | `src/components/forecast/ForecastTabHeader.tsx` | rendered inside project workspace | Target for Prompt 11.2 scenario toggle |
| HAR analysis | `src/components/HarAnalysisSection.tsx` | rendered in project workspace | Target for Prompt 11.3 explanation drawer |
| CTR curve section | `src/components/CtrCurveSection.tsx` | rendered in project workspace | Target for Prompt 4.3 provenance chip |
| Capture Window | `src/pages/CaptureWindowPage.tsx` | `/capture-window` | Target for Prompt 11.4 demand chips/filters |
| Admin — Users | `src/pages/admin/UsersPage.tsx` | `/admin/users` | Existing admin pattern (RBAC-gated) |
| Admin — Categories | `src/pages/admin/CategoriesPage.tsx` | `/admin/categories` | |
| Admin — Archive | `src/pages/admin/ArchivePage.tsx` | `/archive` (wrapped in `ProtectedRoute requireRole={["admin","super_admin"]}`) | Reference pattern for Prompt 1.4 `/admin/calculations` shell |
| Admin — Archive detail | `src/pages/admin/ArchiveClientPage.tsx`, `src/pages/admin/ArchiveProjectPage.tsx` | `/archive/clients/:clientId`, `/archive/clients/:clientId/projects/:projectId` | |
| Sidebar / menu wiring | `src/components/AppSidebar.tsx` | — | Point of extension for new `/admin/calculations` link |
| App route table | `src/App.tsx` (lines 84–113) | — | Prompt 1.4 must add new route inside the same authenticated layout |

---

## §2 Edge functions

| Function | Path | Purpose | Notes for v2 |
|---|---|---|---|
| `keyword-enrichment` | `supabase/functions/keyword-enrichment/index.ts` | DFS-driven enrichment: volume, difficulty, intent, monthly volume, peaks | **Touched by Prompt 2.2 only** (monthly-volume writer swap) |
| `har-calculation` | `supabase/functions/har-calculation/index.ts` | Computes `har_results` per keyword using Ahrefs UR ladder | **Touched by Prompt 9.1 only** (missing-UR mitigation) |
| `compute-forecasts` | `supabase/functions/compute-forecasts/index.ts` | Writes v1 `keyword_forecasts` (CTR, expected traffic/revenue, HAR-derived uplifts) | **Off-limits.** All v2 revenue lives in a new `compute-forecasts-v2` function (Prompt 10.2) |
| `gsc-intent-enrichment` | `supabase/functions/gsc-intent-enrichment/index.ts` | CSV upload path — parses GSC CSV, writes `gsc_uploads` + `gsc_upload_keywords`, enriches intent | **Unchanged.** New workbook path is a separate `gsc-workbook-import` function (Prompt 3.2) |
| `roadmap-to-success` | `supabase/functions/roadmap-to-success/index.ts` | Claude-driven roadmap; consumes forecast rows | Rewired via shared resolver in Prompt 10.4 |
| `content-plan-generate` | `supabase/functions/content-plan-generate/index.ts` | Claude-driven content plan; consumes forecast rows | Rewired via shared resolver in Prompt 10.4 |

Also present but out of scope for Prompt 0.1: `claude`, `ctr-benchmark`, `serp-feature-upsert`, `ranking-url-lookup`, `site-architecture`, `keyword-detox`, `keyword-categorisation`, `categorisation-consolidate`, `categorisation-deferred-tick`, `export-performance-slides`, `url-monitor-tick`, `url-monitor-prune`, `archive-hard-delete`, `admin-*`.

---

## §3 Tables and current columns

Extracted from `src/integrations/supabase/types.ts` (canonical for the app's PostgREST client).

### `navigator_projects` (lines 1796–1888)
Columns: `id, client_id, project_name, status, category_focus, aov, conversion_rate, ctr, seasonality_start, seasonality_end, har_status, ranking_lookup_status, inputs_dirty, keywords_dirty, serp_dirty, last_dirty_at, last_synced_at, duplicated_from, archived_at, archived_by, archive_reason, created_at, updated_at`.
**v2 gap:** no `calculations_v2_compute_enabled` / `calculations_v2_visible_enabled` — Prompt 1.1 adds them.

### `keyword_monthly_volumes` (lines 1402–1440)
Columns: `id, keyword_id, month, volume`.
**v2 gap:** no `source`, no `fetched_at`; no visible `(keyword_id, month, source)` unique. Prompt 2.1 adds both columns and the unique.

### `gsc_uploads` (lines 920–951)
Columns: `id, project_id, device, row_count, uploaded_at`.
**v2 gap:** no `date_range_start`, no `date_range_end`, no `source`. Prompt 3.1 adds all three.

### `gsc_upload_keywords` (lines 879–919)
Columns: `id, upload_id, keyword, clicks, impressions, ctr, position, search_intent`.
No v2 change required.

### `ctr_curves` (lines 562–599)
Columns: `id, project_id, device, intent_segment (nullable), rank_position, ctr_percentage, is_fallback`.
**v2 gap:** no unique on `(project_id, device, intent_segment, rank_position)`. Prompt 1.3 adds it, and `ctr_curve_metadata` (1:1 side-table) is created.

### `keyword_forecasts` (lines 1331–1401)
Columns: `id, keyword_id (unique 1:1 → keywords), current_ctr_pct, est_current_clicks_annual, est_current_revenue_annual, expected_traffic_rank1_annual, har, har_is_manual, har_revenue_gain_annual, har_traffic_gain_annual, is_in_capture_window, months_to_peak, opportunity, peak_source, seasonal_urgency, weighted_sum, yearly_revenue_gain_rank1, yearly_traffic_gain_rank1`.
**Programme rule confirmed:** `har_revenue_gain_annual` present as v1 field — Prompt 10.2 introduces the additive `tp_incremental_revenue_annual` on the new `keyword_forecast_scenarios` table instead of renaming.

### `serp_features` (lines 1981–2024)
Columns: `id, keyword_id, result_type, serp_feature_count, serp_feature_owned, serp_intent, snippet_opportunity, top_serp_feature, top_serp_feature_url`.
Used by Prompt 7.1 CTR deflator helper.

### `serp_landscape` (lines 2025–2065)
Columns: `id, keyword_id, device, owned, ranking_url, result_type, serp_feature_raw, serp_intent`.
Correctly deferred to a later HAR difficulty prompt — not used in Phase 7.

### `serp_results` (lines 2101–2160)
Columns: `id, project_id, keyword_id, rank_absolute, domain, url, url_rating, domain_rating, ahrefs_rank, referring_domains, backlinks, fetched_at`.
All authority signals needed for Prompt 8.1 LPS are present.

### `client_domain_metrics` (lines 186–223)
Columns: `id, project_id (unique 1:1), domain, url_rating, domain_rating, ahrefs_rank, fetched_at`.
Used by Prompt 8.1 (client authority anchor) and Prompt 9.2 (HAR v2).

---

## §4 `keyword-enrichment` monthly-volume writer — delete-then-insert **confirmed**

`supabase/functions/keyword-enrichment/index.ts` lines 402–410:

```ts
monthlyTasks.push(async () => {
  await supabase.from("keyword_monthly_volumes").delete().eq("keyword_id", id);
  if (monthRows.length) await supabase.from("keyword_monthly_volumes").insert(monthRows);
});
```

DFS source shape (line 339): `item.monthly_searches` array of `{ year, month, search_volume }`, mapped to `{keyword_id, month: 'YYYY-MM-01', volume}` for insert. This is the exact block Prompt 2.2 will replace with an upsert on `(keyword_id, month, source)` using `source='dataforseo_search_volume'`.

**Consequence for Phase 5:** until Prompt 2.2 lands, any historical rows added by 5.2 would be wiped on the next standard enrichment run. Appendix A order (2.1 → 2.2 → 5.x) correctly prevents this.

---

## §5 `har-calculation` missing-UR handling — `?? 0` **confirmed**

`supabase/functions/har-calculation/index.ts`:

- Line 980 — **client** missing metrics fallback: `const clientMetrics = ahrefsMap[clientKey] ?? { url_rating: 0, domain_rating: 0, ahrefs_rank: 0 };`
- Line 1025 — per-keyword client UR fallback: `kwClientUR = ahrefsMap[u]?.url_rating ?? clientMetrics.url_rating;`
- Line 1031 — **competitor** UR fallback (the one Prompt 9.1 targets): `const cur = ahrefsMap[c.url]?.url_rating ?? 0;`
- Line 1032 — HAR ladder comparison: `if (kwClientUR >= cur) { pos = c.rank_absolute; ... break; }` — treats missing competitors as beatable, producing spuriously optimistic HAR positions.

Downstream aggregate written per keyword (lines 1039–1047): `har_position`, `client_url_rating`, `har_competitor_ur`, `har_competitor_url` → upserted into `har_results`. This is the surface Prompt 9.1's mitigation (median-of-known + floor recommended) must protect.

---

## §6 Admin `/admin/calculations` route — does **not** exist

`src/App.tsx` currently declares these admin/admin-adjacent routes only:

- `/admin/users` (line 84)
- `/admin/categories` (line 85)
- `/archive`, `/archive/clients/:clientId`, `/archive/clients/:clientId/projects/:projectId` (lines 90–112) — each wrapped in `<ProtectedRoute requireRole={["admin","super_admin"]}>`

**No `/admin/calculations` route present.** Prompt 1.4 will add the shell using the same `ProtectedRoute requireRole={["admin","super_admin"]}` pattern as the Archive routes.

---

## §7 Test / build commands

From `package.json` scripts:

| Command | What it runs |
|---|---|
| `npm run dev` | `vite` — local dev server |
| `npm run build` | `vite build` — production build |
| `npm run build:dev` | `vite build --mode development` |
| `npm run lint` | `eslint .` |
| `npm run preview` | `vite preview` |
| `npm run test` | `vitest run` — unit tests (config: `vitest.config.ts`, setup: `src/test/setup.ts`) |
| `npm run test:watch` | `vitest` in watch mode |

Additionally: `@playwright/test ^1.57.0` is installed with configs at `playwright.config.ts` and specs under `e2e/` (`archive-flow`, `client-domain-uniqueness`, `navigation-smoke`, `phase-j-hygiene`, `ux-journey-audit`) — no npm script wrapper; Playwright is invoked directly via `npx playwright test`.

**Edge-function test harness:** none. Prompt 2.3's fallback ("manual SQL check plus developer note") is the correct approach.

**Typecheck:** no dedicated `tsc --noEmit` script; typecheck is enforced through `vite build` and the sandbox's automatic checks.

---

## Blockers before Phase 1

**None.** Findings match every assumption in Prompts 1.1–1.4:

- `navigator_projects` has no v2 flag columns → 1.1 can add them cleanly.
- `calc_run_registry` and all v2 output tables (`ctr_curve_metadata`, `link_power_scores`, `keyword_forecast_scenarios`) are net-new → 1.3 has no naming collisions.
- `ctr_curves` currently has no `(project_id, device, intent_segment, rank_position)` unique → 1.3 will add it without conflict.
- No `/admin/calculations` route exists → 1.4 shell is a clean add.
- Standard admin RBAC pattern (`ProtectedRoute requireRole`) is in place → 1.4 can reuse it verbatim.
- v1 edge functions untouched by this phase; the two sanctioned v1 edits (`keyword-enrichment` 2.2, `har-calculation` 9.1) both target lines this report cites exactly.

**Stop-Condition Watchlist (`docs/calculation-v2-prompt-sequence-review.md` §5) cross-check:** no signals present in current codebase.

---

## Ready-to-fire note

**Baseline confirmed. Fire Prompt 1.1** — add `calculations_v2_compute_enabled` / `calculations_v2_visible_enabled` booleans to `navigator_projects` and create the `calc_run_registry` table with RLS, grants, and type regeneration.

When you fire Prompt 1.3 later, remind me to also add a `(calc_run_id, keyword_id, scenario)` unique index on `keyword_forecast_scenarios` so that Prompt 10.2's "update existing rows" behaviour works cleanly on re-runs.
