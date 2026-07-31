import { describe, expect, it, vi } from "vitest";

import { WorkflowsOrchestrator } from "../src/workflows-orchestrator.js";

describe("Google Workflows orchestrator", () => {
  it("starts an execution with metadata credentials and the run ID", async () => {
    let requestBody = "";
    let authorization = "";
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            name: "projects/example/locations/europe-west2/workflows/seer-pipeline/executions/1",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    ) as unknown as typeof fetch;
    const tokenProvider = {
      getAccessToken: vi.fn(async () => "metadata-token"),
    };
    const orchestrator = new WorkflowsOrchestrator(
      "example-project",
      "europe-west2",
      "seer-pipeline",
      tokenProvider,
      fetchImplementation,
    );

    await expect(
      orchestrator.start("00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual({
      executionName:
        "projects/example/locations/europe-west2/workflows/seer-pipeline/executions/1",
    });
    expect(authorization).toBe("Bearer metadata-token");
    expect(JSON.parse(requestBody)).toEqual({
      argument: JSON.stringify({
        runId: "00000000-0000-4000-8000-000000000001",
      }),
    });
  });
});
