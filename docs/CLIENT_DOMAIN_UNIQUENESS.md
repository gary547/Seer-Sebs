# Client Domain Uniqueness — Phase 2A shipped, Phase 2B blueprint

Status: **Phase 2A live** (single-column uniqueness). **Phase 2B is documentation only** — this file is the starting point for the future multi-domain iteration.

---

## 1. Current state (Phase 2A recap)

Single source of truth for a client's canonical domain lives on the `clients` table.

**SQL helper — `public.normalize_domain(text)`** (`IMMUTABLE`, `SET search_path = public`):
- lowercase + trim
- strip leading `http://` / `https://`
- strip leading `www.`
- strip everything from the first `/`, `?`, or `#`
- collapse interior whitespace
- return `NULL` for empty / null input

**Schema:**
```
clients.domain              text          -- raw user input, kept for display
clients.domain_normalized   text          GENERATED ALWAYS AS (normalize_domain(domain)) STORED

UNIQUE INDEX clients_domain_normalized_active_uidx
  ON public.clients (domain_normalized)
  WHERE archived_at IS NULL AND domain_normalized IS NOT NULL;
```

**TypeScript mirror — `src/lib/domain.ts`** — byte-for-byte equivalent of the SQL helper. Parity is covered by `src/test/domain.test.ts`. If either side changes, both must change and the vitest suite must be updated.

**Frontend guardrails (`src/pages/ClientOnboardingPage.tsx`):**
- On-blur helper text: "Will be saved as `<canonical>`" when the raw input differs from the canonical form.
- Pre-submit query against `clients.domain_normalized` (excluding the current client id in edit mode) — blocks submit with an inline error and an "Open workspace →" link routed via `src/lib/routes.ts`.
- `23505` catch on insert/update — same friendly message if the pre-flight lost a race or the row was invisible under RLS.

**Restore guardrail (Phase 2B addition, live):** `restore_client(_client_id)` runs a pre-flight against `clients.domain_normalized` for other unarchived rows and raises `23505` with the message `Cannot restore — domain % is now used by another live client (%)`. The client-side `useRestoreClient` mutation formats this into: "Cannot restore — this client's domain is already used by another live client. Archive or rename the other client first."

**Guardrails still holding:**
- RLS and grants unchanged; the generated column and unique index inherit `clients` policies.
- Archive frees the domain (partial index scoped to `archived_at IS NULL`), so a domain can be reused after archive and rejected on restore.
- Every consumer of `clients.domain` keeps reading the raw string; new uniqueness logic keys off `domain_normalized`.
- Edit flow excludes the current client id in the pre-flight — no self-collision false positives.

---

## 2. Target model (proposed, not built)

When the product needs "one client, many domains" (multi-brand rollouts, acquired subsidiaries, international variants), split domains into a dedicated table.

```
client_domains
  id                uuid pk default gen_random_uuid()
  client_id         uuid not null references public.clients(id) on delete cascade
  domain_raw        text not null                    -- user-entered form, for display
  domain_normalized text generated always as (normalize_domain(domain_raw)) stored
  is_primary        boolean not null default false
  verified          boolean not null default false
  verified_at       timestamptz
  archived_at       timestamptz                      -- mirrors clients archive semantics
  created_at        timestamptz not null default now()
  updated_at        timestamptz not null default now()

-- global uniqueness on live domains, mirrors current partial index
CREATE UNIQUE INDEX client_domains_normalized_active_uidx
  ON public.client_domains (domain_normalized)
  WHERE archived_at IS NULL AND domain_normalized IS NOT NULL;

-- exactly one primary per live client
CREATE UNIQUE INDEX client_domains_one_primary_uidx
  ON public.client_domains (client_id)
  WHERE is_primary AND archived_at IS NULL;
```

**Rationale**
- Normalisation logic stays identical (same `normalize_domain` helper backing a generated column).
- Uniqueness moves off `clients`; the single-column partial index is retired.
- `is_primary` guarantees a single canonical domain per live client for consumers (HAR, forecast, display).
- Archive semantics mirror the parent — cascade on client archive, individual domain archive supported for domain retirements.

---

## 3. Migration path (future, phased)

Every step reversible. Each phase behind an `ff_multi_domain` feature flag until M3 lands.

**M1 — Add table (additive).**
- Create `public.client_domains` with the schema above.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_domains TO authenticated; GRANT ALL ON public.client_domains TO service_role;`
- `ENABLE ROW LEVEL SECURITY`. Policies mirror `clients`: visibility via `public.is_visible_client(client_id)`, mutations gated on admin/super_admin.
- No data written yet.

**M2 — Backfill primary rows.**
- Inside a `DO $$` block:
  1. Pre-flight: refuse to run if `select domain_normalized, count(*) from clients where archived_at is null group by 1 having count(*) > 1` returns any row (same guard Phase 2A used for PillTime). Aborts cleanly with the offending list.
  2. `INSERT INTO client_domains (client_id, domain_raw, is_primary) SELECT id, domain, true FROM clients WHERE domain IS NOT NULL;`
  3. Copy `clients.archived_at` into `client_domains.archived_at` for archived clients to keep the partial index consistent.
- Assert parity: every non-null `clients.domain_normalized` has a matching `client_domains.domain_normalized` with `is_primary = true`.

**M3 — Swap the source of truth.**
- Option A (preferred): drop `clients.domain_normalized` generated column; create view `clients_with_primary_domain` joining to the primary `client_domains` row. Update consumers to select from the view.
- Option B: keep `clients.domain_normalized` as a trigger-maintained cache of the primary row for read-heavy paths.
- Drop `clients_domain_normalized_active_uidx` **only after** M2 parity verified and M3 shipped to all readers.
- Feature flag `ff_multi_domain` gates the view swap for one release for rollback safety.

**M4 — App code.**
- New hook `useClientDomains(clientId)` — list, add, remove, mark-primary, request-verify.
- `ClientOnboardingPage` primary-domain field becomes a managed list (primary always required).
- Pre-flight query rewires from `clients.domain_normalized` to `client_domains.domain_normalized`.
- `useRestoreClient` guard message updated to reference the specific colliding domain row.

**M5 — Consumer audit.**
Known readers of `clients.domain` today (all non-critical, key off `client_id`):
- `src/components/WorkspaceSwitcher.tsx` — display only.
- `src/pages/ClientsPage.tsx` — display + search.
- `src/components/archive/ArchiveClientDialog.tsx` — display.
- Edge functions: HAR, forecast, content-plan, roadmap — all take `client_id` / `project_id`, not domain. **No edge-function change required for the split.**
- SERP/Ahrefs pulls — currently per-project; per-domain routing captured as open question below.

**Rollback**
- M1/M2 additive — drop the table.
- M3 kept behind `ff_multi_domain` for one release — toggle off to fall back to the column.
- M4/M5 gated on the same flag.

---

## 4. Non-goals for Phase 2B

- Domain verification workflow (DNS TXT / HTTP token). Captured as open question.
- Per-domain analytics split (GSC upload, ranking history, HAR).
- Bulk domain import UI.
- Migration of `clients.domain` display column — stays for UX continuity until M5.

---

## 5. Open questions (parked for the multi-domain ticket)

1. When a client has multiple live domains, which one drives HAR pulls? Options: primary only, all with a per-domain job, user-selected at pipeline kick-off.
2. Do `serp_rankings` / `serp_results` need a `domain_id` foreign key, or does per-project scoping remain sufficient?
3. Does Ahrefs (`har_ahrefs_queue`) pull per-domain or per-client-root? Affects credit consumption.
4. Should the GSC CSV upload flow prompt for the target domain when multiple exist?
5. Verification: DNS TXT record vs HTTPS meta tag vs GSC-linked property — which fits the No Brainer ops model best?

---

## 6. References

- Phase 2A plan: `.lovable/plan.md`
- Restore guardrail: `public.restore_client()` (see Supabase Functions list).
- Normalisation helpers: `src/lib/domain.ts`, `public.normalize_domain(text)`.
- Vitest parity: `src/test/domain.test.ts`.
- E2E coverage: `e2e/client-domain-uniqueness.spec.ts` (four canonical cases + restore guard).
