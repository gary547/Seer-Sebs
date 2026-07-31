# External Access Checklist

This checklist contains only the access and configuration required to move the locally validated target into staging. Secrets, exports and customer data must be delivered through an approved restricted channel and must never be committed to the repository.

## Source environment

- Read-only PostgreSQL connection with visibility into `public`, `auth` and `storage`.
- Temporary, audited privileged export capability for authentication hashes and protected storage metadata.
- Supabase dashboard access for deployed functions, secret names, storage configuration and authentication settings.
- Current production domain, DNS owner and hosting ownership.
- Confirmation of active schedules and any in-flight or stalled background jobs.
- One small and one large project selected for frozen input/output parity.

## Google Cloud

- New staging project ID.
- New production project ID.
- Billing account and organisation/folder placement.
- Approved primary region and data-residency decision.
- Project owners and deployment identity.
- Cloud Build deployment identity with Firebase deployment and API-key viewer access.
- Remote OpenTofu state bucket.
- Approved frontend origins, custom domains and DNS access.
- Backup retention, recovery owner and production alert destinations.

## Provider credentials

- DataForSEO login/password credentials and quota limits.
- Ahrefs API key and subscription limits.
- Anthropic API key and approved model policy.
- Google Workspace OAuth client with refresh token.
- Google Slides template file ID.
- Template owner, target Drive folder and deck-sharing policy.

## Generated in the target

- Identity Platform/Firebase web configuration.
- Cloud SQL IAM database identities.
- Internal service token.
- Cloud Storage bucket names and lifecycle rules.
- Cloud Tasks, Workflows and Pub/Sub service identities.

## Explicitly excluded from the target

- Supabase URL or browser key.
- Supabase service-role key.
- Lovable API or connector keys.
- Database passwords embedded in application configuration.
- Any runtime fallback to the source environment.

## Acceptance evidence

Access is considered sufficient only when the team can produce:

- signed source inventory and restricted dump checksums;
- identity UID map and failed-import report;
- storage manifest and object-hash reconciliation;
- signed target inventory and approved generated canonical database plan;
- lossless archive, canonical row and Identity Platform profile reconciliation reports;
- successful staging import and reconciliation report;
- live provider contract results;
- real-project output parity report;
- tested backup restore and cutover rehearsal.
