# Google Cloud Cutover Runbook

This is the controlled production sequence. It is used only after staging has passed database, identity, storage, application, pipeline and scale acceptance.

## Entry gates

Cutover cannot start until:

- the effective source inventory is signed and reconciled;
- staging was built from the same immutable image digests and infrastructure definitions intended for production;
- every migrated API route and user role passed the authorization matrix;
- representative and large-project parity reports were approved;
- target backup restore was tested;
- target monitoring and alerts are active;
- the DNS owner and final approver are identified;
- the Google-Cloud-only recovery procedure has been rehearsed.

## Pre-cutover

1. Freeze source schema and application deployments.
2. Lower DNS TTL according to the approved DNS plan.
3. Capture the final pre-freeze inventory and full database/storage export.
4. Import identities while preserving UID; isolate reset-required users.
5. Load and reconcile the keyed lossless source archive into the private target migration schema.
6. Apply the inventory-validated canonical plan to the empty operational schema.
7. Reconcile Identity Platform users into application profiles, then load the storage baseline.
8. Recompute pipeline-owned calculation outputs and reconcile counts, keys, relationships, row hashes, object hashes and identity totals.
9. Deploy fixed image digests while target writes remain disabled.
10. Run read-only authenticated smoke tests for every role.

## Write freeze and final delta

1. Put the source application into maintenance/read-only mode.
2. Disable source schedules and prevent new background work.
3. Drain or record every in-flight source job.
4. Capture the final database and storage delta.
5. Apply the final delta to Google Cloud.
6. Re-run reconciliation. Any unexplained difference stops cutover.

## Traffic switch

1. Confirm target services, database, queues, workflow, storage and identity are healthy.
2. Switch the application origin and API routing to Google Cloud.
3. Keep target business writes disabled.
4. Run the production smoke matrix:
   - existing user login;
   - reset-required user flow;
   - role and client isolation;
   - client/project reads;
   - keyword and GSC import validation;
   - pipeline start, progress and terminal result;
   - asset read/write;
   - admin calculation and archive flows.
5. Compare target logs, database changes and expected events.
6. Open target writes only after explicit approval.

## Observation

Monitor:

- Cloud Run latency, errors and revision health;
- Cloud SQL connections, CPU, storage, locks and slow queries;
- task retries, exhausted deliveries and queue age;
- workflow failures and incomplete stage reconciliation;
- Pub/Sub delivery failures;
- identity errors and password-reset volume;
- storage errors;
- provider rate limits and cost signals.

Source data remains restricted and unchanged during the observation window. The migrated application must not read from or write to the source.

## Recovery

After target writes open, recovery remains inside Google Cloud:

- stop target writes;
- preserve logs and failed run state;
- roll back to the previous Cloud Run/Firebase revision where compatible;
- restore Cloud SQL to a new recovery instance when data rollback is required;
- restore or version Cloud Storage objects;
- reconcile the recovery target before reopening writes.

Do not reconnect the application to the source platform. The source is an offline extraction reference after cutover, not a runtime fallback.

## Closure

Cutover closes only when:

- reconciliation remains clean after production writes;
- backups and monitoring have produced evidence;
- source runtime credentials are revoked;
- source schedules remain disabled;
- restricted exports have an owner and retention date;
- deletion of the source environment has a separate explicit approval.
