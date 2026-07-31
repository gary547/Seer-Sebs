# Seer® UX Audit

Owner: Lovable agent · Scope: all authenticated routes · Method: source review + Playwright walk-through against the live preview.

Severity key:
- **P0** — blocks a job or hides data the user came for.
- **P1** — wastes clicks, creates duplicate chrome, or breaks the IA you just established.
- **P2** — polish, copy, a11y, mobile.

This audit ships with the Phase A rebuild of `ProjectOverviewPage`. Findings flagged **[fixed in A]** are addressed in that same change. Everything else is queued into Phases B–F per `.lovable/plan.md`.

---

## 1. Project workspace (`/clients/:clientId/projects/:projectId/*`)

### 1.1 Project Overview is a menu of menus — **P0** **[fixed in A]**
The Overview page rendered a 6-tile "Jump into a view" grid (Setup, Forecast, Site Architecture, Roadmap, Content Plans, Ranking URLs & TP). Every one of those views is already a tab in the project sub-nav directly above the page, so opening a project forced the user to either (a) click a tile to get to the data, or (b) click a tab to get to the same data. The landing showed no actual project numbers beyond the hero strip — no TP keyword breakdown, no Performance Output snapshot, no site-architecture health.

Fix shipped in Phase A: tiles removed; the Overview now renders Performance Output total, kept-keyword TP Revenue, # keywords at TP ≤ 3, and average Site Architecture relevancy as headline KPIs, plus a top-5 TP Revenue keyword table. The next-best-action card stays and now branches on "blocked" pipeline states.

### 1.2 Site Architecture / Roadmap / Content Plans are anchors inside Forecast — **P1**
`VIEW_TO_STEP` in `NavigatorProjectDetailPage.tsx` maps `site-architecture`, `roadmap` and `content-plans` to `step: "forecast"` with an in-page scroll. Result: the sub-nav says you're on "Site Architecture" but you're really on Forecast with a scroll. This is the structural reason the Overview tiles felt necessary — the sub-nav didn't expose these views as first-class tabs.

Fix queued for Phase B: promote these to real tabs.

### 1.3 Two competing primary buttons in the workspace header — **P1**
Today the project header surfaces both "Setup" and "Open Roadmap to Success" as buttons of equal visual weight. The user can't tell which is the intended next action. Phase B will collapse these into one stateful primary action ("Run sync now" before first sync, "Open Roadmap to Success" once forecasts exist, "Resolve blocked job" when the pipeline is stalled).

### 1.4 Empty Forecast view after first sync, no recovery affordance — **P1**
If `compute-forecasts` fails or hasn't run, the Forecast tab renders an empty table with no message. The self-heal recompute is buried inside `HarAnalysisSection`. Phase B will lift the recompute/blocked-state copy into the tab itself.

### 1.5 Breadcrumb hierarchy is good, but the page title duplicates it — **P2**
The breadcrumb (Dashboard › Client › Project › View) plus the giant project title in the hero plus the eyebrow client name = three places the same identity is repeated. Phase F: drop the eyebrow on Overview, keep it on sub-views where the page title differs.

---

## 2. Sidebar / global nav

### 2.1 "Seer® Projects" sidebar item duplicates the Clients drill-down — **P1**
The sidebar's "Seer® Projects" link routes to legacy `/navigator`, which is now a flat list that doesn't match the Dashboard → Clients → Client → Project IA. Per locked decision in `.lovable/plan.md`, Phase C removes this item; legacy `/navigator/:id` redirects remain.

### 2.2 No in-context jump list when a client/project is selected — **P1**
The sidebar is intentionally static and global. That's correct for the global level, but when a user is deep inside a project they have no quick way to jump between Project Overview, Forecast, Roadmap, etc. from the sidebar — they have to re-find the sub-nav. Phase C adds a thin "In context" group that appears only when the URL has `:clientId` / `:projectId`.

### 2.3 Work-group order doesn't reflect frequency — **P2**
Current order mixes high-frequency (Dashboard, Clients) with lower-frequency (Audience Insights). Phase C re-orders by usage.

---

## 3. Global landings

### 3.1 `/dashboard` — recent projects strip still emits legacy URLs in some paths — **P1**
Audit confirms most cards use canonical `/clients/:id/projects/:id`, but the localStorage migration path in `RecentProjectsStrip` can resurface a legacy URL if the cached entry pre-dates Phase 1. Phase D adds a one-time normalization on read.

### 3.2 `/clients` — card click target ambiguity — **P1**
Card body opens `/clients/:id` (correct), but the pencil icon also lives on the card and opens `/clients/:id/edit`. Hit-target is too close. Phase D moves edit into a row action menu.

### 3.3 `/clients/:id` — page is just a project list — **P2**
No KPI strip, no client-level rollups. Phase D adds total TP Revenue across projects and a status mix bar.

### 3.4 `/capture-window` and `/audience-insights` — no scope chip when filtered — **P1**
Both pages support a `clientId` query filter but render identically whether filtered or not. Phase D adds a "Filtered to {Client}" chip with a clear affordance.

---

## 4. Tools & admin

### 4.1 URL Monitor campaign detail dead-ends — **P1**
After running a check, the user is left on the campaign detail page with no "back to campaigns for this client" link and no above-the-fold summary of the latest run's diff. Phase E.

### 4.2 Content Plans — scope is invisible — **P1**
The global `/content-plans` list and the project-scoped list render with identical chrome. Phase E adds a scope badge in the header and a scope-aware empty-state CTA.

### 4.3 Admin Users — pending badge can desync from in-page count — **P2**
The sidebar pending badge reads from a different cache key than the Users page table. Phase E unifies on a single query.

### 4.4 Account / Pending approval — copy is generic — **P2**
The pending-approval page says "your account is pending" with no indication of who to contact. Phase E adds the admin email.

---

## 5. Cross-cutting

### 5.1 Loading/empty/error states are inconsistent — **P2**
Some pages use Shimmer, some use spinners, some render blank. Phase F standardises on one set of components.

### 5.2 Breadcrumbs missing on Client edit, Content Plan detail, URL Monitor detail — **P2**
Phase F adds them via the existing Breadcrumb primitive used by `ProjectWorkspaceLayout`.

### 5.3 Mobile — ClientProjectSwitcher trigger is hard to reach — **P1**
On <768px the switcher collapses into the sticky header but the trigger button has no visible label and a tap-target under 40px. Phase F.

### 5.4 A11y — sub-nav lacks `aria-current`, cards have weak focus rings — **P2**
Phase F.

---

## 6. Validation plan

Phase G extends `e2e/navigation-smoke.spec.ts` to assert:
- Project Overview shows KPI numbers (not just tile links).
- Project sub-nav exposes all 7 first-class views.
- Scoped sidebar group appears only when the URL has `:clientId`.
- The "Seer® Projects" sidebar item is gone.
- Legacy `/navigator/:id` still redirects.
