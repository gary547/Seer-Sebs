import {
  MetadataAccessTokenProvider,
  type AccessTokenProvider,
} from "../../../packages/runtime/src/google-auth.js";

export interface PipelineOrchestrator {
  start(runId: string): Promise<{ executionName: string }>;
}

export class WorkflowsOrchestrator implements PipelineOrchestrator {
  constructor(
    private readonly projectId: string,
    private readonly region: string,
    private readonly workflowName: string,
    private readonly tokenProvider: AccessTokenProvider = new MetadataAccessTokenProvider(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!projectId || !region || !workflowName) {
      throw new Error("Workflow project, region and name are required.");
    }
  }

  async start(runId: string): Promise<{ executionName: string }> {
    const response = await this.fetchImplementation(
      `https://workflowexecutions.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.region)}/workflows/${encodeURIComponent(this.workflowName)}/executions`,
      {
        body: JSON.stringify({
          argument: JSON.stringify({ runId }),
        }),
        headers: {
          authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1_000);
      throw new Error(
        `Workflow execution creation failed with status ${response.status}: ${body}`,
      );
    }

    const result = (await response.json()) as { name?: unknown };
    if (typeof result.name !== "string" || !result.name) {
      throw new Error("Workflow execution creation returned no execution name.");
    }
    return { executionName: result.name };
  }
}
