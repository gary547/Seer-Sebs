# SEER Migration Inventory

This is the working checklist for the Lovable/Supabase to Google Cloud migration. It records every repository-confirmed runtime asset and the target action.

Target constraint: Supabase is an extraction source only. The staging and production target must contain no Supabase runtime, SDK, endpoint, credential, hybrid data path or fallback.

Status legend:

- `[x]` confirmed from repository or handover evidence;
- `[ ]` still requires live-source verification or implementation;
- `Migrate` means preserve data and behaviour;
- `Adapt` means preserve intent but replace Supabase-specific implementation;
- `Retire` means retain historical evidence where needed, then remove from the runtime;
- `New` means required for the Google Cloud target.

## 1. Inventory control

| Check | Item | Status |
|---|---|---|
| [x] | Repository worktree baseline captured | Clean `main` at planning time |
| [x] | Handover and both prompt sequences reviewed | Complete |
| [x] | Repository table inventory | 58 tables |
| [x] | Repository Edge Function inventory | 38 functions |
| [x] | Repository shared-module inventory | 18 modules, 15 shared tests |
| [x] | Repository SQL function inventory | 28 unique functions |
| [x] | Repository trigger inventory | 17 triggers |
| [x] | Repository extension inventory | 3 extensions |
| [x] | Repository storage inventory | 2 buckets |
| [x] | Repository frontend dependency inventory | Direct Supabase Auth, SQL, RPC, Storage and Function use |
| [ ] | Live production schema dump | Required before implementation |
| [ ] | Live RLS and grants dump | Required; 165 historical policy definitions are not the effective live set |
| [ ] | Live table sizes and row counts | Required |
| [ ] | Live cron and job-state dump | Reconfirm the July 2026 audit |
| [ ] | Live auth-user export feasibility | Required |
| [ ] | Live storage object inventory | Required |
| [ ] | Live Edge Function deployment and secret-name inventory | Required |

## 2. Platform services

| ID | Current asset | Google Cloud target | Action | Check |
|---|---|---|---|---|
| P-01 | Lovable SPA hosting | Firebase Hosting | Production build, cache/security headers, SPA rewrite and Cloud Build deploy are configured; live domain/TLS remains external | [x] |
| P-02 | Lovable preview workflow | Firebase preview channels | Parameterised seven-day preview-channel deployment is configured | [x] |
| P-03 | Supabase Auth | Identity Platform | Runtime, registration, profile and admin contracts implemented locally; source-user import pending | [ ] |
| P-04 | Supabase PostgREST | `seer-api` on Cloud Run | Frontend business domains now use authenticated target APIs; live staging verification remains | [x] |
| P-05 | Supabase PostgreSQL | Cloud SQL for PostgreSQL | Target schema and transfer tooling implemented; effective source mapping and data load remain | [ ] |
| P-06 | Supabase Edge runtime | Cloud Run API, workers and jobs | All 38 repository-confirmed function responsibilities are implemented, replaced or retired in the target boundary; live deployment inventory remains a discovery check | [x] |
| P-07 | Supabase Storage | Cloud Storage | Logo and export contracts plus resumable transfer tooling are proven; source object load remains | [ ] |
| P-08 | `pg_cron` / `pg_net` scheduling | Cloud Scheduler + Workflows | Database HTTP scheduling is absent from the target; pipeline and URL Monitor schedules are defined in managed infrastructure | [x] |
| P-09 | Browser Smart Sync | Workflows | Ordered 19-stage template and invocation adapter implemented; deploy and verify in staging | [x] |
| P-10 | `EdgeRuntime.waitUntil` | Cloud Tasks / Cloud Run Jobs | Durable pipeline and provider work-item state replace browser/function self-chaining | [x] |
| P-11 | Supabase secrets | Secret Manager | Target secret resources and least-privilege bindings are defined; values remain external | [x] |
| P-12 | Lovable AI Gateway | Anthropic API from Cloud Run | Direct server-side site-architecture contract implemented; live credential verification remains | [x] |
| P-13 | Lovable Drive/Slides gateway | Google Drive and Slides APIs | Direct OAuth, template copy, signed-image insertion and audit contract implemented | [x] |
| P-14 | Edge/Lovable logs | Cloud Logging and Monitoring | Structured runtime logs, dashboards and baseline alerts are defined | [x] |
| P-15 | Ad hoc deployment | Cloud Build + Artifact Registry | Immutable runtime and migration image pipeline is defined | [x] |
| P-16 | Manual infrastructure | Infrastructure as code | Validated parametric OpenTofu module; apply separately to staging and production | [x] |
| P-17 | Supabase dependency boundary | None | Target source, image, Compose and runtime gates reject Supabase packages, hostnames, keys and fallback paths | [x] |

## 3. Database tables

All tables target Cloud SQL for PostgreSQL. The implementation must preserve UUIDs, timestamps, provenance and historical calculation rows.

### 3.1 Identity, tenancy and access

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-001 | `clients` | Migrate | Preserve archive state, domain uniqueness and logo reference | [ ] |
| DB-002 | `navigator_projects` | Migrate + adapt | Preserve project settings/flags; add pipeline linkage | [ ] |
| DB-003 | `profiles` | Migrate + adapt | Make this the local application-user anchor | [ ] |
| DB-004 | `user_roles` | Migrate + adapt | Preserve four-role model; optionally mirror to custom claims | [ ] |
| DB-005 | `user_client_access` | Migrate | Enforce through API and rewritten SQL visibility helpers | [ ] |

### 3.2 Keywords, uploads and source data

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-006 | `keywords` | Migrate | Core pipeline entity; preserve all enrichment and clustering fields | [ ] |
| DB-007 | `keyword_rules` | Migrate | Preserve deterministic rule inputs | [ ] |
| DB-008 | `keyword_tag_history` | Migrate | Preserve categorisation audit history | [ ] |
| DB-009 | `keyword_monthly_volumes` | Migrate | Preserve full time series and uniqueness | [ ] |
| DB-010 | `gsc_uploads` | Migrate | Preserve workbook provenance and upload state | [ ] |
| DB-011 | `gsc_upload_keywords` | Migrate | Preserve row-level device, brand and intent fields | [ ] |
| DB-012 | `gsc_upload_pages` | Migrate | Preserve page-level workbook data | [ ] |

### 3.3 Forecasting, calibration and reference data

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-013 | `har_results` | Migrate | Retain v1 client-facing baseline and historical values | [ ] |
| DB-014 | `keyword_forecasts` | Migrate | Retain v1 client-facing outputs through promotion gate | [ ] |
| DB-015 | `keyword_forecast_scenarios` | Migrate | Preserve all versioned v2 scenario rows | [ ] |
| DB-016 | `calc_run_registry` | Migrate + extend | Link HAR/Revenue model runs to pipeline stage runs | [ ] |
| DB-017 | `calibration_snapshots` | Migrate | Preserve the full gate history | [ ] |
| DB-018 | `client_domain_metrics` | Migrate | Preserve current authority baseline | [ ] |
| DB-019 | `link_power_scores` | Migrate | Preserve run/version provenance | [ ] |
| DB-020 | `keyword_demand_signals` | Migrate | Remove runtime 5,000-row truncation in the target | [ ] |
| DB-021 | `category_demand_signals` | Migrate | Preserve rollups and provenance | [ ] |
| DB-022 | `project_conversion_overrides` | Migrate | Preserve scope precedence and actor history | [ ] |
| DB-023 | `ctr_curves` | Migrate | Preserve fallback/project/device/intent/rank semantics | [ ] |
| DB-024 | `ctr_curve_metadata` | Migrate | Preserve source, confidence and raw-unit provenance | [ ] |
| DB-025 | `ctr_estimate_cache` | Migrate | Retain benchmark cache until retirement is approved | [ ] |
| DB-026 | `serp_feature_ctr_adjustments` | Migrate | Preserve live model configuration | [ ] |
| DB-027 | `har_scoring_config` | Migrate + clarify | Preserve live knobs; correct model/config lineage label separately | [ ] |

### 3.4 SERP, authority and site architecture

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-028 | `competitors` | Migrate | Preserve project/client scope | [ ] |
| DB-029 | `serp_results` | Migrate | Shared v1/v2 surface; preserve authority and freshness fields | [ ] |
| DB-030 | `serp_rankings` | Migrate | Preserve imported/current ranking rows | [ ] |
| DB-031 | `serp_features` | Migrate | Preserve feature ownership and vintage | [ ] |
| DB-032 | `serp_feature_index` | Migrate | Preserve reference/index data | [ ] |
| DB-033 | `serp_landscape` | Migrate | Preserve derived SERP summaries | [ ] |
| DB-034 | `serp_top3_cache` | Migrate | Preserve cache only if still read by content generation | [ ] |
| DB-035 | `backlink_metrics` | Migrate | Preserve authority snapshots | [ ] |
| DB-036 | `site_architecture` | Migrate | Preserve NULL vs zero semantics and `last_evaluated_at` | [ ] |
| DB-037 | `keyword_challenges` | Migrate | Preserve v1 cannibalisation/challenger outputs | [ ] |

### 3.5 Existing job and audit state

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-038 | `ai_rate_window` | Migrate or retire | Replace with provider queue limits where equivalent | [ ] |
| DB-039 | `brand_classification_jobs` | Migrate history | New runs use canonical pipeline stage/work-item state | [ ] |
| DB-040 | `categorisation_jobs` | Migrate history + adapt | Legacy retry/terminal defect corrected locally; port the corrected contract to target work items | [ ] |
| DB-041 | `content_plan_jobs` | Migrate history + adapt | Link new executions to Cloud Run job IDs | [ ] |
| DB-042 | `detox_jobs` | Migrate history + adapt | Preserve block/skip semantics in canonical pipeline | [ ] |
| DB-043 | `detox_audit` | Migrate | Preserve decision audit | [ ] |
| DB-044 | `detox_global_cache` | Migrate | Verify freshness and invalidation behaviour | [ ] |
| DB-045 | `detox_run_stats` | Migrate | Preserve historical throughput evidence | [ ] |
| DB-046 | `har_jobs` | Migrate history + adapt | Separate data collection from legacy v1 compute | [ ] |
| DB-047 | `har_serp_tasks` | Migrate history or archive | New work delivered through Cloud Tasks with DB item state | [ ] |
| DB-048 | `har_ahrefs_queue` | Migrate history or archive | Preserve provider evidence required by existing runs | [ ] |
| DB-049 | `har_backlinks_queue` | Migrate history or archive | Preserve provider evidence required by existing runs | [ ] |

### 3.6 Content and roadmap

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-050 | `content_plans` | Migrate | Preserve client/project ownership | [ ] |
| DB-051 | `content_plan_items` | Migrate | Preserve deadlines, revenue inputs and generated content | [ ] |
| DB-052 | `project_roadmaps` | Migrate | Preserve historical generated roadmaps | [ ] |

### 3.7 URL monitor

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-053 | `monitor_campaigns` | Migrate | Preserve schedule and project link | [ ] |
| DB-054 | `monitored_urls` | Migrate | Preserve next/last check and current status | [ ] |
| DB-055 | `url_check_snapshots` | Migrate | Preserve time series and indexes | [ ] |
| DB-056 | `url_issues` | Migrate | Preserve open/resolved issue state | [ ] |
| DB-057 | `monitor_alert_settings` | Migrate | Preserve notification preferences | [ ] |

### 3.8 Archive

| ID | Table | Action | Target note | Check |
|---|---|---|---|---|
| DB-058 | `archive_audit` | Migrate | Preserve immutable archive and hard-delete audit | [ ] |

## 4. New database state

| ID | Table | Purpose | Check |
|---|---|---|---|
| NEW-DB-01 | `pipeline_runs` | Canonical end-to-end project run | [x] |
| NEW-DB-02 | `pipeline_stage_runs` | Durable stage status, counts, attempts and timing | [x] |
| NEW-DB-03 | `local_task_queue` | Per-stage delivery, leasing, retry and idempotency; maps to managed task delivery | [x] |
| NEW-DB-04 | `outbox_events` and `event_deliveries` | Transactional event publication and delivery audit | [x] |
| NEW-DB-05 | `schema_migrations` | Consolidated target-schema version and provenance | [x] |
| NEW-DB-06 | `provider_work_items` | Resumable DataForSEO task state and provider-stage progress | [x] |

## 5. SQL functions

| ID | SQL function | Target action | Check |
|---|---|---|---|
| SQL-01 | `_require_admin` | Adapt to transaction-local Identity UID/role | [ ] |
| SQL-02 | `archive_client` | Port and integration-test | [ ] |
| SQL-03 | `archive_project` | Port and integration-test | [ ] |
| SQL-04 | `bulk_update_har_serp_tasks` | Adapt to target work-item model or retain during parity | [ ] |
| SQL-05 | `bulk_update_serp_authority` | Port and preserve atomic batch behaviour | [ ] |
| SQL-06 | `claim_categorisation_batch` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-07 | `claim_har_ahrefs_batch` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-08 | `claim_har_backlinks_batch` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-09 | `claim_har_serp_fetch_batch` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-10 | `claim_har_serp_fetch_by_dfs_ids` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-11 | `claim_har_serp_post_batch` | Adapt or replace with Cloud Tasks work items | [ ] |
| SQL-12 | `get_user_role` | Rewrite for local profile/role data and trusted UID | [ ] |
| SQL-13 | `guard_user_roles_insert` | Retain database guard with target identity context | [ ] |
| SQL-14 | `handle_new_user` | Retire Supabase Auth trigger; replace with trusted API provisioning | [ ] |
| SQL-15 | `hard_delete_client` | Port, transaction-test and coordinate with Cloud Storage | [ ] |
| SQL-16 | `hard_delete_project` | Port, transaction-test and coordinate with Cloud Storage | [ ] |
| SQL-17 | `has_role` | Rewrite for trusted UID/role context | [ ] |
| SQL-18 | `is_visible_client` | Rewrite and preserve access matrix | [ ] |
| SQL-19 | `is_visible_keyword` | Rewrite and preserve project/client visibility | [ ] |
| SQL-20 | `is_visible_project` | Rewrite and preserve access matrix | [ ] |
| SQL-21 | `normalize_domain` | Port unchanged and retain tests | [ ] |
| SQL-22 | `project_monthly_coverage` | Port and compare output fixtures | [ ] |
| SQL-23 | `release_stale_categorisation_claims` | Replace with reconciler or adapt to new work items | [ ] |
| SQL-24 | `release_stale_har_claims` | Replace with reconciler or adapt to new work items | [ ] |
| SQL-25 | `restore_client` | Port and integration-test | [ ] |
| SQL-26 | `restore_project` | Port and integration-test | [ ] |
| SQL-27 | `update_updated_at_column` | Port unchanged | [ ] |
| SQL-28 | `url_snapshot_detect_issues` | Port trigger function and compare issue fixtures | [ ] |

## 6. Triggers

| ID | Trigger | Target action | Check |
|---|---|---|---|
| TR-01 | `brand_jobs_updated` | Retain only while existing job table is active | [ ] |
| TR-02 | `guard_user_roles_insert` | Adapt to target role model | [ ] |
| TR-03 | `on_auth_user_created` | Retire; Identity user provisioning moves to trusted backend flow | [ ] |
| TR-04 | `pco_set_updated_at` | Port | [ ] |
| TR-05 | `trg_alert_settings_updated` | Port | [ ] |
| TR-06 | `trg_detox_jobs_updated_at` | Retain for migrated history/new compatibility if needed | [ ] |
| TR-07 | `trg_har_jobs_updated` | Retain for migrated history/new compatibility if needed | [ ] |
| TR-08 | `trg_har_scoring_config_updated_at` | Port | [ ] |
| TR-09 | `trg_monitor_campaigns_updated` | Port | [ ] |
| TR-10 | `trg_serp_feature_ctr_adjustments_updated_at` | Port | [ ] |
| TR-11 | `trg_url_snapshot_detect_issues` | Port and integration-test | [ ] |
| TR-12 | `update_categorisation_jobs_updated_at` | Retain only while existing job table is active | [ ] |
| TR-13 | `update_clients_updated_at` | Port | [ ] |
| TR-14 | `update_content_plan_items_updated_at` | Port | [ ] |
| TR-15 | `update_content_plan_jobs_updated_at` | Port | [ ] |
| TR-16 | `update_content_plans_updated_at` | Port | [ ] |
| TR-17 | `update_navigator_projects_updated_at` | Port | [ ] |

## 7. PostgreSQL extensions and database-owned scheduling

| ID | Asset | Target action | Check |
|---|---|---|---|
| EXT-01 | `pg_trgm` | Enable in Cloud SQL and verify query plans/indexes | [ ] |
| EXT-02 | `pg_cron` | Retire from application runtime | [ ] |
| EXT-03 | `pg_net` | Retire from application runtime | [ ] |
| DB-SCH-01 | historical cron definitions | Do not replay blindly; map effective live jobs only | [ ] |
| DB-SEC-01 | RLS policies | Export effective live set, consolidate and rewrite auth helpers | [ ] |
| DB-SEC-02 | grants and owners | Export effective live set and rebuild least-privilege roles | [ ] |
| DB-IDX-01 | indexes | Consolidate effective set and validate scale query plans | [ ] |
| DB-CON-01 | foreign keys/checks/unique constraints | Consolidate and validate before data import | [ ] |
| DB-SEQ-01 | sequences/identity state | Reconcile after every rehearsal and final import | [ ] |

## 8. Edge Functions

| ID | Edge Function | Google Cloud target | Action | Check |
|---|---|---|---|---|
| FN-01 | `admin-approve-user` | `seer-api` + Identity Admin SDK | Approval and profile state implemented | [x] |
| FN-02 | `admin-delete-user` | `seer-api` + Identity Admin SDK | Identity and relational cleanup implemented | [x] |
| FN-03 | `admin-invite-user` | `seer-api` + Identity Admin SDK | Invite/reset-link flow implemented | [x] |
| FN-04 | `admin-list-users` | `seer-api` + Identity Admin SDK | User, role and client-access join implemented | [x] |
| FN-05 | `admin-set-role` | `seer-api` + Identity Admin SDK | Database role and identity update implemented | [x] |
| FN-06 | `archive-hard-delete` | `seer-api` + private storage | Transactional row deletion, audit and object cleanup implemented | [x] |
| FN-07 | `base-rank-backfill` | Canonical ranking/SERP stages | Base rank is derived and persisted idempotently during the managed pipeline | [x] |
| FN-08 | `brand-classification` | `seer-worker` workflow stage | Client brand terms, rules, confidence and persisted classifications are implemented | [x] |
| FN-09 | `calibration-compute` | `seer-worker` | Exact parity model implemented as the final workflow gate | [x] |
| FN-10 | `categorisation-consolidate` | `seer-api` | Preview, apply, audit and undo contract implemented | [x] |
| FN-11 | `categorisation-deferred-tick` | Canonical workflow stage | Deferred and live cohorts complete inside the durable categorisation stage; the cron wrapper is retired | [x] |
| FN-12 | `claude` | Direct server-side Anthropic client | Browser/Edge gateway retired from the target runtime | [x] |
| FN-13 | `compute-forecasts` | Retired | Legacy v1 compute is archived; the target exposes the canonical v2.1 model only | [x] |
| FN-14 | `compute-forecasts-v2` | `seer-worker` | Exact HAR/Revenue v2.1 models and versioned persistence implemented | [x] |
| FN-15 | `content-plan-generate` | `seer-api` | Clustering, scheduling, brief generation and transactional persistence implemented | [x] |
| FN-16 | `ctr-benchmark` | Canonical CTR stage | GSC observations and deterministic fallback curves replace the legacy cache | [x] |
| FN-17 | `ctr-curves-from-gsc` | `seer-worker` | Deterministic curve build and persisted points implemented | [x] |
| FN-18 | `dataforseo-historical-volume-backfill` | `seer-worker` | Live batched enrichment persists monthly history in the canonical pipeline | [x] |
| FN-19 | `dataforseo-history-probe` | Retired | Provider capability is validated through the managed adapter and staging acceptance | [x] |
| FN-20 | `demand-signals-compute` | `seer-worker` | Full-set computation and reconciliation implemented and scale-tested | [x] |
| FN-21 | `dfs-core-keyword-backfill` | `seer-worker` | Managed keyword enrichment replaces the standalone backfill with batching and retry control | [x] |
| FN-22 | `export-performance-slides` | `seer-api` + Drive/Slides APIs | Direct Workspace API export implemented with signed GCS image input | [x] |
| FN-23 | `gsc-intent-enrichment` | `seer-worker` | Project-backed mapping, persistence and idempotent completion implemented | [x] |
| FN-24 | `gsc-workbook-import` | `seer-api` + Cloud Run Job | CSV/XLSX parser, date/device validation and PostgreSQL provenance are implemented and integration-tested | [x] |
| FN-25 | `har-calculation` | `seer-worker` | Provider hydration and deterministic calculation are decoupled in the pipeline | [x] |
| FN-26 | `har-calculation-v2` | `seer-worker` | Exact deterministic HAR v2.1 implementation is parity-checked | [x] |
| FN-27 | `keyword-categorisation` | `seer-worker` | Terminal-state defect fixed; retry, fallback and completion contract implemented | [x] |
| FN-28 | `keyword-cluster-recompute` | `seer-worker` | Indexed full-set clustering and write-back implemented | [x] |
| FN-29 | `keyword-detox` | `seer-worker` | Deterministic block/skip rules and persisted decisions implemented | [x] |
| FN-30 | `keyword-enrichment` | `seer-worker` | Live DataForSEO batching, cache persistence and resumable work implemented | [x] |
| FN-31 | `link-power-score-compute` | `seer-worker` | Full-set versioned calculation implemented and scale-tested | [x] |
| FN-32 | `lps-authority-backfill` | `seer-worker` | Ahrefs batch authority/backlink hydration implemented | [x] |
| FN-33 | `ranking-url-lookup` | `seer-worker` | DataForSEO ranking lookup, durable no-match state and persistence implemented | [x] |
| FN-34 | `roadmap-to-success` | `seer-api` | Append-only generated roadmap contract implemented | [x] |
| FN-35 | `serp-feature-upsert` | `seer-api` | Reference-data create/update contract implemented | [x] |
| FN-36 | `site-architecture` | `seer-worker` + Anthropic API | Server-side scoring, per-item isolation and versioned persistence implemented | [x] |
| FN-37 | `url-monitor-prune` | Workflows + Cloud Scheduler | Daily authenticated 90-day retention cleanup implemented | [x] |
| FN-38 | `url-monitor-tick` | `seer-api` + Workflows + Cloud Scheduler | Five-minute leased checks, SSRF protection and issue detection implemented | [x] |

## 9. Shared modules

| ID | Module | Target action | Check |
|---|---|---|---|
| MOD-01 | `ai-rate-window.ts` | Replaced by managed queue limits and provider retry/backoff | [x] |
| MOD-02 | `base-rank-derivation.ts` | Ported into project persistence with focused pipeline coverage | [x] |
| MOD-03 | `brand-classifier.ts` | Ported into the canonical brand-classification stage | [x] |
| MOD-04 | `calc-run-registry.ts` | Replaced by durable pipeline and stage run state | [x] |
| MOD-05 | `calibration.ts` | Ported with exact model parity tests | [x] |
| MOD-06 | `conversion-override-resolver.ts` | Ported with precedence and applied-provenance coverage | [x] |
| MOD-07 | `ctr-resolver-v2.ts` | Ported with fallback, confidence and clamp behavior | [x] |
| MOD-08 | `dataforseo.ts` | Ported as the managed DataForSEO adapter with parser tests | [x] |
| MOD-09 | `demand-signals.ts` | Ported and scale-tested | [x] |
| MOD-10 | `har-v2.ts` | Ported with exact v2.1 model parity | [x] |
| MOD-11 | `keyword-cluster.ts` | Ported with deterministic canonical selection | [x] |
| MOD-12 | `keyword-hygiene.ts` | Ported into detox/categorisation rules and tests | [x] |
| MOD-13 | `link-power-score.ts` | Ported and scale-tested | [x] |
| MOD-14 | `lps-backfill.ts` | Replaced by managed Ahrefs hydration and persisted provider work | [x] |
| MOD-15 | `pgrst-in.ts` | Retired; pagination invariants are implemented in SQL/API repositories | [x] |
| MOD-16 | `phase6-readiness.ts` | Ported into target readiness and project state APIs | [x] |
| MOD-17 | `revenue-v2.ts` | Ported with exact v2.1 model parity | [x] |
| MOD-18 | `serp-visibility-v2.ts` | Ported into the HAR/revenue model contract | [x] |

## 10. Storage

| ID | Source bucket | Target | Migration checks | Check |
|---|---|---|---|---|
| ST-01 | `client-logos` | `seer-assets/client-logos/` | Count, bytes, hashes, MIME, path rewrite, signed read/upload | [ ] |
| ST-02 | `slide-exports` | `seer-exports/` | Count, bytes, hashes, private access, lifecycle deletion | [ ] |

## 11. Active schedule mapping

The live audit captured five effective recurring schedules. They must be re-verified before cutover.

| ID | Current schedule | Target | Check |
|---|---|---|---|
| SCH-01 | URL monitor every five minutes | Cloud Scheduler -> Workflows -> authenticated maintenance API | [x] |
| SCH-02 | Detox stalled-job tick | Durable workflow retry and terminal recovery; standalone tick retired | [x] |
| SCH-03 | Categorisation worker tick (`categorisation-deferred-tick`) | Deferred cohort handled by the canonical categorisation stage | [x] |
| SCH-04 | Live categorisation resume | Durable workflow retry and idempotent stage persistence | [x] |
| SCH-05 | HAR worker tick | Ordered managed workflow and persisted provider work | [x] |
| SCH-06 | URL monitor prune | Daily Cloud Scheduler -> Workflows -> authenticated maintenance API | [x] |

## 12. Frontend and application flows

| ID | Area | Required migration | Check |
|---|---|---|---|
| FE-01 | Authentication context | Firebase Auth with local target fallback and target profile API | [x] |
| FE-02 | Login/signup | Email/password, confirmation and pending approval use target identity contracts | [x] |
| FE-03 | Password reset/change | Target action-code and password flows implemented | [x] |
| FE-04 | Role guards | Trusted profile/role state with backend enforcement | [x] |
| FE-05 | Client/project reads | Core tenancy routes use typed target API endpoints | [x] |
| FE-06 | Client/project writes | Core tenancy mutations use target API commands | [x] |
| FE-07 | Admin users | User decisions, roles, deletion and atomic client access use target API | [x] |
| FE-08 | Keyword setup/import | Authenticated paginated API, duplicate-safe import, review mutations and dirty-state updates implemented | [x] |
| FE-09 | Smart Sync | Browser orchestration replaced by the canonical 19-stage run API; concurrent starts resume the active project run | [x] |
| FE-10 | Background job rail | Reads the latest canonical pipeline and stage state | [x] |
| FE-11 | Forecast/HAR views | Target calculation, forecast, architecture and CTR endpoints | [x] |
| FE-12 | Admin calculations | Target run history, detailed outputs and workflow commands | [x] |
| FE-13 | Conversion overrides | Authenticated target CRUD with applied-forecast provenance | [x] |
| FE-14 | GSC upload | CSV/XLSX payloads use the authenticated target parser/import API; workbook-size limits are enforced | [x] |
| FE-15 | Client logos | Target API/object-store upload and read flow, including restart persistence | [x] |
| FE-16 | Slide export | Target API with direct Workspace export and temporary signed image URL | [x] |
| FE-17 | Content plans/roadmaps | Authenticated generation, list, detail, edit and promotion APIs | [x] |
| FE-18 | URL monitor | Authenticated campaign, URL, history, issue and run APIs | [x] |
| FE-19 | Archive/hard delete | Authenticated archive, restore and audited hard-delete commands | [x] |
| FE-20 | Reference data | Authenticated SERP reference and category-consolidation APIs | [x] |
| FE-21 | Theme/profile | Target profile API | [x] |
| FE-22 | React Query | Cache layer retained with target API query functions | [x] |
| FE-23 | SPA routing | Firebase Hosting fallback to `index.html` with immutable asset caching | [x] |
| FE-24 | Lovable tagger | Remove dependency and Vite plugin | [x] |
| FE-25 | Lovable Playwright fixture | Replace with standard Playwright config and fixture | [x] |
| FE-26 | Social/preview metadata | Remove Lovable-hosted image and account metadata | [x] |

## 13. External integrations and secrets

| ID | Integration/secret | Current dependency | Target action | Check |
|---|---|---|---|---|
| INT-01 | DataForSEO | `DATAFORSEO_CREDENTIALS` | Secret Manager-backed live keyword, ranking and SERP adapter implemented | [x] |
| INT-02 | Ahrefs | `AHREFS_API_KEY` | Secret Manager-backed batch authority/backlink adapter implemented | [x] |
| INT-03 | Anthropic | `ANTHROPIC_API_KEY` | Secret Manager-backed content and site-architecture clients implemented | [x] |
| INT-04 | Lovable AI | `LOVABLE_API_KEY` | Removed from the target runtime | [x] |
| INT-05 | Google Slides connector | `GOOGLE_SLIDES_API_KEY` | Connector retired; direct Workspace OAuth implemented | [x] |
| INT-06 | Google Drive connector | `GOOGLE_DRIVE_API_KEY` | Connector retired; direct Workspace OAuth implemented | [x] |
| INT-07 | Supabase endpoint | `SUPABASE_URL` | Removed from target code, configuration and deployable artifacts | [x] |
| INT-08 | Supabase browser key | `SUPABASE_ANON_KEY` / publishable key | Removed from the target application | [x] |
| INT-09 | Supabase admin key | `SUPABASE_SERVICE_ROLE_KEY` | Excluded from Google Cloud; allowed only for restricted source extraction | [x] |
| INT-10 | Database cron auth | `HAR_CRON_SECRET` | Retired with database-owned HTTP scheduling | [x] |
| INT-11 | Google Workspace template | Drive/Slides template and sharing | Confirm owner, parent folder and delegation model | [ ] |
| INT-12 | Site-architecture model | Lovable Gemini preview model | Replaced by a pinned Anthropic request/response contract; live acceptance remains | [x] |

## 14. Pipeline feature work

| ID | Capability | Current state | Target acceptance | Check |
|---|---|---|---|---|
| PIPE-01 | GSC -> keywords promotion | Aggregation, stable IDs, dedupe, URL backfill and provenance implemented | Idempotent mapping, dedupe, provenance and thresholds | [x] |
| PIPE-02 | Categorisation terminal state | Explicit retry, fallback, terminal error and processed-count reconciliation implemented | Exhausted items end through an explicit fallback/error path; run terminates | [x] |
| PIPE-03 | Progress heartbeat | Durable stage attempts, processed counts and terminal state replace fixed browser polling | Advances only on real progress | [x] |
| PIPE-04 | Enrichment worker | DataForSEO live adapter, provider cache and durable per-run progress implemented | Durable items, resume and completion counts | [x] |
| PIPE-05 | Ranking URL worker | DataForSEO live lookup with existing/matched/no-match freshness implemented | Durable no-match/freshness and terminal status | [x] |
| PIPE-06 | GSC intent worker | Project-backed mapping, provenance and retryable workflow stage implemented | Batched, retryable and resumable | [x] |
| PIPE-07 | Site architecture worker | Anthropic-backed server worker, versioned persistence and malformed-output fallback implemented | Per-item retry, malformed-output isolation, no cap | [x] |
| PIPE-08 | LPS scale | Full-set calculation and versioned persistence completed in the 18k run | Full expected/processed reconciliation | [x] |
| PIPE-09 | Demand-signal scale | 18,000 rows persisted and reconciled without truncation | Full expected/processed reconciliation | [x] |
| PIPE-10 | Clustering write-back | 18,000 indexed cluster rows persisted and reconciled | Set-based, indexed and scale-tested | [x] |
| PIPE-11 | HAR v2 execution | Exact source v2.1 model, three scenarios and versioned persistence; real-project fixture pending | Tracked worker execution linked to the pipeline run | [x] |
| PIPE-12 | Revenue v2 execution | Exact source v2.1 model, monthly output and versioned persistence; real-project fixture pending | Tracked worker execution linked to the HAR stage | [x] |
| PIPE-13 | Calibration | Exact source model, immutable per-run snapshot, promotion flag and API result implemented | Final workflow gate with immutable snapshot | [x] |
| PIPE-14 | Workflow DAG | Exact 19-stage Workflows template with OIDC, retries and terminal failure recording | Durable order, retry and terminal status | [x] |
| PIPE-15 | Browser-independent run | API-started worker run survives browser absence and full service restart | Closing all browsers does not change execution | [x] |
| PIPE-16 | 18k-keyword scale | 18,000 keywords, 54,000 HAR and 54,000 Revenue rows completed | Complete without silent truncation or broad client scans | [x] |
| PIPE-17 | Client-facing v2 promotion | Not designed | Separate product approval and per-project rollout flag | [ ] |

## 15. Test inventory and required additions

| ID | Test area | Required result | Check |
|---|---|---|---|
| TST-01 | Existing pure-module tests | Exact source-module parity check plus target contract tests pass | [x] |
| TST-02 | Frozen calculation fixtures | Match verified v2.1 outputs and provenance | [ ] |
| TST-03 | Backend API integration tests | New API domains execute against PostgreSQL in the complete Docker journey | [x] |
| TST-04 | Authorization matrix | Four roles, approval states and client assignments | [ ] |
| TST-05 | Identity import | Existing password login, reset fallback and UID preservation | [ ] |
| TST-06 | Storage contract | Upload/read persistence, signed export input and archive cleanup | [x] |
| TST-07 | Provider contracts | DataForSEO, Ahrefs, Anthropic and Workspace request/response fixtures | [x] |
| TST-08 | Idempotency | Re-delivered tasks do not duplicate/corrupt output | [x] |
| TST-09 | Failure injection | Transient retry, exhausted delivery, provider polling and fallback paths | [x] |
| TST-10 | Browser-close test | Pipeline continues to terminal state | [x] |
| TST-11 | Representative fixture | Full unattended project-backed run with deterministic expected outcomes | [x] |
| TST-12 | Large scale fixture | 18,000 keywords, full unattended run | [x] |
| TST-13 | Migration reconciliation | Counts, checksums, sequences, storage hashes and auth totals | [ ] |
| TST-14 | E2E routes | Current public/authenticated/admin routes on staging | [ ] |
| TST-15 | Backup restore | Restore Cloud SQL and recover storage object | [ ] |
| TST-16 | Cutover rehearsal | Read-only switch, smoke test and Google-Cloud-only recovery route | [ ] |
| TST-17 | Zero-Supabase gate | No package, endpoint, key, hostname, request or fallback remains in deployed artifacts | [x] |

## 16. Cutover control

| ID | Step | Check |
|---|---|---|
| CUT-01 | Freeze production source schema changes before final rehearsal | [ ] |
| CUT-02 | Stop source writes and source schedules | [ ] |
| CUT-03 | Drain/record in-flight source jobs | [ ] |
| CUT-04 | Apply final database delta | [ ] |
| CUT-05 | Apply final storage delta | [ ] |
| CUT-06 | Complete Identity Platform import | [ ] |
| CUT-07 | Reconcile tables, sequences, users and objects | [ ] |
| CUT-08 | Deploy fixed production image digests | [ ] |
| CUT-09 | Switch hosting/API while target remains read-only | [ ] |
| CUT-10 | Run authenticated production smoke matrix | [ ] |
| CUT-11 | Approve target opening or execute Google-Cloud-only recovery | [ ] |
| CUT-12 | Open target writes | [ ] |
| CUT-13 | Monitor workflows, queues, API and Cloud SQL | [ ] |
| CUT-14 | Retain restricted source exports offline; never connect them to the target runtime | [ ] |
| CUT-15 | Revoke Supabase runtime secrets after final extraction; delete source resources after acceptance | [ ] |

## 17. Live discovery queries and evidence to capture

No values or credentials belong in this document. Store outputs in the restricted migration evidence location.

- PostgreSQL version, extensions and flags.
- Schema/table/view/function/trigger/policy/grant inventory.
- Table row counts, relation sizes, largest indexes and sequence values.
- Foreign keys to `auth.users`.
- Current effective cron jobs and recent failures.
- Active/stalled rows in all job tables.
- Calculation run counts by model version/status.
- Storage buckets, object counts, bytes, MIME types and orphan checks.
- Auth user count, provider types, disabled users and bcrypt-hash exportability.
- Edge Function deployed versions, last deployment time and secret names.
- DataForSEO, Ahrefs, Anthropic and Lovable/Google connector usage and quotas.
- DNS/domain ownership and current production origin.
- Representative small project and 18,000-keyword project fixtures.

## 18. Completion rule

An item is not complete because code exists. It is complete only when:

- its source data or behaviour is accounted for;
- its target is deployed from versioned infrastructure/code;
- migration or retirement evidence is recorded;
- integration/runtime tests pass;
- logs and metrics expose its failure modes;
- rollback or recovery behaviour is known;
- no draft has been pushed as production documentation.

## 19. Local foundation status

Completed locally through 2026-07-30:

- removed Lovable build, Playwright and preview metadata dependencies;
- removed stale Bun lockfiles tied to the Lovable package registry;
- regenerated the npm lockfile with zero npm audit vulnerabilities;
- upgraded the SPA to React 19 and the patched React Router 8 package;
- added router compatibility, production-browser smoke and GCP boundary tests;
- created the first `seer-api` service boundary and its integration tests;
- encoded the canonical pipeline dependency graph and validated it for missing dependencies and cycles;
- added an isolated `gcp/package-lock.json` containing only the target runtime dependencies;
- created a seven-container local target with PostgreSQL, API, worker, dispatcher, event relay, object storage and web gateway;
- created separate PostgreSQL roles for API, worker, dispatcher and event relay access;
- implemented local identity and object-storage adapters behind replaceable production contracts;
- implemented durable task leasing, retry, exhausted-delivery failure propagation and transactional outbox delivery;
- corrected the legacy categorisation claim contract so workers receive the incremented per-keyword attempt count;
- stopped rate limits and worker-budget deferrals from consuming keyword attempts;
- added explicit low-confidence fallback provenance and terminal failure for unresolved, unclaimable rows;
- replaced the browser's fixed ten-poll categorisation window with terminal-state polling, progress-based stall detection and post-completion reconciliation;
- integration-tested categorisation claim, release and exhausted-row recovery against an isolated PostgreSQL database;
- added a validated representative fixture whose 12 source keywords and nine GSC rows contain no expected detox, category, intent or tier labels;
- implemented data-driven handlers for all 19 canonical stages, from intake through calibration;
- persisted each handler result in the stage-run output and made dependent handlers validate and consume that stored result;
- computed a 14-keyword processing set with two GSC promotions, 12 keeps, two removals, 10 live items, two deferred items and one remaining missing ranking URL;
- passed synthetic and project-backed runs with computed outputs on all 19 stages;
- added target PostgreSQL tables, constraints and indexes for clients, client access, projects, keyword rules, keywords, GSC uploads and GSC keyword rows;
- added authenticated APIs for client/project creation, rule replacement, keyword import, GSC import, project reads and project-backed pipeline starts;
- added a local provider-input API and PostgreSQL contract that remains separate from the expected outcome oracle;
- restricted local identity and provider-fixture endpoints to the local runtime environment;
- made project-backed pipeline runs load source data from PostgreSQL and atomically persist GSC aggregates, promoted keywords, ranking URL backfills, detox decisions, categorisation results, enrichment metrics, base rank and GSC intent provenance;
- proved repeated keyword imports and a second complete project run do not duplicate keywords or GSC promotions;
- rejected duplicate-normalised input batches before any database write and verified cross-user project isolation;
- restarted all containers and confirmed the project and its 14 computed keyword rows remain readable;
- replaced the operational-only gateway with a same-origin project workspace for account/client setup, project context, rules, keyword/GSC inputs, pipeline launch, live stage state and persisted results;
- completed the full browser workflow twice and verified 19 successful stages, 14 persisted keyword rows, zero duplicate promotions on rerun and no browser errors;
- proved transient categorisation recovery after two injected failures and exactly three stage attempts;
- proved exhausted enrichment delivery at attempt five fails the run and closes every remaining stage;
- executed all 19 canonical stages without browser ownership and delivered 19 corresponding events;
- verified worker redelivery is idempotent and does not increment completed-stage attempts;
- restarted every container and confirmed session, database, pipeline and object persistence;
- made dispatcher and event relay loops recover after transient PostgreSQL restart errors and covered both paths with focused tests;
- verified all 79 local public-schema indexes are valid and ready;
- scanned the source boundary, rendered Compose configuration, seven running containers and 152 target-image files for forbidden runtime dependencies;
- passed the target workspace Chrome test with five live service boundaries, project creation, two complete pipeline runs and no browser errors;
- verified application and GCP builds, typechecks and tests with Node.js 24;
- added validated OpenTofu definitions for the private network, Cloud SQL, Cloud Storage, Identity Platform, Firebase Hosting, Cloud Run, Cloud Tasks, Pub/Sub, Secret Manager, IAM and Artifact Registry;
- replaced database password URL secrets with separate Cloud SQL IAM database users and pinned automatic-authentication proxy sidecars;
- added a gated Cloud Run database migration job that applies versioned schema files and binds least-privilege runtime roles;
- separated portable non-login database roles from Docker-only login users and passed a clean-volume rebuild;
- added immutable runtime and migration image release metadata, Pub/Sub publication recovery, monitoring dashboards and baseline alerts;
- added restricted source identity/storage manifests, resumable object transfer, Firebase Auth import/reconciliation and database mapping/reconciliation tools;
- implemented and parity-checked the exact ordered 19-stage Google Cloud Workflows definition;
- implemented managed API adapters for Identity Platform token verification, Cloud Storage and Workflows execution;
- replaced streamlined forecast math with exact parity-checked HAR v2.1, Revenue v2.1 and calibration source modules;
- persisted the complete monthly Revenue and calibration gate contracts and exposed their verification fields through the API;
- passed 114 focused target tests and a clean seven-container rebuild with migrations, restart persistence and browser E2E;
- completed the 18,000-keyword scale gate with 18,000 clusters, demand and architecture rows plus 54,000 HAR and 54,000 Revenue forecasts.
- implemented Identity Platform-compatible authentication, profile, approval and administrator APIs and removed all frontend Supabase Auth calls;
- implemented typed client/project/access/logo APIs, migrated the core tenancy UI and proved cross-user isolation;
- added empty-database initialization and migration-idempotency validation;
- fixed object keys with file extensions, the worker's project-completion privilege and project-scoped not-found behaviour found by the full runtime suite.
- migrated every frontend data flow to authenticated GCP API clients and removed the Supabase SDK from the application dependency graph;
- implemented portfolio, capture-window, Content Planner, conversion override, archive, URL Monitor, reference-data and Slides API contracts;
- implemented direct DataForSEO, Ahrefs and Anthropic provider adapters with persisted resumable work state;
- implemented direct Google Drive/Slides export with Workspace OAuth and short-lived signed Cloud Storage image URLs;
- added an approved-plan-only, cursor-batched, checkpointed database transfer command with explicit source-to-target column mapping;
- added a fail-closed 58-table source catalog and keyed lossless JSON archive mode with a real PostgreSQL transfer test;
- classified all legacy calculation outputs for archive-and-recompute instead of unsafe insertion into pipeline-run target contracts;
- added 26 dependency-ordered operational-table rules with explicit profile, keyword, GSC, roadmap and URL transformations;
- added source/target inventory-driven canonical-plan generation that rejects missing rules, incompatible types and unpopulated required target columns;
- proved an isolated source-to-archive-to-canonical migration against fresh PostgreSQL databases, including self-referencing projects, URL history trigger suppression and row reconciliation;
- added final Identity Platform-to-PostgreSQL profile reconciliation for email, provider and verification state;
- preserved disabled Identity Platform users and added disabled-state reconciliation;
- added both Supabase gateway authentication headers to storage downloads;
- implemented leased URL Monitor checks plus five-minute and daily-retention Scheduler/Workflows definitions;
- proved a complete database backup/restore and least-privilege API, worker, dispatcher and event role boundaries;
- passed 49 frontend tests, both typechecks, both production builds, the full Docker validation, fresh-schema initialization and Chromium E2E.

Still open:

- live source discovery and approval of the generated canonical plan for the effective business schema;
- restricted export and migration of production identities, data and the two storage buckets;
- staging provisioning and verification of Identity Platform, Cloud SQL, Cloud Storage, Workflows, Tasks, Pub/Sub and Firebase Hosting;
- live credential tests for DataForSEO, Ahrefs, Anthropic and Google Workspace;
- frozen source-output parity for small and large real projects;
- confirmation and migration or retirement of any deployed source function, schedule, cache or history table not represented by the repository baseline;
- production notification wiring, managed backup restore repetition, staging route/role acceptance and cutover rehearsal;
- repository-wide legacy lint debt, primarily explicit `any` usage in the existing frontend and Supabase functions;
- final managed-service reconciliation and controlled production cutover.
