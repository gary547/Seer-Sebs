# Seer®

Seer is No Brainer's SEO command centre. This repository contains the web
application, the managed Google Cloud runtime, infrastructure definitions,
database contracts, migration tooling, and automated validation.

## Local development

Requirements:

- Node.js 24
- Docker
- OpenTofu

Install both lockfiles:

```bash
npm ci
npm ci --prefix gcp
```

Start the web application:

```bash
npm run dev
```

Run the complete local validation:

```bash
npm run validate:foundation
npm run test:gcp:docker
```

## Google Cloud runtime

The production architecture uses Firebase Hosting, Cloud Run, Cloud SQL for
PostgreSQL, Cloud Storage, Identity Platform, Cloud Tasks, Secret Manager,
Artifact Registry, Cloud Build, and Cloud Monitoring.

Infrastructure and deployment assets live in [`gcp/`](./gcp/). Migration
documentation lives in [`docs/migration/`](./docs/migration/). Staging
deployment, secret rotation, OAuth, and live verification are recorded in the
[`GCP staging runbook`](./docs/operations/GCP_STAGING_RUNBOOK.md).

## Legacy source reference

The [`supabase/`](./supabase/) directory is retained only as a read-only source
reference for schema and behaviour migration. It is not part of any deployable
artifact. The GCP boundary check enforces this rule:

```bash
npm run check:gcp-boundary
```

## Route hierarchy

```text
/dashboard
/clients
/clients/:clientId
/clients/:clientId/projects/:projectId
/clients/:clientId/projects/:projectId/:view
```

Internal navigation uses the helpers in `src/lib/routes.ts`. Legacy
`/navigator*` routes remain redirected during the transition.
