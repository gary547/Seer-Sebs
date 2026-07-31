# Seer® Client Archive — Handover

Soft-delete + permanent-delete subsystem for clients and projects. Shipped across Phases A–F.

---

## Role matrix

| Role           | Live workspace | `/archive` surface | Archive / restore | Permanent delete |
| -------------- | -------------- | ------------------ | ----------------- | ---------------- |
| `view_only`    | Visible items only | ❌ | ❌ | ❌ |
| `user`         | Visible items only | ❌ | ❌ | ❌ |
| `admin`        | Visible + can navigate to archive | ✅ | ✅ | ✅ |
| `super_admin`  | Visible + can navigate to archive | ✅ | ✅ | ✅ |

Privileges are derived in `src/hooks/useCanArchive.ts`. RLS is the source of truth; UI gating is defence-in-depth.

---

## Database

### Columns added (Phase A)
`clients` and `navigator_projects` each gained:
- `archived_at  timestamptz` (null = live)
- `archived_by  uuid` (no FK cascade)
- `archive_reason text` (optional)

Partial indexes: `clients_archived_at_idx`, `navigator_projects_archived_at_idx` (`WHERE archived_at IS NOT NULL`).

### `public.archive_audit`
Append-only event log.
Columns: `id, entity_type ('client'|'project'), entity_id, client_id, action ('archive'|'restore'|'hard_delete'), actor_id, reason, metadata jsonb, created_at`.
RLS: read = admin/super_admin; insert only via security-definer RPCs / the edge function.

### Visibility helpers (SECURITY DEFINER, STABLE)
- `public.is_visible_client(_client_id uuid)` — true unless the client is archived (admins always true).
- `public.is_visible_project(_project_id uuid)` — true unless project or parent client is archived (admins always true).
- `public.is_visible_keyword(_keyword_id uuid)` — same gate via the keyword's project.

All RLS policies on child tables AND with these helpers, so a single archive write hides every dependent row without touching their policy text.

---

## RPC signatures

All run `SECURITY DEFINER`, raise `permission denied (42501)` for non-admins, and write a row to `archive_audit`.

| Function | Args | Returns | Notes |
| -------- | ---- | ------- | ----- |
| `archive_client(_client_id uuid, _reason text)` | uuid, text | void | Sets `archived_at = now()` on client + cascades same timestamp to its projects. |
| `restore_client(_client_id uuid)` | uuid | void | Clears `archived_at` on the client and any project archived in the same action (matched by timestamp). |
| `archive_project(_project_id uuid, _reason text)` | uuid, text | void | Only the project. Does not touch the parent client. |
| `restore_project(_project_id uuid)` | uuid | void | Refuses if parent client is still archived. |
| `hard_delete_client(_client_id uuid)` | uuid | void | Requires the client to be archived. DB cascades remove dependents. |
| `hard_delete_project(_project_id uuid)` | uuid | void | Requires the project to be archived. |

---

## Edge function: `archive-hard-delete`

`supabase/functions/archive-hard-delete/index.ts`

### Request
```json
{ "entity_type": "client" | "project", "entity_id": "uuid" }
```

### Behaviour
1. Verifies caller JWT and role (`admin` / `super_admin`) — 401/403 otherwise.
2. Resolves row counts for transparency (keywords, forecasts, content_plans, roadmaps, etc.).
3. Cleans up storage:
   - **Client** → `client-logos` bucket, removes the client's `logo_url` object.
   - **Project** → `slide-exports` bucket, removes objects keyed by `project_id/*`.
   - Storage failures are logged but do not roll back DB delete.
4. Invokes the matching `hard_delete_*` RPC.
5. Writes a final `archive_audit` row with `metadata = { storage, counts }`.

### Response
```json
{
  "ok": true,
  "entity_type": "client",
  "entity_id": "...",
  "entity_name": "Acme Co",
  "storage": { "bytes_removed": 12345, "objects_removed": 2, "buckets": ["client-logos"], "errors": [] },
  "counts": { "keywords": 1280, "forecasts": 1280, "content_plans": 4 }
}
```

Front end surfaces this via the success toast (rows + freed bytes).

---

## Hook map

| Hook | File | Purpose |
| ---- | ---- | ------- |
| `useCanArchive()` | `src/hooks/useCanArchive.ts` | Derives `canArchive` / `canHardDelete` from `AuthContext`. |
| `useArchivedClients()` | `src/hooks/useArchive.ts` | Admin-only list of archived clients. |
| `useArchivedProjects()` | `src/hooks/useArchive.ts` | Admin-only list of archived projects (with parent client info). |
| `useArchivedClientsCount()` | `src/hooks/useArchive.ts` | Admin-only `head: true` count for the dashboard stat. |
| `useArchiveClient()` / `useArchiveProject()` | `src/hooks/useArchiveActions.ts` | Archive mutations; toasts use the optional `clientName` / `projectName` arg. |
| `useRestoreClient()` / `useRestoreProject()` | `src/hooks/useArchiveActions.ts` | Restore mutations. |
| `useHardDeleteClient()` / `useHardDeleteProject()` | `src/hooks/useArchiveHardDelete.ts` | Invokes the edge function. Toast summarises rows + storage freed. |

Live-data hooks (`useClients`, `useNavigatorProjects`, `useDashboardData`, `useActiveClient`) explicitly filter `archived_at IS NULL` as a UX shortcut. RLS already enforces it.

---

## Front-end touch points

| Surface | File |
| ------- | ---- |
| Routes | `src/lib/routes.ts` — `archivePath()`, `archiveClient(id)`, `archiveClientProject(cid, pid)`. |
| Protected route gate | `src/components/ProtectedRoute.tsx` — `requireRole={['admin','super_admin']}` for `/archive/*`. |
| Sidebar entry | `src/components/AppSidebar.tsx` — "Archive" item in **Data & admin** (admins only). |
| Command palette | `src/components/CommandPalette.tsx` — "Go to archive" + "Archived clients" group (admins only). |
| Dashboard stat | `src/pages/DashboardPage.tsx` — small banner beneath KPI ribbon when archive is non-empty. |
| Switcher | `src/components/ClientProjectSwitcher.tsx` — archived items grouped & badged for admins; selecting routes to `/archive/...`. |
| Dialogs | `src/components/archive/ArchiveClientDialog.tsx`, `ArchiveProjectDialog.tsx`, `HardDeleteDialog.tsx`. |
| Banner | `src/components/archive/ArchiveBanner.tsx` — pinned on read-only archive surfaces with inline restore. |
| Archive home | `src/pages/admin/ArchivePage.tsx` — tabs (Clients / Projects), row actions for restore + permanent delete. |
| Read-only mirrors | `src/pages/admin/ArchiveClientPage.tsx`, `ArchiveProjectPage.tsx`. |
| Breadcrumbs | `src/components/SeerBreadcrumbs.tsx` — explicit items: `Dashboard › Archive › Clients › {name}`. |

---

## Toast copy contract

| Action | Copy |
| ------ | ---- |
| Archive client | `Archived {name} — moved to /archive` |
| Archive project | `Archived {name} — moved to /archive` |
| Restore client | `Restored {name} — now live again` |
| Restore project | `Restored {name} — now live again` |
| Hard delete | `Permanently deleted {name} · {N} rows · {N} files ({bytes}) freed` |
| Permission denied (any) | `You don't have permission to perform this action.` |

---

## Audit query recipes

Recent hard deletes:
```sql
SELECT created_at, entity_type, entity_id, actor_id, metadata
FROM public.archive_audit
WHERE action = 'hard_delete'
ORDER BY created_at DESC
LIMIT 50;
```

All actions on a single client:
```sql
SELECT created_at, action, actor_id, reason, metadata
FROM public.archive_audit
WHERE client_id = '<uuid>' OR (entity_type='client' AND entity_id='<uuid>')
ORDER BY created_at;
```

Bytes / rows freed in the last 30 days:
```sql
SELECT
  COUNT(*) AS deletions,
  SUM(COALESCE((metadata->'storage'->>'bytes_removed')::bigint, 0)) AS bytes_freed,
  SUM((SELECT COALESCE(SUM(value::bigint),0) FROM jsonb_each_text(metadata->'counts'))) AS rows_freed
FROM public.archive_audit
WHERE action = 'hard_delete'
  AND created_at > now() - interval '30 days';
```

---

## Failure recovery

- **Archive failed** — RPC raises; toast shows the message. No data mutated. Retry safe.
- **Restore failed** — same. Restoring a project whose parent is still archived is rejected by `restore_project`; restore the client first.
- **Hard delete** — irreversible. If the storage cleanup step logs `errors`, the database rows are already gone; orphaned files can be removed manually via the Supabase Storage UI using the bucket + path in the audit `metadata.storage`.
- **Edge function 401/403** — caller session expired or role downgraded; sign in again as an admin.

---

## Out of scope (deferred)

- No scheduled auto-purge of archived rows.
- No bulk-archive UI; archive is per-entity.
- No email/notification side-effects on archive or delete.
- No cross-tenant export of the audit log; query via SQL.

---

## Phase G — Tests & verification

### End-to-end coverage
- `e2e/archive-flow.spec.ts` — full admin lifecycle (archive → read-only → restore → hard delete) plus a cross-context invisibility test that confirms a `user`-role session cannot see the archived client anywhere or reach `/archive`.
- `e2e/navigation-smoke.spec.ts` — extended with tests 17 + 18: the Archive sidebar item and "Go to archive" palette action must be present for `admin`/`super_admin` and absent for `view_only`.

### Running
```bash
# All e2e specs (requires E2E_BASE_URL + auth env vars):
bunx playwright test

# Archive flow only:
bunx playwright test e2e/archive-flow.spec.ts
```

Required env for the archive spec:
- `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`
- `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` (non-admin role)
- `E2E_ARCHIVE_FIXTURE_CLIENT`, `E2E_ARCHIVE_FIXTURE_PROJECT`, `E2E_ARCHIVE_FIXTURE_NAME` — a throwaway client/project the admin owns.
- `E2E_ARCHIVE_ALLOW_HARD_DELETE=1` — opt-in for the destructive hard-delete leg (test 5). Defaults to skipped so CI does not chew through fixture data.

Tests fall back to `test.skip` when env is missing, so the suite is safe to land before CI secrets are wired.

### Static checks
- `tsgo` — clean.
- `supabase--linter` — re-run at sign-off; no new findings vs. Phase A baseline.
- `bunx vitest run` — no regressions in the frontend unit suite.

### Mobile verification (375 × 812)
Spot-checked via Playwright at iPhone-class viewport:
- `/archive` — tabs collapse cleanly; row actions reachable via the kebab menu (≥ 44 px tap target).
- `ArchiveClientPage` header — banner readable, Restore + Permanently delete buttons stack with adequate spacing.
- `HardDeleteDialog` — input + confirm button fully visible; keyboard does not occlude the confirm CTA.

No regressions; no follow-up patch required.

### Known limitations
- The hard-delete leg consumes the fixture; re-seed before the next run or leave `E2E_ARCHIVE_ALLOW_HARD_DELETE` unset.
- The invisibility test opens two browser contexts in one Playwright worker; running it in parallel with other archive tests against the same fixture will race. Use `--workers=1` when running the file in isolation.
