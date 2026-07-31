# Source Discovery Runbook

This runbook is executed against the current source environment before any Google Cloud resource receives production data. Discovery is read-only and its outputs are restricted migration evidence, not repository content.

## Required access

- a read-only PostgreSQL connection that can inspect `public`, `auth` and `storage`;
- source dashboard access for authentication export, storage and deployed function metadata;
- provider-console access sufficient to record secret names, quota and enabled integrations;
- DNS and current hosting ownership details.

Never place credentials, user records, database dumps or storage manifests in Git.

## Database inventory

Set the source connection only in the current shell, then run:

```sh
SEER_SOURCE_DATABASE_URL='…' \
  npm run inventory:gcp-source -- \
  --output /restricted/seer-migration/source-inventory.json
```

The command opens a repeatable-read, read-only transaction and captures:

- PostgreSQL version and installed extensions;
- tables, exact row counts and relation sizes;
- columns, defaults, foreign keys and sequences;
- indexes, functions, triggers, RLS policies and grants;
- visible recurring jobs;
- a SHA-256 signature for the complete inventory.

Capture a restricted logical dump separately:

```sh
SEER_SOURCE_DATABASE_URL='…' \
  gcp/scripts/capture-source-dump.sh \
  /restricted/seer-migration/source-dump
```

The command produces a full custom-format public archive, a data-only archive, public and effective source schema SQL, archive contents and SHA-256 checksums. It refuses to overwrite a non-empty evidence directory and restricts all generated files to the current user.

The dump is an extraction artefact only. It is not restored directly into the target because the target schema removes source-specific authentication, policy, scheduling and HTTP-runtime dependencies.

Generate the complete keyed archive plan from the signed inventory:

```sh
npm run plan:gcp-database-archive -- \
  --source /restricted/seer-migration/source-inventory.json \
  --output /restricted/seer-migration/database-archive-plan.json \
  --approve-archive
```

The generator fails closed when a live public table is absent from the 58-table catalog, when a catalogued table is absent from the source, or when an archive key is missing. Review the generated plan and its printed SHA-256 before applying it. The archive plan preserves every source row in the private `migration.source_rows` target schema; it does not replace the separately approved canonical transformation map used by the application runtime.

Apply the approved archive plan with a restricted checkpoint:

```sh
SEER_SOURCE_DATABASE_URL='…' \
SEER_TARGET_DATABASE_URL='…' \
  npm run migrate:gcp-database -- \
  --plan /restricted/seer-migration/database-archive-plan.json \
  --checkpoint /restricted/seer-migration/database-archive-checkpoint.json \
  --apply
```

Capture the initialized target schema, then generate the canonical runtime plan:

```sh
SEER_INVENTORY_DATABASE_URL='…' \
  npm run inventory:gcp-database -- \
  --label target \
  --output /restricted/seer-migration/target-inventory.json

npm run plan:gcp-database-canonical -- \
  --source /restricted/seer-migration/source-inventory.json \
  --target /restricted/seer-migration/target-inventory.json \
  --output /restricted/seer-migration/database-canonical-plan.json \
  --approve-canonical
```

The generator admits only tables explicitly classified for canonical copy or transformation. It validates load order, target relations, required columns, declared renames, deterministic transforms and source/target type compatibility. It fails if a canonical catalog entry has no rule or if the initialized target cannot be populated. Calculation outputs whose target contracts require pipeline-run provenance are not copied; their source rows remain in the private archive and the target pipeline recomputes them.

Apply the canonical plan only to an empty initialized target:

```sh
SEER_SOURCE_DATABASE_URL='…' \
SEER_TARGET_DATABASE_URL='…' \
  npm run migrate:gcp-database -- \
  --plan /restricted/seer-migration/database-canonical-plan.json \
  --checkpoint /restricted/seer-migration/database-canonical-checkpoint.json \
  --apply
```

The transfer checks source and target contracts, rejects null values required by the target, uses per-table transactions and checkpoints, and verifies row counts before advancing. URL snapshot triggers are disabled only for their canonical load transaction so historical snapshots do not generate duplicate issues.

## Identity inventory

Record without exposing password hashes in reports:

- total users;
- UID, email, provider and disabled-state coverage;
- password-hash algorithm and import eligibility;
- unconfirmed, invited, pending-approval and admin populations;
- duplicate or missing profile links;
- application role and client-access coverage.

Produce a UID reconciliation file that maps every source UID to the same target UID. Reconciliation must also match email verification and disabled state. Users whose hashes cannot be imported must be placed in the password-reset cohort before cutover.

After Identity Platform import and canonical database load, align application profiles with the final target identity export:

```sh
SEER_TARGET_DATABASE_URL='…' \
  npm run sync:gcp-identity-profiles -- \
  --identity /restricted/seer-migration/target-auth-post-import.json \
  --output /restricted/seer-migration/identity-profile-reconciliation.json \
  --apply
```

This preserves profile approvals and roles while updating UID-linked email, provider and verification state. It inserts a pending profile only when an imported identity has no application profile, and fails reconciliation when a non-local target profile has no matching identity.

## Storage inventory

For `client-logos` and `slide-exports`, capture:

- object count and total bytes;
- bucket/path, MIME type and owner where available;
- SHA-256 for every downloaded object;
- database metadata with no corresponding object;
- objects with no corresponding application record.

The target buckets remain private. Migration tooling must preserve object paths where the application depends on them and record every intentional path rewrite.

## Runtime inventory

Record:

- deployed function names, versions and last deployment timestamps;
- effective secret names, never secret values;
- active schedules and their latest successful/failed execution;
- active, stalled and failed background jobs;
- DataForSEO, Ahrefs, AI and Workspace integration quota;
- current production origin, domains and DNS TTL.

Compare these results with `MIGRATION_INVENTORY.md`. Any live asset absent from the repository inventory becomes a new tracked migration item before implementation continues.

## Freeze outputs

Discovery is complete only when the evidence location contains:

- signed source inventory;
- logical database dump and checksums;
- identity summary and UID reconciliation template;
- approved canonical plan, checkpoint and identity-profile reconciliation;
- storage manifest and object checksums;
- deployed runtime and schedule inventory;
- provider and DNS inventory;
- selected small and large parity projects.

No source write, schedule change or deployment is part of discovery.
