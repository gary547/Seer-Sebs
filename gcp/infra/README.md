# Google Cloud Infrastructure

This root module provisions the reusable foundation inside one existing, isolated Google Cloud project. Run it independently for staging and production with separate state.

It creates:

- required service APIs;
- a custom VPC and Direct VPC egress subnet;
- private service access for Cloud SQL;
- PostgreSQL 17 with backups, point-in-time recovery, Query Insights and deletion protection;
- separate runtime and migration service accounts, Cloud SQL IAM database users and least-privilege project roles;
- Artifact Registry;
- private versioned asset and export buckets;
- Secret Manager containers without secret values;
- provider-specific Cloud Tasks queues;
- a retained Pub/Sub pipeline topic;
- Identity Platform, Firebase project metadata, web app and Hosting site;
- an optional, explicitly executed Cloud Run schema-migration job;
- optional Cloud Run API, worker, compatibility dispatcher and event-relay services with automatic IAM database authentication;
- the ordered 19-stage Workflows pipeline with authenticated worker calls and terminal failure recording.

## Two-phase apply

1. Copy `terraform.tfvars.example` outside the repository and set the new project, environment, region and approved domains.
2. Keep `runtime_enabled = false`.
3. Initialise a remote-state backend for the environment, then run `tofu init`, `tofu validate` and `tofu plan`.
4. Apply the foundation.
5. Load non-database secret versions through the approved secret channel. Secret values never belong in `.tfvars`, state or Git.
6. Build immutable runtime, schema-migration, and database-transfer images.
7. Set `database_migration_job_enabled = true` and `database_migration_image` to its Artifact Registry digest, then apply.
8. Execute the migration job explicitly and retain the successful execution and reconciliation evidence.
9. Set `database_schema_ready = true`, set all `runtime_images` to immutable Artifact Registry digests, then review and apply the runtime.

Runtime services connect through a pinned Cloud SQL Auth Proxy v2 sidecar using their own IAM identities. The database migration job uses a separate IAM user with the schema privileges required to apply the consolidated migrations and grant only the relevant `seer_*` role to each runtime identity.

Production keeps deletion protection enabled and uses regional Cloud SQL. Staging may use zonal Cloud SQL and disable deletion protection only in its own environment values.

Project creation, billing attachment, organisation policy, DNS and the remote-state bucket remain explicit bootstrap operations because their identifiers and ownership are not known yet. No client identifier or credential is hard-coded here.

## Frontend release

After the API is deployed, pass `firebase_web_config` and `runtime_service_urls.api` into the substitutions in `gcp/cloudbuild.web.yaml`. The build fails before compilation if any required Firebase value is missing or if the API URL is not HTTPS.

Use `_HOSTING_CHANNEL=live` for the production Hosting release. Any other valid channel name creates or updates a seven-day Firebase preview channel. The build identity requires the Firebase deployment and API-key viewer permissions documented for Cloud Build; those bootstrap permissions remain external because the deployment identity is not known yet.
