# SEER Google Cloud Target

This directory is the deployable boundary for the Google Cloud version of SEER.

The application now uses this boundary for authentication, data, workflows, providers and object operations. Code under `gcp/` must not depend on Supabase packages, endpoints, credentials or fallback paths.

## Structure

- `apps/api`: authenticated application and administration API for Cloud Run;
- `apps/worker`: private, idempotent task receiver;
- `apps/dispatcher`: durable local task delivery adapter;
- `apps/events`: transactional outbox relay;
- `apps/object-store`: private local object-storage adapter;
- `database/init`: consolidated target foundation schema and non-login least-privilege roles;
- `database/local`: isolated login users used only by the Docker acceptance stack;
- `database/bootstrap`: target schema application and Cloud SQL IAM role binding;
- `packages/runtime`: shared HTTP, database and local identity contracts;
- `packages/pipeline`: canonical stage identifiers and dependency graph;
- `packages/models`: exact, parity-checked HAR v2.1, Revenue v2.1 and calibration modules;
- `scripts`: repeatable Docker, persistence and boundary validation;
- `infra`: validated OpenTofu definitions for the managed Google Cloud foundation and runtime;
- `workflows`: the validated 24-stage autonomous pipeline and scheduled-maintenance Workflows templates;
- `migration`: the complete 58-table source disposition, archive catalog and ordered canonical transformation rules;
- `cloudbuild.web.yaml`: validated frontend build plus Firebase live or preview-channel deployment.
- `cloudbuild.runtime.yaml`: immutable runtime build and release manifest, with an opt-in automatic release path that migrates the schema, updates Cloud Run and Workflows, verifies API readiness, then publishes Firebase Hosting.

## Local validation

The local stack validates the deployment boundaries before a Google Cloud project exists:

| Local service | Production equivalent |
|---|---|
| PostgreSQL container | Cloud SQL for PostgreSQL |
| Local identity adapter | Identity Platform |
| Filesystem object service | Cloud Storage |
| PostgreSQL task dispatcher | Cloud Tasks delivery to private Cloud Run |
| Transactional outbox relay | Pub/Sub publisher |
| Node API, worker, dispatcher, event and object containers | Cloud Run services |

The adapters are deliberately isolated behind service contracts. The API already includes managed adapters for Identity Platform token verification, Cloud Storage object access and Workflows execution. The event relay publishes the transactional outbox to Pub/Sub outside local mode. Local adapters keep the complete stack testable before a Google Cloud project exists.

Run the complete check:

```sh
npm run test:gcp:docker
```

It performs:

- strict target type checking, build and focused runtime tests;
- Docker image build from the isolated `gcp/package-lock.json`;
- health and readiness checks across six containers;
- registration and login through the local identity boundary;
- private asset upload and read-back;
- a browser-independent run through all 24 canonical stages;
- a representative synthetic project covering live/deferred keywords, detox removal, GSC promotion, missing metrics, missing ranking URLs and explicit local provider responses;
- computed outputs for all 24 stages, including readiness gates, SERP and authority data, site architecture, link power, demand, CTR curves, clustering, HAR v2, Revenue v2, calibration and rollups;
- exact source-to-target parity checks for the canonical HAR v2.1, Revenue v2.1 and calibration modules;
- authenticated creation of a client and project, rule replacement, idempotent keyword import and GSC upload through the target API;
- a project-backed pipeline run that reads core PostgreSQL tables and writes promoted, detoxed, categorised, enriched, ranking and GSC intent state back atomically;
- a second project-backed run proving that GSC promotion is idempotent and does not duplicate keywords;
- cross-user project isolation and malformed duplicate-input rejection;
- transient failure recovery on the third categorisation attempt;
- exhausted-delivery failure on the fifth attempt with terminal downstream propagation;
- one delivered event per completed stage;
- worker redelivery to prove idempotency;
- a full stack restart followed by database, session and object read-back, with dispatcher and event relay recovery from transient database unavailability;
- PostgreSQL role, task, event and index assertions;
- keyed lossless source-row archive transfer plus fail-closed canonical-plan generation, deterministic transformations, Identity Platform profile reconciliation and checkpointed replay;
- leased URL Monitor scheduling and 90-day snapshot retention;
- an isolated full database backup/restore rehearsal and least-privilege role boundary checks;
- source, rendered Compose, six running containers and target-image files scanned for forbidden runtime dependencies.

The separate scale gate runs the same project-backed path with 18,000 keywords:

```sh
npm run test:gcp:scale
```

It has persisted 18,000 clusters, demand signals and site-architecture rows, 54,000 HAR forecasts, 54,000 Revenue forecasts and one calibration snapshot without truncation.

`npm run test:gcp-forecast-scale` exercises Revenue with 107,926 keywords and
323,778 scenarios while calling the actual worker HTTP health endpoint. It also
checks rollups where all keywords share one ranking URL. This calculation scale
gate is included in the complete Docker check.

The local API remains available at `http://127.0.0.1:18080`.

Stop containers without deleting validation data:

```sh
docker compose -f gcp/docker-compose.local.yml down
```

## Current implementation boundary

The complete local foundation, frontend target boundary and all 24 project-backed pipeline stages are validated. Every stage reads controlled source data, writes versioned PostgreSQL state and feeds its dependent stages. The authenticated API covers identity, tenancy, keywords, GSC, calculations, SERP, roadmaps, archives, URL Monitor, reference data, conversion overrides, portfolio, capture window, Content Planner and Slides export. Live SEO data uses DataForSEO; pipeline AI uses the approved OpenRouter DeepSeek V4.1 Flash model with persisted resumable state. The target also contains authenticated five-minute URL checks, daily retention, a complete 58-table lossless archive path, 26 ordered operational-table migration rules and repeatable canonical transfer, database restore and access-boundary tests.

Production parity is not yet claimed. Real source discovery, approved data mapping, identity/data/storage import, provider credentials, managed-resource verification and frozen real-project output parity require the isolated Google Cloud projects and source access.

## Automatic production releases

The production Cloud Build trigger follows `main` and runs
`gcp/cloudbuild.runtime.yaml` with `_AUTO_DEPLOY=true`. A release is ordered as
schema migration, Cloud Run revisions, managed Workflows, API readiness and
Firebase Hosting. Manual builds retain `_AUTO_DEPLOY=false`, so validation and
immutable image creation remain safe without changing the live environment.

The regional Developer Connect repository and trigger are one-time project
bootstrap resources because GitHub OAuth must be approved by a repository
administrator. The trigger uses `seer-build` and the existing managed runtime
URLs, Firebase web configuration, Hosting site and release bucket as
substitutions; no provider credential is stored in Git.

Failed or operator-stopped project runs resume against the same run ID. The API checks unchanged project inputs, completed stage dependencies, replacement qualification and idle worker locks before resetting only unfinished stages. An optional `sourceRunId` selects an explicit failed checkpoint; automatic selection prefers compatible runs with more completed stages. Resume never silently creates a full paid run when no safe checkpoint exists.

Each recovery advances the delivery generation passed through Workflows and the dispatcher. Old task deliveries and failure callbacks cannot mutate the resumed execution. Completed outputs, frozen content-fit snapshots, provider task IDs and actual model provenance remain intact. Provider attempt totals are retained; an explicit operator resume opens a new bounded retry cycle for unfinished batches.

`POST /v1/pipeline-runs/:id/cancel` blocks subsequent provider requests and retains in-flight responses. The run-status contract exposes `stop.state` as `stopping` until dedicated stage locks are released, then `stopped`. The admin panel polls through draining, offers Stop on active runs and disables resume during draining.

DataForSEO SERP status 40102 and completed status-20000 searches with no organic
observations are persisted terminal `no_results` outcomes. Other submitted tasks
are collected; terminal tasks are not polled or submitted again. Automatic
forecast eligibility records unusable volume after the GSC fallback, volume below
the configured competitive threshold and completed searches without organic
results in immutable per-run audits. Calculations continue on the remaining
scope, and exports retain excluded rows with unavailable values and reasons.
Unexpected collection gaps and invalid authority still fail explicitly. Migration
`037_pipeline_recovery` supplies generation fencing and checkpoint grants;
`038_forecast_eligibility` supplies the exclusion audit. Recalculation reuses the
audit without provider calls, while a full run reassesses eligibility.

Revenue uses a keyword ranking index and yields between groups of 128 keywords
through the worker's cooperative executor. The synchronous and cooperative paths
use the same calculation generator, preserving financial override precedence and
scenario values. Health probes remain enabled and responsive during computation.
Rollup cannibalisation grouping appends keyword IDs without copying the accumulated
group for each keyword, keeping shared-URL aggregation linear.

Large stage arrays retain their original ordering through bounded, checksummed
storage. An individual nested record larger than eight MiB, including a complete
rollup scenario, is automatically encoded as Unicode-safe JSON fragments. The
version-two manifest reconstructs the complete original array and verifies every
chunk, field checksum and item count. Existing version-one checkpoints remain
readable. The database gate verifies all three 107,926-keyword rollup scenarios
without changing calculation values or weakening the storage limits.

The exact synthetic coverage and its limits are recorded in `docs/migration/LOCAL_SYNTHETIC_ACCEPTANCE.md`.
