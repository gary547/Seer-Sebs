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
management, GSC workbook import, SERP ingestion, the ordered 24-stage
autonomous calculation pipeline, forecasting, calibration and deduplicated
rollups, archive workflows, URL
monitoring, reference data, content planning, slide export, and admin-only
inspection and control of GSC readiness, CTR, calibration, rank provenance,
clustering, volume history, demand, SERP visibility, Link Power, content fit,
HAR/Revenue comparisons, brand classification, and recent calculation runs.

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
- Identity registration must create accounts through the project-scoped admin
  endpoint with an application-generated UUID, then use password sign-in to
  obtain the user's ID token for the public email-verification OOB request.
  Roll back the Identity account and database profile if any stage fails.
- The Cloud Build service agent needs `roles/secretmanager.admin` to create and
  maintain GitHub connection secrets; keep this binding managed by OpenTofu.
- Keep Cloud Build source uploads constrained by `.gcloudignore`, and deploy
  Firebase Hosting through the `web` target bound at build time to the
  OpenTofu-managed site ID.
- The production `main` trigger uses `gcp/cloudbuild.runtime.yaml` with
  `_AUTO_DEPLOY=true`. Keep its release order: schema migration, Cloud Run,
  Workflows, API readiness, then Firebase Hosting. Manual builds must retain
  the default `_AUTO_DEPLOY=false` and must not change live services.
- Render Workflow templates through
  `gcp/scripts/render-managed-workflows.mjs`; the renderer must preserve
  Workflow expression syntax while resolving only the managed project, secret
  and service URL placeholders.
- Stage manual Cloud Build uploads only in the dedicated short-lived
  `seer-build-source` bucket; the build identity has read-only access there.
- Cloud Build steps that use `script` must carry their own Bash shebang and
  must not also declare `entrypoint`, which the Cloud Build API rejects.
- Managed schema bootstrap verifies IAM role membership through
  `information_schema.applicable_roles.grantee`; PostgreSQL exposes no
  `member` column in that view.
- Keep portfolio and capture-window queries bounded before joining keyword,
  revenue, and HAR forecast tables. Migration `026_portfolio_query_indexes`
  supplies the latest-successful-run lookup index, and the 18,000-keyword
  scale gate requires `/v1/portfolio` to complete in under five seconds.
- Worker task HTTP responses are bounded acknowledgements containing only the
  run, stage, status, and optional idempotency flag. Stage outputs are persisted
  in PostgreSQL and must never be echoed through Workflows or dispatcher HTTP
  responses.
- Large detox results are persisted transactionally in batches of at most 2,000
  keyword decisions with a stage-local extended statement timeout. Preserve the
  total updated-row assertion so a partial qualification write rolls back.
- Anthropic content-fit batches retry transient transport failures and unusable
  model responses up to 30 attempts with a fixed two-second delay. Retry state
  is written to the running `site-architecture` stage output for operator
  visibility; terminal exhaustion uses a non-retryable dependency response so
  the managed Workflow does not multiply the 30 provider attempts.
- Workflow failure payloads are internal diagnostics and must never be exposed
  by run-status APIs or the admin calculation UI. Store curated stage-specific
  failure messages and sanitize legacy HTTP/trace payloads at the API boundary.
- GSC CSV and XLSX imports skip individual queries longer than 200 characters
  and report the skipped count as an import warning. One malformed SAFS row
  must not reject an otherwise valid upload.
- GSC CSV and XLSX imports merge duplicate rows by normalised query, page, and
  device before persistence. Sum clicks and impressions, recompute CTR, and
  use impression-weighted position; report the merged row count as an import
  warning.
- Standard GSC exports may use the aggregate `all` device. Preserve it through
  import, fixtures, pipeline output, and `ctr_curves`; the database device
  constraint must accept `all`, `desktop`, `mobile`, and `tablet`. Prefer an
  exact device curve and use `all` as the first deterministic fallback.
- The admin calculation control room reads paginated, searchable results from
  `GET /v1/projects/:projectId/calculation-inspector` and
  `GET /v1/projects/:projectId/link-power-inspector`. Both routes require an
  administrator and project access, and they inspect the latest successful
  pipeline run without mutating calculation data.
- `GET /v1/projects/:projectId/calculation-control` is the bounded aggregate
  contract for every panel in the admin Calculations page. Keep uploads and
  recent runs capped at 20, comparison rows capped at 50, and detail samples
  capped at 20. The route is administrator-only and may inspect archived
  projects; archived UI state must remain read-only.
- Keep calculation-control and calculation-inspector bounded on 18,000-keyword
  projects. Select the realistic revenue page before expanding the three HAR
  scenarios, and select comparison sample keys before joining detail rows.
  Migration `031_calculation_inspector_indexes` supplies the canonical monthly
  volume, realistic HAR, and realistic revenue covering indexes. The scale gate
  must call calculation-control, calculation-inspector, and Link Power
  concurrently and complete the group in under five seconds.
- Monthly-volume reads must resolve one canonical migrated row per keyword and
  month. Prefer the latest `fetched_at`, then use source and row ID as stable
  tie-breakers; live-provider data may fill only months absent from migrated
  history.
- `DELETE /v1/projects/:projectId/gsc-uploads/:uploadId` is an
  administrator-only, project-scoped mutation. It must reject archived
  projects, rely on cascading child-row deletion, and mark calculation inputs
  and keywords dirty after a successful deletion.
- Calculation panel actions run the canonical dependency-safe 24-stage GCP
  pipeline. Do not reintroduce standalone Supabase edge-function calls for
  individual legacy buttons.
- The autonomous pipeline is a 24-stage graph: intake and qualification fan
  out into CTR truth, demand, competitive and content tracks, converge at HAR
  v2, then continue through Revenue v2, calibration and rollup output. Preserve
  the stage dependencies and parallel-track semantics in
  `gcp/packages/pipeline/src/definition.ts` and the managed Workflow template.
- `GET` and `PATCH /v1/projects/:projectId/pipeline-readiness` expose and update
  the hard-gate configuration and operator-controlled promotion/enrichment
  thresholds. `POST /v1/projects/:projectId/pipeline-precurated` stamps a
  manually curated keyword set. `POST /v1/projects/:projectId/pipeline-runs`
  accepts `full`, `resume` and `recalculate` modes; recalculation must not repeat
  paid provider stages.
- `GET /v1/pipeline-runs/:id` returns run status without stage payloads.
  `GET /v1/pipeline-runs/:id/stages?ids=a,b` returns a bounded output batch.
  The web client assembles a full run from those batches instead of requesting
  `includeOutput=true`, which exceeds the Cloud Run response limit.
- Pipeline readiness resolves client brand terms from reviewed explicit terms
  first and may fall back only to a safe registrable-domain label. Short or
  generic labels such as `ao` and `tvs` must remain blocked until an operator
  supplies explicit terms. Updating client brand terms marks every live project
  for that client input-dirty.
- A project with manual keywords and zero kept keywords must fail the
  `qualified_keywords` readiness gate before a paid run starts. Only the
  explicit `pipeline-precurated` operator action may bypass detox for a curated
  manual set.
- Missing client domain authority is hydrated from Ahrefs during full-run
  preflight and cached for later projects; existing positive authority metrics
  must not be refetched. Provider failures must surface as failed preflight,
  never as a permanently healthy readiness state.
- Keep domain and URL authority caches shared across projects, preserve source
  and freshness provenance, and never overwrite a positive manually imported
  volume with an empty provider value. Competitive SERP fetching is performed
  per canonical cluster and inherited rows must retain their source keyword.
- Readiness stages must fail clearly before HAR or Revenue when their hard
  inputs are absent. Every fallback or substitution must remain visible in the
  run output and derived-record provenance; missing content fit is `NULL`, not
  zero.
- `pipeline_rollups` stores naive and cluster-deduplicated totals plus cluster,
  category, quarter, trend, confidence and cannibalisation output. Client-facing
  totals must use the deduplicated value while retaining the naive total for
  auditability.
- Categorisation taxonomies must be project-aware. The television-specific
  taxonomy applies only to television/electronics projects; other industries
  fall back to the configured project category focus rather than inheriting an
  unrelated hardcoded category.
- Migration `027_calculation_control_contract` materializes legacy v1 forecast
  values from the lossless migration archive into
  `legacy_keyword_forecasts` for read-only HAR/Revenue comparison and adds the
  general project/run history index. Keep the backfill idempotent and do not
  treat the legacy table as a calculation source.
- Canonical migration maps the source `app_role` enum through an explicit
  `normalise_text` transform into the target checked-text role contract.
- Canonical migration serializes every JSON/JSONB mapping through the explicit
  `json_value` transform so node-postgres cannot reinterpret JSON arrays as
  PostgreSQL arrays.
- Canonical migration maps legacy keyword detox states explicitly: `removed`
  becomes `remove`, and `flagged_remove` becomes `review`. Unknown values must
  fail closed instead of bypassing the target check constraint.
- Canonical migration aggregates duplicate legacy GSC keyword rows by upload,
  normalised query, page, and device, then recomputes CTR and
  impression-weighted position. It keeps every original row in the lossless
  archive.
- Canonical migration retains only each keyword's latest SERP snapshot and the
  best rank for repeated URLs. Duplicate ranks in a selected snapshot fail
  closed; complete SERP history remains in the lossless archive.
- Source `competitors.added_by` is provenance text, not a user UUID; retain it
  in the lossless archive and leave the nullable canonical UUID unset.
- Run source database transfer only through the managed archive and canonical
  Cloud Run jobs. Plans are checksum-pinned, executions are generation-locked,
  and checkpoints live in the private versioned migration-evidence bucket.
- Completed checkpoint entries are reverified against current source and
  target counts on every managed rerun; a checkpoint never bypasses database
  reconciliation.
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
