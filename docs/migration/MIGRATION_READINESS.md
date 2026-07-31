# Migration Readiness

Status: the application is locally ready for source discovery, target provisioning and a controlled staging migration. It is not ready for production cutover because no real source export or managed Google Cloud environment has been supplied yet.

## Complete locally

- The frontend, API, workers and deployable artifacts have no Supabase runtime dependency, SDK, endpoint, credential or fallback path.
- Authentication, profiles, approvals, roles and client access use Identity Platform-compatible contracts.
- Client, project, keyword, GSC, forecast, SERP, roadmap, archive, URL Monitor, reference-data, conversion-override, dashboard, capture-window, Content Planner and Slides flows use authenticated target APIs.
- All 19 pipeline stages run outside the browser with durable state, retries, idempotency, terminal failure handling and restart recovery.
- Live adapters exist for DataForSEO keyword/SERP data, Ahrefs authority/backlink metrics and Anthropic site-architecture scoring.
- Long-running provider tasks are persisted and can resume after worker retries or browser closure.
- Google Slides export uses direct Drive/Slides APIs, Workspace OAuth and a short-lived signed Cloud Storage image URL.
- The target PostgreSQL schema contains 25 versioned migrations and initializes successfully from an empty database.
- All 58 known source tables have an explicit runtime disposition and a keyed, lossless JSON archive path in a private Cloud SQL schema.
- Twenty-six operational source tables have an ordered canonical copy or transformation rule. Legacy calculation outputs are retained in the lossless archive and recomputed through the target pipeline instead of being inserted into incompatible target contracts.
- Read-only source and target inventory, restricted dumps, identity/storage manifests, fail-closed canonical-plan generation, resumable database transfer, object transfer and reconciliation tooling are implemented.
- Identity import preserves disabled users and identity reconciliation verifies UID, email, verification and disabled state.
- Identity-to-profile reconciliation updates migrated PostgreSQL profiles from the final Identity Platform export before traffic is enabled.
- Storage transfer authenticates through both required Supabase gateway headers and reconciles size plus SHA-256 metadata in Cloud Storage.
- URL Monitor checks run through leased, skip-locked work claims; Workflows and Cloud Scheduler provide the five-minute tick and daily 90-day retention job.
- Database role isolation, database archive transfer and full backup/restore have executable integration tests.
- The OpenTofu target covers networking, Cloud SQL, Cloud Run, Identity Platform, Firebase Hosting, Cloud Storage, Workflows, queues, events, secrets, IAM, monitoring and immutable images.
- Firebase Hosting has a production build/deploy definition, SPA fallback, immutable asset caching and parameterised preview channels.
- The complete local gate passes:
  - 114 GCP unit and integration tests;
  - 49 frontend tests;
  - frontend and GCP typechecks and production builds;
  - all 19 project-backed pipeline stages;
  - restart and persistence tests;
  - runtime boundary scans;
  - a Chromium end-to-end project journey;
  - fresh-database initialization with the exact 25-migration set;
  - isolated source-to-archive-to-canonical database migration with deterministic transformations and Identity Platform profile reconciliation;
  - lossless database archive transfer, URL Monitor maintenance, role isolation and backup/restore integration tests;
  - an 18,000-keyword scale run.

## External inputs still required

### Source Supabase

- Read-only production PostgreSQL access and a restricted privileged export path.
- Effective schema, data, grants, policies, indexes, functions, triggers and active schedules.
- Auth export details, password-hash import eligibility and UID reconciliation.
- Complete manifests and checksums for `client-logos` and `slide-exports`.
- Deployed function versions, active or stalled jobs and effective secret names.
- A small and a large real project with verified source outputs for parity checks.

### Google Cloud and providers

- New isolated staging and production project IDs, billing linkage, region and project owners.
- Remote-state bucket, deployment identities, DNS control and approved application origins.
- DataForSEO, Ahrefs and Anthropic credentials and current quota limits.
- Workspace OAuth credentials, Slides template ID, owner, parent folder and sharing policy.
- Production notification destinations and operational owners.

## Work that starts when access arrives

1. Capture and sign the live source inventory without changing the source.
2. Generate and approve the exact canonical plan against the signed source and target inventories.
3. Provision the isolated staging project from OpenTofu.
4. Load identities, the lossless archive, canonical database rows and storage objects with the prepared tools.
5. Reconcile users, tables, relationships, sequences and object hashes.
6. Exercise live providers and direct Google Workspace export in staging.
7. Compare frozen real-project outputs and correct any source-specific mapping differences.
8. Repeat backup restore, role isolation, monitoring and the complete route matrix against managed staging.
9. Rehearse the cutover and Google-Cloud-only recovery sequence.

## Current boundary

No source write, source deployment, Google Cloud resource creation, DNS change or production migration has been performed. Supabase remains an extraction source only and will not be used by the target runtime.
