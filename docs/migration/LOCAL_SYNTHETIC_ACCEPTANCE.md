# Local Synthetic Acceptance Baseline

This baseline allows migration work to continue before access to the source Supabase environment and the destination Google Cloud organisation is available.

## Representative fixture

The fictional `Northstar Home` fixture contains:

- one UK consumer-electronics client and project;
- 12 source keywords;
- two GSC-only keywords promoted into the processing set;
- 12 kept and two removed processing keywords;
- 10 live and two deferred categorisation items;
- nine GSC rows across desktop and mobile;
- duplicate GSC queries and two promotion candidates;
- missing volume, difficulty and ranking-URL cases;
- explicit local provider responses for enrichment and ranking lookup, kept separate from expected outcomes;
- domain authority and backlink inputs;
- source rules for whitelist, blacklist, brand, competitor and category relevance;
- expected outcomes stored separately from the source keyword and GSC inputs.

The fixture is stored in `gcp/fixtures/representative-project.json`. Source keywords contain no detox decision, category, intent or tier. Provider responses are explicit source inputs rather than inferred test answers. The parser rejects broken references, duplicate keywords, invalid GSC metrics, invalid provider responses, incomplete expected coverage and inconsistent acceptance counts.

## Automated scenarios

| Scenario | Expected result | Verified result |
|---|---|---|
| Representative success | All 19 stages and events complete once | Passed |
| Transient categorisation failure | Two failures, success on attempt three, no duplicate events | Passed |
| Permanent enrichment failure | Five failed deliveries, run and all remaining stages become terminal | Passed |
| Worker redelivery | Re-delivery of a completed stage is idempotent | Passed |
| Full restart | Identity session, database run, events and object survive restart; processing loops recover from transient database unavailability | Passed |
| Browser workspace | Form creates and processes a project, renders 19 successful stages and 14 keyword results, then reruns idempotently with no browser errors | Passed |
| Canonical model parity | Target HAR v2.1, Revenue v2.1 and calibration modules match the source modules | Passed |
| Database migration | Isolated source rows archive losslessly, transform into fresh operational tables and reconcile with Identity Platform profiles | Passed |
| Large scale | 18,000 keywords complete without truncated calculation output | Passed |

## Project-backed acceptance

The same source fixture is also loaded through authenticated application APIs rather than attached to a pipeline run:

1. create a client and owner access record;
2. create a project with authority inputs and keyword rules;
3. import the 12 source keywords twice to prove idempotent deduplication;
4. reject a malformed batch containing duplicate normalised keywords;
5. import nine GSC rows;
6. store the local provider responses independently from the expected outcome oracle;
7. start a pipeline using only the persisted project ID;
8. verify two GSC promotions, detox/categorisation results, enrichment metrics, ranking URL and GSC intent values in PostgreSQL;
9. rerun the pipeline and verify zero new promotions and 14 total keywords;
10. verify that a different authenticated user receives no project visibility;
11. restart the full stack and read the same project and keyword state again.

Expected outcome labels remain in the test oracle only. They are never sent to the project APIs or stored as pipeline input.

Run the complete acceptance suite with:

```sh
npm run test:gcp:docker
```

## What this proves

- the representative input contract can cross the API boundary and remain intact in PostgreSQL;
- intake normalises the 12 source keywords without copying expected labels;
- GSC rows are aggregated, matching keywords are enriched and two missing queries are promoted with stable provenance;
- deterministic detox applies whitelist precedence, hygiene, blacklist, competitor and relevance rules;
- deterministic categorisation computes brand/competitor handling, TV taxonomy, intent and live/deferred routing;
- keyword enrichment fills missing volume, difficulty and intent from explicit provider responses without embedding expected results;
- ranking URL lookup records existing, matched and durable no-match states with lookup freshness;
- GSC intent enrichment maps project classifications back to distinct GSC queries and persists provenance;
- each computed output is persisted in `pipeline_stage_runs.output` and validated before the dependent handler consumes it;
- all 19 handlers can read a project snapshot from core PostgreSQL tables rather than from fixture input;
- promoted keyword rows, GSC aggregates, ranking URL backfills, detox decisions, categorisation results, enrichment metrics and GSC intents are written atomically;
- a repeated project run does not duplicate promoted keywords;
- project access is isolated by the client-access mapping;
- the canonical dependency graph executes without browser ownership;
- the deployable Workflows template contains the same 19 stages in the same dependency order;
- HAR v2.1, Revenue v2.1 and calibration use exact parity-checked source modules and persist their complete target contracts;
- tasks are durable, retried and idempotent;
- exhausted task delivery fails the run and closes downstream stage state;
- stage results and outbox events are persisted and survive a complete restart;
- dispatcher and event relay loops resume after transient database restart errors instead of remaining healthy but inactive;
- the local target remains free of source-platform runtime dependencies.
- the database migrator preserves a keyed source archive, rejects incompatible target contracts, applies ordered canonical transformations, suppresses URL history triggers during load and reconciles target identity profiles.

The large-scale run persisted:

- 18,000 keyword clusters;
- 18,000 demand-signal rows;
- 18,000 site-architecture rows;
- 54,000 HAR forecasts;
- 54,000 Revenue forecasts, including monthly output;
- one calibration snapshot.

## What this does not prove

All 19 stage handlers are data-driven. Live DataForSEO, Ahrefs and Anthropic adapters are implemented and covered with provider contract fixtures, while the complete local journey deliberately uses controlled responses so it remains deterministic and does not consume external quota. The suite therefore does not prove the supplied production credentials, quota, network policy or real-provider output distributions. It also cannot prove source-only caches, audit/history tables or deployed function behaviour that may differ from the repository baseline. The calculation code is identical to the source, but real-project frozen input/output evidence is still required before production acceptance.

The following still require source or destination access:

- effective production schema, grants, policies, cron state, row counts and data distributions;
- authentication and storage export characteristics;
- production provider secrets, quotas and deployed function versions;
- parity fixtures captured from real projects and their verified outputs;
- Google Cloud managed-service configuration, identity, networking and IAM;
- staging migration rehearsals and final reconciliation.

Synthetic data is test evidence only. It must never be presented as source data or used to infer production volumes, performance or forecast accuracy.
