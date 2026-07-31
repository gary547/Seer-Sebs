# Seer® Archive & Deletion — Phased Plan

Goal: let admin / super_admin users "delete" a client from the portfolio without losing data. Deleted clients (and all their projects) move to an **Archive** that only admin / super_admin can view. From there, the same roles can **restore** or **permanently delete** (cascading all data) behind a confirmation modal. Regular `user` / `view_only` accounts must stop seeing archived clients and projects everywhere in the app.

---

## Guardrails (apply to every phase)

- No visual redesign. New UI uses existing primitives (`AlertDialog`, `DropdownMenu`, `Card`, `empty-state`, sidebar group, `SeerBreadcrumbs`).
- No business-logic changes outside archive scope. Forecast / HAR / URL Monitor pipelines untouched.
- RLS is the source of truth — every archived-row gate enforced in the DB, then mirrored in hooks/queries for UX.
- `service_role` retains full access for edge functions and cron.
- Keep `tsgo` clean. Extend Playwright (`e2e/`) rather than replacing.
- No new dependencies.
- Hard-delete is irreversible and runs server-side via an edge function (atomic, audited).

---

## Phase A — Schema, RLS, audit (foundation)

**Migration (single file):**

1. Add nullable columns to `clients` and `navigator_projects`:
   - `archived_at timestamptz`
   - `archived_by uuid` (references `auth.users.id`, no FK cascade)
   - `archive_reason text` (optional, free-text from modal)
2. Add `clients_archived_at_idx`, `navigator_projects_archived_at_idx` partial indexes (`WHERE archived_at IS NOT NULL`).
3. New table `public.archive_audit` (event log):
   - `entity_type` ('client' | 'project'), `entity_id uuid`, `client_id uuid`, `action` ('archive' | 'restore' | 'hard_delete'), `actor_id uuid`, `reason text`, `metadata jsonb`, timestamps.
   - GRANTs: `SELECT, INSERT` to `authenticated`, `ALL` to `service_role`. RLS: read = `has_role(admin)` or `has_role(super_admin)`; insert via security-definer RPC only.
4. **RLS rewrites** (preserve existing predicates, AND with archive gate):
   - `clients` SELECT: existing predicate AND (`archived_at IS NULL` OR caller has admin/super_admin role).
   - `navigator_projects` SELECT: same gate, plus block when parent client is archived for non-admins.
   - All child tables that key off `client_id` / `project_id` (keywords, forecasts, har_*, serp_*, content_plans, monitor_*, url_*, site_architecture, gsc_*, etc.) get an additional `EXISTS` clause that filters out archived parents for non-admins. Done via helper `is_visible_client(_client_id uuid)` / `is_visible_project(_project_id uuid)` SECURITY DEFINER STABLE functions to avoid duplicated subqueries and keep policy diffs small.
   - Admin / super_admin policies remain unchanged (they already bypass via `has_role`).
5. RPCs (SECURITY DEFINER, role-gated, write `archive_audit`):
   - `archive_client(_client_id uuid, _reason text)` — sets `archived_at` on client and cascades to its projects.
   - `restore_client(_client_id uuid)` — clears `archived_at` on client + projects (restore all that share the same archive timestamp).
   - `archive_project(_project_id uuid, _reason text)` / `restore_project(_project_id uuid)`.
   - `hard_delete_client(_client_id uuid)` / `hard_delete_project(_project_id uuid)` — require the row to currently be archived; perform `DELETE` (cascades already exist for most child tables; verify and add `ON DELETE CASCADE` where missing in the same migration).
   - All RPCs raise unless `has_role(auth.uid(),'admin')` or `has_role(auth.uid(),'super_admin')`.

**Verification:** `supabase--linter`, smoke query as `user` confirms archived rows disappear; as `admin` they remain.

---

## Phase B — Hooks, routes, shared utilities

- `src/lib/routes.ts`: add `archive()` → `/archive`, `archiveClient(id)` → `/archive/clients/:id`, `archiveClientProject(cid, pid)` → `/archive/clients/:cid/projects/:pid`.
- `src/hooks/useArchive.ts`: queries for archived clients + projects (admin-only; throws nicely for non-admins).
- `src/hooks/useArchiveActions.ts`: mutations wrapping the four RPCs with toasts + cache invalidation (`clients`, `navigator_projects`, `useDashboardData`, `useProjectReadiness`).
- `src/hooks/useCanArchive.ts`: derives `canArchive` / `canHardDelete` from `AuthContext` role (admin / super_admin only).
- Update `useClients`, `useNavigatorProjects`, `useDashboardData`, `useActiveClient` to exclude archived rows for non-admins (defence-in-depth — RLS already does this).
- `useSeerRouteContext`: detect `/archive/...` and expose `isArchiveScope: true` so downstream UI can render read-only banners.

No UI changes yet.

---

## Phase C — Portfolio + project entry points (delete affordance)

- `src/pages/ClientsPage.tsx`: add **Archive client** item to the existing `DropdownMenu` (only when `canArchive`). Opens `<ArchiveClientDialog>` (new `src/components/archive/ArchiveClientDialog.tsx`) built on `AlertDialog` — explains the cascade, optional reason textarea, confirm button. On success: toast + invalidate `clients`. Card disappears from the portfolio.
- `src/pages/NavigatorProjectDetailPage.tsx` (project header overflow menu, mirror existing pattern): add **Archive project** under the same gate; same dialog (project flavour).
- `ClientDashboardPage.tsx`: add the same option in the client-header action menu so admins can archive while inside the workspace; on success redirect to `/clients`.
- `ClientProjectSwitcher.tsx`: hide archived clients / projects for non-admins (already covered by data layer); admins see them with an "Archived" badge but selecting routes to the archive view, never the live workspace.

Visuals: no new tokens. The dialog uses `destructive` button variant already in the system.

---

## Phase D — Archive surface (admin-only)

- Sidebar (`AppSidebar.tsx`): under **Data & admin**, add **Archive** link with `Archive` lucide icon; render only when `canArchive`. Use existing group styles.
- New page `src/pages/admin/ArchivePage.tsx` at `/archive`:
   - Tabs: **Clients** | **Projects** (shadcn `Tabs`).
   - Clients tab: reuses the card grid from `ClientsPage` (extract a small `<ClientCard archived>` variant or pass an `archived` prop) showing archived clients with an "Archived {relative date} by {actor}" footer. Card opens `/archive/clients/:id`.
   - Projects tab: table of archived projects with client column, archived date, archived by, "Open" + actions.
   - Row actions (per card/row): **Restore**, **Permanently delete** (each behind an `AlertDialog`).
   - Empty state via `empty-state.tsx`.
- `/archive/clients/:id` — read-only mirror of `ClientDashboardPage` (banner "This client is archived — read-only"). Project lists link into `/archive/clients/:cid/projects/:pid`.
- `/archive/clients/:cid/projects/:pid` — read-only mirror of `ProjectWorkspaceLayout` (same tabs, all mutations disabled via `isArchiveScope`). Recompute / refresh buttons hidden; explanatory banner pinned.
- `ProtectedRoute`: extend with `requireRole={['admin','super_admin']}` for `/archive/*`.

---

## Phase E — Hard delete edge function

- `supabase/functions/archive-hard-delete/index.ts`:
   - Verifies caller is admin / super_admin (via `getClaims` + `get_user_role`).
   - Accepts `{ entity_type, entity_id }`; calls the matching RPC inside a transaction.
   - Cleans up Storage artefacts where applicable (e.g. `client-logos` for the client's `logo_url`, `slide-exports` keyed by project id) — list, then `remove()`.
   - Writes a final `archive_audit` row with byte / row counts in `metadata`.
   - Returns 200 with deletion summary; surface in the confirmation toast.
- Front-end `HardDeleteDialog` requires the admin to type the client / project name to confirm (defence against fat-finger).

---

## Phase F — UX polish & cross-cutting

- Read-only banner component `src/components/archive/ArchiveBanner.tsx` reused across archive pages.
- Breadcrumbs: `SeerBreadcrumbs` learns the `archive` segment ("Archive › Clients › {name}").
- Command palette (`CommandPalette.tsx`): admins get a "Go to archive" action + per-archived-client jump (reuses existing item renderer).
- Dashboard counts (`useDashboardData`) explicitly filter archived for everyone; admin dashboard gains a small "Archived clients: N" stat linking to `/archive`.
- Toaster copy reviewed for clarity (archive / restore / permanent delete).
- `docs/CLIENT_ARCHIVE_HANDOVER.md` written at sign-off (final wiring notes, RPC signatures, audit query recipes).

---

## Phase G — Tests & verification

- Playwright `e2e/archive-flow.spec.ts`:
   1. Admin archives a client → disappears from `/clients`, appears in `/archive`.
   2. Non-admin session cannot see `/archive` (redirect) and cannot see the archived client / projects anywhere.
   3. Admin opens `/archive/clients/:id/projects/:pid` and confirms all mutation controls are absent.
   4. Admin restores → client returns to `/clients`, projects re-appear.
   5. Admin hard-deletes (typed confirmation) → row absent everywhere; `archive_audit` row present (assert via authed Supabase call).
- Extend `navigation-smoke` to confirm archive nav-item visibility matches role.
- `tsgo` clean, `supabase--linter` clean, manual mobile pass on `/archive` (375px).

---

## Acceptance

- Admin / super_admin can archive a client or project from the existing menus.
- Archived items vanish for `user` / `view_only` everywhere (portfolio, switcher, dashboard, command palette, project routes, child-table queries).
- Admins have a dedicated `/archive` surface with read-only access to all original views.
- Restore and permanent-delete are reachable only from `/archive`, both gated by confirmation modals.
- All actions logged in `archive_audit`.
- No regressions in Playwright suites; no new deps; no visual redesign.

---

## Technical notes

- Cascade strategy: prefer existing `ON DELETE CASCADE`; add missing ones in the Phase A migration after auditing FK definitions via `supabase--read_query` against `pg_constraint`.
- Helper RLS functions (`is_visible_client`, `is_visible_project`) keep policy diffs minimal and avoid recursive policy issues (mirrors the established `has_role` pattern).
- Storage cleanup runs only inside the edge function to avoid client-side service-role exposure.
- `archive_reason` is optional; UI captures it but won't block confirmation if empty.
- Archived state is binary; no scheduled auto-purge in this scope (can be a later phase if needed).
