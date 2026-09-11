import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import CalculationsPage from "./CalculationsPage";
import { getProjectCalculationControl } from "@/integrations/gcp/calculation-control";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ canManageUsers: true }) }));
vi.mock("@/components/admin/CalculationControlPanels", () => ({ default: () => <div>Input diagnostics</div>, CalculationSummaryPanels: () => <div>Independent CTR curves</div> }));
vi.mock("@/components/admin/CalculationInspectors", () => ({ default: () => <div>Independent HAR and revenue inspectors</div> }));
vi.mock("@/components/admin/AutonomousPipelinePanel", () => ({ default: () => <div>Pipeline activity</div> }));
vi.mock("@/components/CalculationExportButton", () => ({ default: () => null }));
vi.mock("@/integrations/gcp/tenancy", () => ({ listProjects: async () => [{ id: "project", project_name: "Large test", client_id: "client" }], updateClientBrandTerms: vi.fn() }));
vi.mock("@/integrations/gcp/calculation-control", () => ({ getProjectCalculationControl: vi.fn() }));
vi.mock("@/integrations/gcp/calculations", () => ({
  getProjectCalculationSummary: async () => ({ runId: "small-previous", revenue: [], har: [] }),
  getProjectCtrCurves: async () => ({ runId: "small-previous", curves: [] }),
}));
vi.mock("@/integrations/gcp/pipeline", () => ({
  getLatestProjectPipelineRun: async () => ({ run: { id: "large-latest", status: "failed", stages: [] } }),
  getProjectPipelineReadiness: async () => ({}), resolvePipelineFailure: () => null,
  markProjectKeywordsPrecurated: vi.fn(), startProjectPipeline: vi.fn(), updateProjectPipelinePolicy: vi.fn(),
}));

let client: QueryClient;
afterEach(() => { cleanup(); client.clear(); vi.clearAllMocks(); });
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><CalculationsPage /></MemoryRouter></QueryClientProvider>);
}
describe("Independent calculation panels", () => {
  it("keeps result inspectors visible when input diagnostics fail and identifies previous-run data", async () => {
    vi.mocked(getProjectCalculationControl).mockRejectedValue(new Error("HTTP 500"));
    show();
    await waitFor(() => {
      expect(screen.getByText("Input diagnostics could not be loaded")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry input diagnostics" })).toBeEnabled();
    });
    expect(screen.getByText("Independent CTR curves")).toBeInTheDocument();
    expect(screen.getByText("Independent HAR and revenue inspectors")).toBeInTheDocument();
    expect(screen.getByText("Displayed results are from an earlier completed run")).toBeInTheDocument();
    expect(screen.getByText(/Latest run large-la is failed; these are not its final outputs/)).toBeInTheDocument();
    expect(screen.queryByText("HTTP 500")).not.toBeInTheDocument();
  });
  it("does not block available inspectors behind an unfinished controls request", async () => {
    vi.mocked(getProjectCalculationControl).mockImplementation(() => new Promise(() => {}));
    show();
    expect(await screen.findByText("Independent CTR curves")).toBeInTheDocument();
    expect(screen.getByText("Independent HAR and revenue inspectors")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Completed result panels load independently");
  });
});
