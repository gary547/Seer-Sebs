# Seer® UX Roadmap — Phases H → J

> Companion to `docs/UX_AUDIT.md`, `docs/UX_PHASES_B_TO_F.md`, and `docs/UX_JOURNEY_AUDIT.md`.
> Source-of-truth for the next three UX phases. Each phase ships behind an explicit approval gate.

---

## Cross-phase guardrails (apply to H, I, and J)

These rules are non-negotiable and carried forward from Phases B–G:

- **Routing** — All navigation goes through `src/lib/routes.ts` helpers (`clientHome`, `projectHome`, `projectView`, etc.). No string-literal paths in components.
- **Sidebar** — `AppSidebar.tsx` stays static and global. The only dynamic block is the sanctioned **"In context · {project}"** group, driven by `useSeerRouteContext`.
- **Breadcrumbs** — Every nested page renders `SeerBreadcrumbs`. No bespoke breadcrumb implementations.
- **State primitives** — Loading uses `Shimmer*`, empty states use `EmptyState`, error states use `ErrorState`. No ad-hoc spinners or null-returns.
- **Typecheck** — `tsgo` must be clean before any phase ships.
- **E2E** — Extend `e2e/navigation-smoke.spec.ts` and `e2e/ux-journey-audit.spec.ts`; never replace them. New tests must be guarded so they skip gracefully when auth env vars are absent.
- **Scope discipline** — UI / presentation only. No edge-function changes, no schema changes, no RLS changes, no business-logic changes in H–J.
- **Hardcoded route guard** — Before each phase merges, run `rg -n "navigate\\(['\"]/" src` and `rg -n "to=['\"]/" src` to confirm no regressions.

---

## Phase H — P0 + tiny P1 wins

**Objective.** Ship the lowest-risk, highest-value fixes from the UX Journey Audit in one batch.

### H1 — UX-001 · Remove Setup → Forecast auto-redirect
- **File:** `src/pages/NavigatorProjectDetailPage.tsx`.
- **Change:** Delete the `useEffect` that pushes users from `/setup` to `/forecast` when forecasts exist. Setup must remain a destination the user can revisit at will.
- **Legacy safety:** Confirm legacy `/navigator/:id` and unparameterised project URLs still resolve to `ProjectOverviewPage` via the existing project index route.
- **E2E:** Add a case to `e2e/ux-journey-audit.spec.ts` that navigates Sidebar → Setup, then Sidebar → Dashboard, then Sidebar → Setup again and asserts `page.url()` ends with `/setup`.

### H2 — UX-002 · Preserve intended destination through auth
- **Files:** `src/pages/AuthPage.tsx`, protected route wrappers (search for `Navigate to="/auth"`).
- **Change:** On redirect to `/auth`, pass `state: { from: location }`. After successful sign-in, navigate to `from.pathname + from.search` if present, otherwise default to `/dashboard`.
- **Guardrail:** Reject any `from` that isn't a same-origin pathname (no protocol, no `//` prefix) — closes the open-redirect class.
- **E2E:** Visit `/clients/:id/projects/:id/forecast` while signed out, complete auth, assert landing is the originally requested URL.

### H3 — UX-005 · Sub-nav skeleton while route context loads
- **File:** `src/components/AppSidebar.tsx`.
- **Change:** When `useSeerRouteContext()` reports `clientId && projectId && loading`, render 8 shimmer rows under the "In context" label so the group doesn't flicker in/out during navigation.
- **Acceptance:** Visual smoke at 375px and 1280px viewports; no layout shift once data resolves.

### H4 — UX-006 · React Router v7 future flags
- **File:** `src/App.tsx` (or wherever `BrowserRouter` is instantiated).
- **Change:** Pass `future={{ v7_startTransition: true, v7_relativeSplatPath: true }}`.
- **Validation:** Run the full Playwright suite to catch splat-route regressions, paying particular attention to the legacy `/navigator/:id` redirect.

**Phase H acceptance**
- `tsgo` clean.
- Full Playwright suite green, including 2 new cases (H1, H2).
- Manual smoke: Setup → Dashboard → Setup keeps you on Setup. Signed-out deep link returns you to the deep link post-auth.

---

## Phase I — Deeper UX work

**Objective.** Make project switching and accessibility match the rest of the app's polish. Requires a small design pass for the live-region copy.

### I1 — UX-003 · Smart sub-view carry-over on project switch
- **Files:** `src/components/ClientProjectSwitcher.tsx`, new `src/hooks/useProjectReadiness.ts`.
- **Change:** When the user switches projects from inside a sub-view (e.g. Forecast), probe the target project's readiness before navigating. If the target supports the current view, preserve it; otherwise route to `projectHome(...)`.
- **Hook contract:** `useProjectReadiness(projectId)` returns `{ hasKeywords, hasForecasts, status, loading }`. Uses the same query keys as `useNavigatorProjects` to share cache.
- **E2E:** Switcher matrix — from `/forecast` switch to a project without forecasts → asserts landing is project home, not a broken Forecast view.

### I2 — UX-007 · `goToClient` navigates when deeper than client home
- **File:** `src/components/ClientProjectSwitcher.tsx` (and any caller of the same helper).
- **Behaviour matrix:**
  - Same client, already at client home → no-op.
  - Same client, deeper (`/projects/:id/...`) → navigate to `clientHome(clientId)`.
  - Different client → navigate to `clientHome(clientId)`.
- **E2E:** Three assertions matching the matrix above.

### I3 — UX-008 · Live-region for forecast recompute state
- **File:** `src/components/forecast/ForecastTabHeader.tsx`.
- **Change:** Add a visually-hidden `role="status" aria-live="polite"` region that announces transitions: `idle → "Recomputing forecast"`, `success → "Forecast recomputed"`, `error → "Recompute failed: {message}"`.
- **Design dependency:** Confirm the exact phrasing with you before shipping (one-sentence copy review).

### I4 — Stretch · Remember last sub-view per project
- **File:** `src/components/ClientProjectSwitcher.tsx`.
- **Change:** When entering a project with no explicit `:view` segment, restore the last-visited view from `localStorage["seer-last-view:${projectId}"]`. Default to Overview when absent or unreadable.
- **Guard:** Respects I1 readiness probe — never restores a view the target can't render.

**Phase I acceptance**
- Keyboard-only journey through switcher captured in Playwright.
- SR announcement smoke via `aria-live` polling.
- Switcher behaviour matrix asserted.
- No business-logic touched.

---

## Phase J — Polish & hygiene

**Objective.** Sand down the remaining sharp edges. Low risk, batch-shippable.

### J1 — UX-010 · Scope-chip "Clear" affordance audit
- **Files:** `src/pages/CaptureWindowPage.tsx`, `src/pages/AudienceInsightsPage.tsx`, `src/pages/ContentPlansPage.tsx`.
- **Change:** Confirm every "Clear" uses `setSearchParams({})` (or equivalent) — no `window.location.href = ...`, no full-page navigations.
- **Lint guard:** Document an `rg -n "window\\.location" src/pages` check in the QA notes so reviewers catch regressions.

### J2 — Sub-nav `aria-current` re-verification
- **File:** `src/pages/NavigatorProjectDetailPage.tsx`.
- **Change:** Spot-check the existing `aria-current="page"` wiring against all 7 first-class views and add an explicit Playwright assertion mirroring `e2e/navigation-smoke.spec.ts` test 12.

### J3 — Console hygiene sweep
- **Pages:** `/dashboard`, `/clients`, `/clients/:id`, `/clients/:id/projects/:id`.
- **Change:** Zero React warnings (validateDOMNesting, key warnings, controlled/uncontrolled, etc.). Capture before/after console snapshots in the QA notes.

### J4 — Mobile tap-target sweep (375px)
- **Surfaces:** Sub-nav, header switcher, sidebar trigger, scope chips.
- **Change:** Confirm ≥44px hit area and visible focus ring on each. Use Playwright element screenshots for evidence.

**Phase J acceptance**
- Playwright extended with J2 assertion (`e2e/ux-journey-audit.spec.ts` → "Phase J2 sub-nav aria-current is exclusive and matches active route").
- J3 + J4 sweeps live in `e2e/phase-j-hygiene.spec.ts`, writing evidence to `docs/qa/phase-j-console/*.txt` and `docs/qa/phase-j-mobile/*.png`.
- Manual mobile pass with screenshots attached to the handover.
- No new dependencies.

**Phase J — QA reviewer commands**

```bash
# J1 — scope-chip "Clear" hygiene. Expected: zero hits in scope-chip handlers.
rg -n "window\.location" src/pages

# J1 — confirm scope chips route through React Router's setSearchParams.
rg -n "setSearchParams" src/pages/CaptureWindowPage.tsx \
  src/pages/AudienceInsightsPage.tsx src/pages/ContentPlansPage.tsx

# J2 — aria-current wiring lives on a single source of truth (STEPS map).
rg -n "aria-current" src/pages/NavigatorProjectDetailPage.tsx

# J3 + J4 — run the hygiene spec; artefacts land under docs/qa/phase-j-*.
bunx playwright test e2e/phase-j-hygiene.spec.ts
```

**Phase J — J1 audit result (no code changes required)**

| File | Clear control | Mechanism | Verdict |
|------|---------------|-----------|---------|
| `CaptureWindowPage.tsx` | "Clear client filter" chip (L307–318) | `setSearchParams(next, { replace: true })` after `URLSearchParams` mutation | ✅ React Router state — no full navigation |
| `AudienceInsightsPage.tsx` | "Clear client filter" chip (L37–44) | Shared `clearFilter` → `setSearchParams(next, { replace: true })` | ✅ React Router state |
| `ContentPlansPage.tsx` | Scope badge only (route-derived) | No clear chip; scope comes from `useParams`, not search params | ✅ Out of scope — nothing to clear |

`rg -n "window\.location" src/pages` returns **zero** hits — guard satisfied.


---

## Sequencing

```text
H ──► I ──► (J in parallel with I once H is live)
```

- **H** is independent and ships first.
- **I** depends only on H4 (router future flags) being live.
- **J** can run in parallel with I once H lands.

## Approval gates

| Gate | Trigger phrase | Unlocks |
|------|----------------|---------|
| 1    | "approve H"    | Phase H implementation |
| 2    | "approve I"    | Phase I implementation |
| 3    | "approve J"    | Phase J implementation |

Nothing in H–J ships without an explicit green tick.

## Out of scope (deferred to Phase K backlog)

- KPI selection / configurability on `ProjectOverviewPage`.
- Any visual redesign of the Briefing OS surfaces.
- Edge-function or schema changes.
- RLS / auth-model changes.
- New tools or admin surfaces.
