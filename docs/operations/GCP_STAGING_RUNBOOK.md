# Seer GCP Staging Runbook

## Scope and source of truth

- Google Cloud project: `secure-cipher-503913-f1`
- Primary region: `europe-west2`
- Deployment account: `seer@nobraineragency.com`
- Hosting site: `https://seer-161062363690.web.app`
- API service: `seer-api`
- Worker service: `seer-worker`
- Event relay service: `seer-events`
- Pipeline workflow: `seer-pipeline`
- Maintenance workflow: `seer-maintenance`
- Deployable repository: `gary547/Seer-Sebs`

The deployable system is Google Cloud only. The `supabase/` directory and the
original Supabase project are read-only migration references and must never be
used by a deployed runtime. The original `gary547/empty-canvas` repository is
also a read-only source reference; releases come only from `gary547/Seer-Sebs`.

## Expected application flow

1. The user opens the Firebase-hosted frontend and signs in through Google
   Identity Platform.
2. The browser calls the Cloud Run API with the Identity Platform token. The
   API resolves the user, organization, and project before returning or
   changing any data.
3. Project inputs and uploads are stored in Cloud SQL and private Cloud Storage
   buckets. The browser never talks directly to the database or storage.
4. Starting an analysis creates a durable pipeline run and invokes
   `seer-pipeline`. The workflow advances only when the required previous
   stages have completed.
5. The canonical sequence contains 19 stages: intake, GSC promotion, detox,
   categorisation, brand classification, keyword enrichment, ranking URL, GSC
   intent, SERP collection, authority, backlinks, site architecture, link
   power score, demand signals, CTR curves, clustering, HAR v2, Revenue v2, and
   calibration.
6. Provider work is delivered to the private worker through Cloud Tasks. Every
   operation is idempotent so a retry cannot duplicate a completed result.
7. Each stage persists its result and status before dependent work begins. A
   terminal failure is recorded, blocks dependent stages, and remains visible
   to the frontend instead of being treated as a success.
8. The event relay publishes persisted outbox events to Pub/Sub. The frontend
   reads current run state and results from the API; it does not rely on an
   in-memory workflow session.
9. Google Slides exports use the Workspace OAuth secret. Scheduled URL checks
   and retention run through `seer-maintenance` and Cloud Scheduler.
10. No deployed request, background task, identity flow, object operation, or
    database query may use Supabase.

## Runtime secret contract

Secret values are loaded through Secret Manager and must never be written to
Git, OpenTofu variables, build substitutions, logs, or documentation.

| Secret | Required value |
| --- | --- |
| `seer-ahrefs-api-key` | Raw Ahrefs API key |
| `seer-anthropic-api-key` | Raw Anthropic API key |
| `seer-dataforseo-credentials` | Preferred: raw `login:password`; accepted alternative: Base64-encoded `login:password` |
| `seer-workspace-oauth` | JSON containing `client_id`, `client_secret`, and `refresh_token` |
| `seer-internal-service-token` | Random internal service token |

Add or rotate a value from a temporary local file:

```bash
gcloud secrets versions add SECRET_NAME \
  --data-file=/absolute/path/to/temporary-secret-file \
  --project=secure-cipher-503913-f1 \
  --account=seer@nobraineragency.com
```

Delete the temporary file immediately after the new version and its live probe
have succeeded. Never disable the previous working version until the new
version has been verified. Increment `runtime_secret_revision` in the external
environment variables and apply the reviewed OpenTofu plan so every affected
Cloud Run service starts a revision with the new value.

## Google Workspace OAuth

Google Auth Platform is configured as an internal Workspace application. The
runtime uses a Desktop OAuth client with these scopes:

- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/presentations`

The authorization must be completed as the Workspace user that can read the
Slides template. Request offline access with an explicit consent prompt so
Google returns a refresh token. Store only this normalized document in
`seer-workspace-oauth`:

```json
{
  "client_id": "<oauth-client-id>",
  "client_secret": "<oauth-client-secret>",
  "refresh_token": "<oauth-refresh-token>"
}
```

Before deployment, verify all three operations without printing tokens or file
contents:

1. Refresh the access token through `https://oauth2.googleapis.com/token`.
2. Read the configured template through the Drive API.
3. Read the same template through the Slides API.

All three calls must return HTTP `200`.

## Infrastructure release sequence

Do not change the globally active gcloud account. Give OpenTofu a short-lived
token for the Seer account in the deployment shell:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token \
  --account=seer@nobraineragency.com)"
```

Use the environment file stored outside Git, then validate and save a reviewed
plan:

```bash
tofu -chdir=gcp/infra validate
tofu -chdir=gcp/infra plan \
  -var-file=/absolute/path/to/seer-staging-runtime.tfvars \
  -out=/absolute/path/to/seer-staging-runtime.tfplan
```

The plan must use immutable image digests, keep
`database_schema_ready = true`, and contain no unexpected replacement or
destruction. Apply the saved plan, not a newly calculated plan:

```bash
tofu -chdir=gcp/infra apply /absolute/path/to/seer-staging-runtime.tfplan
unset GOOGLE_OAUTH_ACCESS_TOKEN
```

The API uses Cloud Run's invoker-IAM-check setting instead of an `allUsers`
IAM binding because the Workspace organization policy rejects public members.
The API service also requires bucket metadata read access before its readiness
probe starts.

## Frontend release

Deploy only after the API readiness check succeeds. Read the Firebase web
configuration and API URL from OpenTofu outputs, then submit
`gcp/cloudbuild.web.yaml` with:

- the full Git commit SHA;
- Firebase API key, app ID, auth domain, and managed site ID;
- the HTTPS Cloud Run API URL;
- `_HOSTING_CHANNEL=live` for the live site.

Manual source uploads must use
`gs://secure-cipher-503913-f1-seer-build-source`. Cloud Build performs locked
installation, type checking, tests, the Vite production build, and Firebase
deployment. A failed validation step must stop the release.

## Live verification

After every release:

1. Confirm `seer-api`, `seer-worker`, and `seer-events` have a ready revision.
2. Confirm the external API `GET /readyz` returns HTTP `200`.
3. Confirm `seer-pipeline` and `seer-maintenance` are active.
4. Confirm both maintenance scheduler jobs are enabled.
5. Open `https://seer-161062363690.web.app` in a clean browser context.
6. Confirm the auth screen renders without console errors or failed requests.
7. Confirm the browser can reach the Cloud Run API with CORS enabled.
8. Confirm browser traffic contains no Supabase hostname.
9. Confirm a protected API route rejects an unauthenticated request.

## DataForSEO degraded state

As of 2026-07-31, the supplied DataForSEO value has been tested as a raw Basic
token, as the password for the Seer Workspace email, and as both login and
password. DataForSEO returned `401` for every combination. The current secret
version is provisional so the worker can start, but every stage that requires
DataForSEO is expected to fail closed until the correct API login is supplied.

When the login is available:

1. Test `login:password` against DataForSEO's authenticated user endpoint.
2. Require HTTP `200` and API status code `20000`.
3. Add the verified raw `login:password` as a new version of
   `seer-dataforseo-credentials`.
4. Start a new `seer-worker` revision so running instances load the new secret.
5. Execute a small provider-backed pipeline rehearsal and inspect its durable
   stage result before treating the integration as healthy.

Do not change frontend, database, OAuth, or the other provider secrets when
rotating DataForSEO.
