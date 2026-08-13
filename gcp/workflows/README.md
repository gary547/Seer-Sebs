# Pipeline Workflow

`pipeline.yaml.tftpl` is deployed by OpenTofu after the private worker revision exists.

The application API creates the durable run and starts one workflow execution. The workflow:

- retrieves the internal service token from Secret Manager;
- invokes the private worker with Workflows OIDC authentication;
- runs all 24 stage contracts across four dependency-safe parallel tracks;
- retries retryable HTTP failures with bounded exponential backoff;
- records a terminal run failure before propagating an exhausted stage error;
- never carries project data or provider credentials in its execution arguments.

The worker remains idempotent, so a retried workflow call cannot duplicate a completed stage. Provider fan-out continues through the provider-specific Cloud Tasks queues rather than expanding the workflow history.

The canonical stage identifiers and dependencies remain in `gcp/packages/pipeline/src/definition.ts`. Any change to that graph must update the workflow template and its parity check before deployment.
