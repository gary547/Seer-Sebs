# Seer Repository Guide

## Repository scope

- This is the official Seer application repository.
- The deployable platform is Google Cloud only.
- `supabase/` is a read-only historical reference for migration and behavioural
  parity. Never deploy it, run its migrations against the source project, or
  add live Supabase credentials.
- Source exports, database dumps, object archives, `.env` files, state files,
  and migration evidence must remain outside Git.

## Architecture

- `src/`: React 19 and Vite web application.
- `src/integrations/gcp/`: the only production data and authentication client
  boundary used by the web application.
- `gcp/apps/api/`: HTTP API for identity, tenancy, projects, calculations,
  assets, administration, URL monitoring, content plans, and slide exports.
- `gcp/apps/worker/`: ordered pipeline stage execution and live data providers.
- `gcp/apps/dispatcher/`: task dispatch and recovery.
- `gcp/apps/events/`: transactional outbox publication.
- `gcp/apps/object-store/`: local object-store contract used by integration
  tests; production assets use Cloud Storage.
- `gcp/database/init/`: canonical PostgreSQL schema contracts and grants.
- `gcp/infra/`: OpenTofu definitions for Firebase Hosting, Identity Platform,
  Cloud Run, Cloud SQL, Cloud Storage, Cloud Tasks, Secret Manager, Artifact
  Registry, Cloud Build, networking, and monitoring.

## Product capabilities

The managed runtime covers client and project administration, keyword
management, GSC workbook import, SERP ingestion, the ordered 19-stage
calculation pipeline, forecasting and calibration, archive workflows, URL
monitoring, reference data, content planning, and slide export.

HTTP route registration is centralised in `gcp/apps/api/src/server.ts`.
Database changes must be additive, ordered SQL contracts in
`gcp/database/init/` and must include the required grants and integration
coverage.

## Development

Use Node.js 24 and install both lockfiles:

```bash
npm ci
npm ci --prefix gcp
```

Cloud Build runtime validation must install both lockfiles before running GCP
typechecks or tests.

Run the standard validation before committing behaviour changes:

```bash
npm run validate:foundation
npm run test:gcp:docker
```

The Docker gate validates container builds, fresh and repeated schema
application, database transfer, backup and restore, access boundaries, API and
worker workflows, event delivery, object persistence, and restart persistence.

## Implementation rules

- Keep production code free of Supabase runtime imports and environment
  variables. `npm run check:gcp-boundary` enforces the deployable boundary.
- Identity Platform authorized domains must include the Firebase web app
  `authDomain` and both domains of the selected Hosting site. Keep the disabled
  phone sign-in block explicit to avoid provider drift.
- The Cloud Build service agent needs `roles/secretmanager.admin` to create and
  maintain GitHub connection secrets; keep this binding managed by OpenTofu.
- Keep Cloud Build source uploads constrained by `.gcloudignore`, and deploy
  Firebase Hosting through the `web` target bound at build time to the
  OpenTofu-managed site ID.
- Stage manual Cloud Build uploads only in the dedicated short-lived
  `seer-build-source` bucket; the build identity has read-only access there.
- Cloud Build steps that use `script` must carry their own Bash shebang and
  must not also declare `entrypoint`, which the Cloud Build API rejects.
- Managed schema bootstrap verifies IAM role membership through
  `information_schema.applicable_roles.grantee`; PostgreSQL exposes no
  `member` column in that view.
- Canonical migration maps the source `app_role` enum through an explicit
  `normalise_text` transform into the target checked-text role contract.
- Canonical migration serializes every JSON/JSONB mapping through the explicit
  `json_value` transform so node-postgres cannot reinterpret JSON arrays as
  PostgreSQL arrays.
- Canonical migration maps legacy keyword detox states explicitly: `removed`
  becomes `remove`, and `flagged_remove` becomes `review`. Unknown values must
  fail closed instead of bypassing the target check constraint.
- Source `competitors.added_by` is provenance text, not a user UUID; retain it
  in the lossless archive and leave the nullable canonical UUID unset.
- Run source database transfer only through the managed archive and canonical
  Cloud Run jobs. Plans are checksum-pinned, executions are generation-locked,
  and checkpoints live in the private versioned migration-evidence bucket.
- Restore the approved source dump into the isolated `seer_source_snapshot`
  Cloud SQL database and connect through migrator IAM authentication. Never
  place a source database password in Cloud Run configuration or Terraform.
- Keep the system CA certificate bundle in the database-transfer runtime; the
  embedded Cloud SQL Auth Proxy requires it to verify Google API endpoints.
- Use static imports in production code.
- Add integration tests for backend routes, jobs, database contracts, and
  external-service adapters.
- Do not commit secrets or generated migration evidence.
- Write code, commit messages, comments, and repository documentation in
  English.
