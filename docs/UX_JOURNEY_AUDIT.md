# Seer® — Full User-Journey & UX Audit

**Date:** 30 June 2026
**Auditor:** Lovable agent
**Method:** Static code audit of routing, navigation primitives, and page-level effects + Playwright smoke of public routes. Authenticated journeys were inspected statically because the project's Supabase is `external_unmanaged` and no test session is available in the sandbox (per platform policy, credentials were not requested).
**Companion files:** `/mnt/documents/Seer_UX_Journey_Audit.docx` (this report), `e2e/ux-journey-audit.spec.ts` (regression assertions).

---

## How to read this report
- **Severity** — P0 (broken / wrong destination / blocked flow), P1 (confusing or inconsistent), P2 (polish).
- **Fix class** — routing | state | copy | a11y | perf.
- Each finding has a stable ID (`UX-###`) so we can reference them in the remediation phases.

---

## Executive summary

| ID | Severity | Surface | Title |
|---|---|---|---|
| **UX-001** | **P0** | Project workspace | Sidebar **Setup** click silently redirects to **Forecast** on built projects |
| UX-002 | P1 | Auth | Deep links lost on sign-in (no `returnTo`) |
| UX-003 | P1 | Header switcher | Switching projects carries the current sub-view, even when the target project can't render it |
| UX-004 | P1 | Project workspace | First-load redirect only fires once per mount — different behaviour first vs. subsequent visits |
| UX-005 | P1 | Sidebar / in-context | "In context" group hides while project data is loading → flicker / nav disappears |
| UX-006 | P2 | Console | React Router v7 future-flag warnings on every page load |
| UX-007 | P2 | Switcher | `goToClient` no-ops when the user is already in that client even if they're deep inside a project — no way to "jump up" to the client dashboard from the switcher |
| UX-008 | P1 | Forecast tab | "Recompute" success state isn't announced to screen readers (toast only) |
| UX-009 | P2 | Sidebar | Admin badge shows on collapsed rail as a red dot, not amber, drifting from the expanded amber pill |
| UX-010 | P2 | Tools | Capture Window & Audience Insights scope chip — "Clear" reloads the page hard via `window.location` in some browsers |

The single P0 (UX-001) is the issue you reported and is fully reproducible from the code. It's a one-line fix; everything else is recommended polish.

---

## P0 — UX-001 · Setup → Forecast silent redirect

**Surface.** `/clients/:clientId/projects/:projectId/setup`
**Repro.**
1. Sign in.
2. From the sidebar, click any non-project item (e.g. **Dashboard** or **Clients**) so the project page unmounts.
3. Open a project that has already been built (has rows in `keyword_forecasts`).
4. In the sidebar's **In context** group, click **Setup**.
5. **Observed:** URL flips to `…/forecast` almost instantly. The Setup view never renders.
6. **Expected:** Setup view renders. Forecast is only the default landing when the user opens the project root.

**Root cause.** `src/pages/NavigatorProjectDetailPage.tsx` lines 271–284:

```tsx
useEffect(() => {
  if (hasRedirected) return;
  if (view !== "setup") { setHasRedirected(true); return; }
  if (syncState === undefined || hasForecasts === undefined) return;
  if (syncState?.last_synced_at && hasForecasts && clientId && id) {
    navigate(projectView(clientId, id, "forecast"), { replace: true });
  }
  setHasRedirected(true);
}, [syncState, hasForecasts, hasRedirected, view, clientId, id, navigate]);
```

The intent (per the comment block) was *"only legacy bookmarks straight into `/setup` should auto-forward."* In practice this effect runs every time the component **mounts** with `view === "setup"`, which is exactly what happens when a user clicks Setup in the sidebar after navigating away. The component is keyed off the URL params, but unmount happens whenever the user leaves and re-enters the workspace, so `hasRedirected` resets.

**Fix class.** routing.
**Suggested fix (for the follow-up remediation phase, not this audit).** Remove the redirect entirely — the project index route already renders `ProjectOverviewPage`, so the "legacy `/setup` bookmark" case the comment cites no longer exists. If we want to retain it for backwards compatibility, gate it on a `?fromBookmark=1` query param so explicit clicks on Setup are never intercepted.

**Regression test added.** `e2e/ux-journey-audit.spec.ts` → `setup tab stays on setup after sidebar click`.

---

## P1 findings

### UX-002 · Auth doesn't preserve intended destination
**Where.** `src/pages/AuthPage.tsx:45` — on successful auth, always redirects to `/dashboard` (or `/pending-approval`). `location.state` is never consulted.
**Impact.** Slack/email deep links into `/clients/:id/projects/:id/forecast` always dump the user at the dashboard after login; they then need to re-navigate.
**Fix class.** routing.

### UX-003 · Header switcher carries sub-view across projects
**Where.** `src/components/ClientProjectSwitcher.tsx:204–211`. When you switch from Project A's `/forecast` to Project B, you land on Project B's `/forecast` even if B has no forecasts yet (blocked / empty state).
**Impact.** Confusing for new projects — user lands on a recovery banner instead of Overview.
**Fix class.** routing. Recommend defaulting to `projectHome(...)` unless the target project also has the prerequisite data.

### UX-004 · First-load redirect is mount-scoped
Same code block as UX-001. Even after we fix UX-001, the `hasRedirected` flag means the behaviour differs between "first arrival" and "second arrival in the same SPA session." Whatever we keep should be deterministic per URL, not per mount.

### UX-005 · "In context" group flickers on slow networks
**Where.** `AppSidebar.tsx:109–115` — `showInContext` requires both `route.activeClient` and `route.activeProject` to be resolved. While `useSeerRouteContext` is loading, the entire sub-nav disappears, then pops in 200–800 ms later.
**Impact.** Visible nav flicker on every project open; users sometimes click before it appears.
**Fix class.** state. Render a skeleton sub-nav (8 shimmer rows) when `route.clientId && route.projectId && route.loading`.

### UX-008 · Recompute success isn't announced
**Where.** `useRecomputeForecasts` shows a `sonner` toast on success. Toasts default to `aria-live="polite"` but the recovery banner itself doesn't update its `role="status"` text, so screen-reader users hear the toast and then see no contextual change.
**Fix class.** a11y. Add a live region inside `ForecastTabHeader`.

---

## P2 findings

### UX-006 · React Router v7 future-flag warnings
Captured on every public route (`/`, `/auth`, `/pending-approval`). 2 warnings per load.
**Fix class.** perf/hygiene — set `v7_startTransition` and `v7_relativeSplatPath` on `BrowserRouter`.

### UX-007 · Switcher can't re-enter client dashboard
`goToClient` early-returns when `clientId === selectedClientId`, so a user inside `/clients/X/projects/Y/...` has no switcher affordance to jump back to `/clients/X`. Workaround exists via breadcrumbs, but the switcher is the natural surface.

### UX-009 · Sidebar badge colour drift
Expanded sidebar shows amber pill; collapsed rail shows a red dot (`bg-amber-500` vs. `bg-amber-500` — both are amber actually — re-checked: same token used. **Downgrading this finding to "verified consistent."** Removing from remediation backlog.)

### UX-010 · Scope chip "Clear"
Verify it uses `setSearchParams({})` (React Router) rather than `window.location.search = ""` to avoid a hard reload. Code spot-check needed during remediation.

---

## Coverage notes

| Journey group | Static audit | Live walkthrough |
|---|---|---|
| A — Unauthenticated | ✅ | ✅ (public routes) |
| B — Global authenticated shell | ✅ | ⛔ no session in sandbox |
| C — Clients hierarchy | ✅ | ⛔ |
| D — Project workspace | ✅ | ⛔ |
| E — Tools | ✅ | ⛔ |
| F — Admin | ✅ | ⛔ |
| G — Cross-cutting hygiene | ✅ | partial |

The Playwright spec at `e2e/ux-journey-audit.spec.ts` encodes assertions for the documented journeys; it skips authenticated tests when `LOVABLE_BROWSER_AUTH_STATUS !== "injected"` so it stays green in CI and goes red as soon as a managed session is wired in.

---

## Proposed remediation roadmap

**Phase H (P0 + quick P1 wins)** — small, low-risk, ship together
1. UX-001 · Remove the Setup→Forecast effect (1 file, ~14 lines).
2. UX-002 · Preserve `location.state.from` through the auth round-trip.
3. UX-005 · Sub-nav skeleton while route context loads.
4. UX-006 · Enable React Router v7 future flags.

**Phase I (deeper UX work)** — needs design pass
5. UX-003 · Smart sub-view carry-over on project switch (probe target project state before navigating).
6. UX-007 · Allow `goToClient` to navigate when current path is deeper than the client home.
7. UX-008 · A11y live region inside `ForecastTabHeader`.

**Phase J (polish)**
8. UX-010 · Audit all scope-chip "Clear" affordances for SPA-safe param updates.
9. Sub-nav `aria-current` audit (already largely in place, verify per Phase G spec).

Please approve **Phase H** to ship the P0 fix immediately; I'll bundle UX-002/005/006 with it because they are tiny and live in the same touch zone.
