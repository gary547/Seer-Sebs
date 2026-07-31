# Seer® UX Roll-out — Phases B to F

Companion sequencing doc to `docs/UX_AUDIT.md`. Phase A (Project Overview rebuild + audit) is shipped. This file is the single source of truth for the remaining phases.

Guardrails — apply to every phase below:
- Frontend / presentation only. No changes to forecast formulas, edge functions, RLS, or DB schema.
- Preserve all legacy redirects established in Phases 1–8 of the navigation restructure.
- All internal links go through `src/lib/routes.ts` helpers — no hardcoded paths.
- Each phase ships in isolation behind a single approval gate.

Sequencing:

```text
A (done) ──► B ──► C ──► D ──► E ──► F ──► G
                 │
                 └── C may start in parallel once B's VIEW_TO_STEP change is merged
```

D and E are independent and can be parallelised if needed. F is the cleanup pass and runs immediately before G validation.

---

## Phase B — Project workspace structural fixes

- **Objective.** Make the project sub-nav match the work the user actually does, and give the workspace one obvious primary action.
- **Source findings.** UX_AUDIT §1.2, §1.3, §1.4.
- **Scope (in).**
  - Promote `site-architecture`, `roadmap`, and `content-plans` from Forecast in-page anchors to first-class entries in `VIEW_TO_STEP` and the sub-nav in `NavigatorProjectDetailPage.tsx`.
  - Keep the existing `#site-architecture` hash → canonical redirect added in Phase 7B.
  - Collapse the two header buttons ("Setup", "Open Roadmap to Success") into one stateful primary action driven by pipeline state:
    - `needs-sync` → "Run sync now"
    - `ready` → "Open Roadmap to Success"
    - `blocked` → "Resolve blocked job"
  - Reuse the next-action logic already in `ProjectOverviewPage` (extract into a small `useProjectNextAction` hook so both call sites stay in sync).
  - Lift the HAR self-heal / blocked-state messaging out of `HarAnalysisSection` into a Forecast-tab-level empty/error state so it is visible without scrolling.
- **Scope (out).** Forecast formulas, edge functions, schema, the recompute trigger thresholds.
- **Files touched.**
  - `src/pages/NavigatorProjectDetailPage.tsx`
  - `src/hooks/useProjectNextAction.ts` (new)
  - `src/components/forecast/HarAnalysisSection.tsx` (move copy out, keep self-heal)
  - `src/components/forecast/ForecastTabHeader.tsx` (new, optional)
- **Acceptance.** Sub-nav exposes 7 first-class tabs. Header has one primary button whose label and target change with pipeline state. Forecast tab shows a recovery card above the fold when stale/blocked.
- **Validation.** Manual walk-through plus `e2e/navigation-smoke.spec.ts` updated in Phase G.
- **Risk / rollback.** Sub-nav change is purely presentational; revert is a single-file rollback. Risk: a deep link to `#site-architecture` from email/Slack should still land users correctly — covered by the existing redirect.
- **Dependencies.** None.

---

## Phase C — Sidebar & in-context navigation

- **Objective.** Make the sidebar match the new IA: global at the top, contextual when deep in a project.
- **Source findings.** UX_AUDIT §2.1, §2.2, §2.3.
- **Scope (in).**
  - Remove the "Seer® Projects" item from `AppSidebar.tsx`. Legacy `/navigator` and `/navigator/:id` routes continue to redirect.
  - Add an "In context" sidebar group that renders only when `useSeerRouteContext` resolves a `:projectId`. It mirrors the project sub-nav (Overview, Forecast, Site Architecture, Roadmap, Content Plans, Ranking URLs & TP, Setup).
  - Re-order the Work group by usage frequency: Dashboard, Clients, Capture Window, Content Plans, URL Monitor, Audience Insights.
  - Update `CommandPalette` groupings to match (no behavioural change — just label order and the dropped "Seer® Projects" entry).
- **Scope (out).** Sidebar styling, collapsed-state behaviour, mobile drawer.
- **Files touched.**
  - `src/components/AppSidebar.tsx`
  - `src/components/CommandPalette.tsx`
- **Acceptance.** Sidebar shows the In-context group only when inside a project. "Seer® Projects" item is gone. Deep-linking to `/navigator/:id` still redirects to the canonical project URL.
- **Validation.** Manual + Phase G specs.
- **Risk / rollback.** Low. Any user who bookmarked `/navigator` still resolves to the legacy redirect → Clients page.
- **Dependencies.** Phase B (so the in-context list mirrors real tabs).

---

## Phase D — Global landings polish

- **Objective.** Tidy the global entry points so scope is always obvious and hit targets are unambiguous.
- **Source findings.** UX_AUDIT §3.1–§3.4.
- **Scope (in).**
  - `RecentProjectsStrip`: on read, normalise any cached legacy `/navigator/:id` to canonical `/clients/:clientId/projects/:projectId` and write back to localStorage.
  - `ClientsPage`: move the pencil/edit affordance into a row-action menu (three-dot button) so the card body is the only primary hit target.
  - `ClientDashboardPage`: add a KPI strip showing total TP Revenue across the client's projects, project count, and a status mix bar. Use existing hooks where possible.
  - `CaptureWindowPage` and `AudienceInsightsPage`: render a "Filtered to {Client}" chip with a Clear-filter affordance when `?clientId=` is present.
- **Scope (out).** New data queries unless strictly necessary, page-level redesigns.
- **Files touched.**
  - `src/components/dashboard/RecentProjectsStrip.tsx`
  - `src/pages/ClientsPage.tsx`
  - `src/pages/ClientDashboardPage.tsx`
  - `src/pages/CaptureWindowPage.tsx`, `src/pages/AudienceInsightsPage.tsx`
- **Acceptance.** No legacy URLs surface in recents after first load. Edit-icon mishits gone. Client dashboard shows headline KPIs. Filtered global tools show a visible scope chip with a clear action.
- **Validation.** Manual + targeted Playwright assertions in Phase G.
- **Risk / rollback.** Each change is local to one component. ClientDashboard KPIs depend on existing `useNavigatorProjects` rollups — verify the totals match the project-level numbers before shipping.
- **Dependencies.** None. Can run in parallel with Phase E.

---

## Phase E — Tools & admin

- **Objective.** Close the dead-ends and ambiguity in the tools and admin surfaces.
- **Source findings.** UX_AUDIT §4.1–§4.4.
- **Scope (in).**
  - URL Monitor campaign detail: add a "Back to {Client} campaigns" link and an above-the-fold "Latest run" diff summary card.
  - Content Plans: add a scope badge in the header ("Global" vs "Project: {name}") and a scope-aware empty-state CTA.
  - Admin Users: unify the sidebar pending-badge query with the Users page table query behind a single `useAdminPendingCount` hook.
  - Pending Approval page: surface the configured admin contact email so users know who to chase.
- **Scope (out).** New edge functions, RBAC changes, monitor scheduling logic.
- **Files touched.**
  - `src/pages/tools/UrlMonitorCampaignDetailPage.tsx`
  - `src/pages/ContentPlansPage.tsx`, `src/pages/ContentPlanDetailPage.tsx`
  - `src/pages/admin/UsersPage.tsx`, `src/components/AppSidebar.tsx`
  - `src/hooks/useAdminPendingCount.ts` (new)
  - `src/pages/PendingApprovalPage.tsx`
- **Acceptance.** Monitor detail has a back link and a visible latest-run summary. Content Plans always shows its scope. Pending count never desyncs between sidebar and table. Pending page tells the user who to contact.
- **Validation.** Manual + Phase G admin spec.
- **Risk / rollback.** Pending-badge unification is the only shared change — verify both surfaces re-render after a role mutation.
- **Dependencies.** None. Can run in parallel with Phase D.

---

## Phase F — Cross-cutting hygiene

- **Objective.** One consistent vocabulary for loading/empty/error, breadcrumbs everywhere, mobile + a11y cleanup.
- **Source findings.** UX_AUDIT §1.5, §5.1–§5.4.
- **Scope (in).**
  - Standardise loading / empty / error states on a single primitive set (Shimmer for loading, EmptyState for empty, ErrorState for error). Replace ad-hoc spinners across pages and components.
  - Add breadcrumbs to Client edit, Content Plan detail, and URL Monitor detail using the existing Breadcrumb primitive from `ProjectWorkspaceLayout`.
  - Mobile: give `ClientProjectSwitcher` a visible label and a ≥44px tap target under 768px.
  - A11y: add `aria-current="page"` to active sub-nav items; strengthen focus rings on cards.
  - Drop the duplicate client eyebrow on Project Overview (keep on sub-views where the page title differs).
- **Scope (out).** Visual redesigns, palette changes, dark-mode tuning.
- **Files touched.**
  - Wide but shallow: most page-level components, `src/components/ui/empty-state.tsx` and `error-state.tsx` (new or existing).
  - `src/components/ClientProjectSwitcher.tsx`
  - `src/pages/ClientOnboardingPage.tsx`, `src/pages/ContentPlanDetailPage.tsx`, `src/pages/tools/UrlMonitorCampaignDetailPage.tsx`
  - `src/pages/project/ProjectOverviewPage.tsx` (drop eyebrow only)
- **Acceptance.** No raw spinners or blank panels remain on common routes. Breadcrumbs on every authenticated page. Mobile switcher meets tap-target size. Sub-nav announces the active page to screen readers.
- **Validation.** Manual mobile pass at 375px, axe pass on Dashboard / Project Overview / Forecast, plus Phase G regression.
- **Risk / rollback.** Wide blast radius. Ship in two PRs if needed (states first, then breadcrumbs + a11y + mobile).
- **Dependencies.** Phases B–E (otherwise we re-touch the same files).

---

## Phase G — Validation (runs after F)

Not a UX phase per se — extends `e2e/navigation-smoke.spec.ts` with:

- Project Overview asserts numeric KPI text, not just tile links.
- Project sub-nav lists all 7 first-class views.
- Scoped sidebar group is present only when the URL contains `:clientId` / `:projectId`.
- "Seer® Projects" sidebar item is absent.
- Legacy `/navigator/:id` still redirects to canonical.
- Filtered scope chips appear on Capture Window and Audience Insights when `?clientId=` is present.

---

## Quick reference — phase × audit finding

| Phase | Audit refs                  |
| ----- | --------------------------- |
| A     | §1.1 (shipped)              |
| B     | §1.2, §1.3, §1.4            |
| C     | §2.1, §2.2, §2.3            |
| D     | §3.1, §3.2, §3.3, §3.4      |
| E     | §4.1, §4.2, §4.3, §4.4      |
| F     | §1.5, §5.1, §5.2, §5.3, §5.4 |
| G     | §6                          |
