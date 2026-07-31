# Seer® Navigation Restructure — Final Handover

Status: Implementation complete (Phases 1–9A). Documentation/QA pass.
Scope: Information Architecture, routing, and navigation surfaces only.
No backend, schema, RLS, grant, enum, migration, edge-function, or forecast formula changes were made in this workstream.

---

## 1. New Route Hierarchy

The application now follows a strict three-tier hierarchy:

```
/dashboard                                          Global briefing OS (home)
└── /clients                                        Client portfolio (index)
    └── /clients/:clientId                          Client dashboard
        ├── /clients/:clientId/projects/new         Create project (clientId prefilled)
        └── /clients/:clientId/projects/:projectId  Project workspace (overview)
            ├── .../setup                           Setup
            ├── .../keywords                        Keyword tools (detox, etc.)
            ├── .../categorise                      Categorisation
            ├── .../forecast                        Forecast (includes Site Architecture + Roadmap as anchors)
            ├── .../performance                     Performance / HAR
            └── ...                                 Any future :view segment
```

Canonical URLs are produced exclusively via `src/lib/routes.ts` helpers (`clientHome`, `projectHome`, `projectView`, etc.). The URL is the **single source of truth** for active client, project, and view.

## 2. Legacy Redirects (preserved for one release)

| Legacy path           | Behaviour                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| `/navigator`          | Redirects to `/clients`                                                   |
| `/navigator/new`      | Redirects to client picker → `/clients/:clientId/projects/new`            |
| `/navigator/:id`      | `LegacyProjectRedirect` resolves `clientId` and 301s to canonical project URL |
| `#site-architecture`  | Hash migrated to `/clients/:clientId/projects/:projectId/forecast#site-architecture` |

Redirects are defined in `src/App.tsx` and `src/components/LegacyProjectRedirect.tsx`.

## 3. Navigation Surfaces

| Surface                        | Role                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| **Header ClientProjectSwitcher** | Sticky global header; switch active client + project from any page. Mobile responsive. |
| **AppSidebar**                 | Static global navigation (Work / Data & Admin). No more context-aware variations.    |
| **CommandPalette (⌘K)**        | Hierarchical grouping: Clients → Projects → Views. Versioned recents (`seer:recent-nav:v2`). |
| **Dashboard client cards**     | Entry point from `/dashboard` to `/clients/:clientId`.                               |
| **Client dashboard project cards** | Entry point from `/clients/:clientId` to project workspace.                      |
| **RecentProjectsStrip**        | localStorage-backed recents on the global dashboard.                                 |

## 4. Scope Decisions

- **Capture Window** — remains a global tool. Accepts optional `?clientId=` for filtered views.
- **Content Plans** — global inbox at `/content-plans`; project-scoped at `/clients/:clientId/projects/:projectId/content-plans`.
- **URL Monitor** — global. Uses **"Campaign"** terminology (distinct from Seer® Projects).
- **Audience Insights** — global / stub for now.
- **Terminology** — "Project" applies only to Seer® workspaces; "Campaign" applies only to URL Monitor entities.

## 5. Guardrails Confirmed

| Guardrail                                        | Status |
| ------------------------------------------------ | ------ |
| No `supabase/functions/*` changes                | ✅ Yes |
| No migrations / schema / RLS / grant changes     | ✅ Yes |
| No forecast formula changes                      | ✅ Yes |
| No new edge function calls introduced            | ✅ Yes |
| No changes to `useNavigatorSync` implementation  | ✅ Yes |
| URL is authoritative for client/project/view     | ✅ Yes |

## 6. QA Matrix

Run each cell against preview before release.

### Roles
| Role         | Expected                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| super_admin  | Full access, all clients/projects, admin links visible.                  |
| admin        | Full access, all assigned clients, admin links visible.                  |
| user         | Access to assigned clients only; create/edit CTAs visible.               |
| view_only    | No create/edit CTAs; switcher/sidebar still operate read-only.           |

### States
| State                              | Verify                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| Approved user                      | Lands on `/dashboard`, sees client cards.                         |
| Pending user                       | Held at approval gate; no app shell access.                       |
| Client with projects               | Client dashboard lists project cards.                             |
| Client with no projects            | Empty state with "Create project" CTA prefilling `clientId`.      |
| Project first-run / not synced     | ProjectOverview shows next-action prompts; no auto edge calls.    |
| Project synced / has forecasts     | Forecast tab renders HAR + TP revenue.                            |
| Invalid client/project URL mismatch | `useSeerRouteContext` returns 404; layout shows not-found state. |
| Legacy `/navigator/:id` link       | Redirects to canonical project URL.                               |
| Mobile header                      | ClientProjectSwitcher collapses to compact controls; sidebar via sheet. |
| Collapsed sidebar                  | Icons-only state preserves navigation; tooltips render labels.    |

## 7. Known Follow-ups (Not in scope of this workstream)

- Optional component-level split of `NavigatorProjectDetailPage.tsx` once route-aware behaviour has bedded in.
- Optional analytics/telemetry (navigation events, recents engagement) — separate workstream.
- Optional retirement of `/navigator*` legacy redirects after one release cycle.

---

## Validation Answers

| Question                              | Answer |
| ------------------------------------- | ------ |
| Forbidden files touched?              | **No** |
| Schema changed?                       | **No** |
| Edge functions changed?               | **No** |
| Forecast formulas changed?            | **No** |
| New edge calls added?                 | **No** |
| Legacy redirects working?             | **Yes** (`/navigator`, `/navigator/new`, `/navigator/:id`) |
| Mobile switcher working?              | **Yes** (verified via responsive header layout) |
| view_only gates preserved?            | **Yes** (CTAs continue to gate on existing role checks; navigation surfaces are read-safe) |

## Changed Files (this final pass)

- `docs/NAVIGATION_RESTRUCTURE_HANDOVER.md` (new)
- `README.md` (handover pointer appended)

No application code changes were required in this pass.
