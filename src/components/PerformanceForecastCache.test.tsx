import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import PerformanceDashboardSection from "./PerformanceDashboardSection";
import PerformanceOutputSection from "./PerformanceOutputSection";
import { listAllProjectForecastRows, type ForecastRow } from "@/integrations/gcp/calculations";
import { selectPerformanceForecasts } from "@/hooks/useProjectForecasts";

vi.mock("@/integrations/gcp/calculations", () => ({
  listAllProjectForecastRows: vi.fn(), listProjectRoadmaps: vi.fn(async () => []), generateProjectRoadmap: vi.fn(),
}));
vi.mock("@/integrations/gcp/project-data", () => ({
  listAllProjectKeywords: vi.fn(async () => [{ id: "query-1", text: "sample query", avgMonthlyVolume: 100, baseRank: 7 }]),
  getProjectData: vi.fn(async () => ({ authorityMetrics: null })),
}));
vi.mock("./SyncStaleBanner", () => ({ default: () => null }));
vi.mock("./CalculationExportButton", () => ({ default: () => null }));
vi.mock("@/hooks/useRecomputeForecasts", () => ({ useRecomputeForecasts: () => ({ recompute: vi.fn() }) }));
vi.mock("recharts", () => ({
  ResponsiveContainer: () => null, BarChart: () => null, Bar: () => null, PieChart: () => null,
  Pie: () => null, Cell: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
  Legend: () => null, CartesianGrid: () => null,
}));

const forecast: ForecastRow = {
  annualVolume: 1200, averageMonthlyVolume: 100, baseRank: 7, clientUrlRating: 50,
  competitorUrl: null, competitorUrlRating: 48, contentFitScore: 0.8, contentStatus: "green",
  ctrNow: 0.025, ctrTarget: 0.1, currentRevenueAnnual: 300, device: "all",
  expectedIncrementalAnnual: 600, expectedIncrementalHighAnnual: 800, expectedIncrementalLowAnnual: 400,
  explanation: {}, harConfidence: 0.8, harPosition: 3, keyword: "sample query", keywordId: "query-1",
  keywordPriority: 1, linkPowerScore: 50, monthlyRevenue: {}, opportunity: "improve",
  rankAttainmentProbability: 0.8, rankingUrl: null, relevancyScore: 0.8, scenario: "realistic",
  searchIntent: "informational", tacticalStatus: "optimise_content", targetAbsoluteRevenueAnnual: 900,
  targetIncrementalRevenueAnnual: 600, trafficGainAnnual: 90, volumeForward: 1200,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared performance forecast cache", () => {
  it.each(["dashboard", "output", "gsc-estimate"] as const)("preserves UI and original CSV fields when %s loads first", async (first) => {
    const input = first === "gsc-estimate" ? { ...forecast, explanation: { volumeSource: "gsc_impressions" } } : forecast;
    vi.mocked(listAllProjectForecastRows).mockReset().mockResolvedValue([input]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const view = (both: boolean) => <QueryClientProvider client={client}><MemoryRouter>
      {(both || first !== "output") && <PerformanceDashboardSection projectId="project-1" />}
      {(both || first === "output") && <PerformanceOutputSection projectId="project-1" />}
    </MemoryRouter></QueryClientProvider>;
    const { rerender } = render(view(false));
    await waitFor(() => expect(client.getQueryData(["keyword_forecasts", "project-1"])).toEqual([input]));
    rerender(view(true));
    const row = (await screen.findByText("sample query")).closest("tr")!;
    expect(within(row).getByText("2.5%")).toBeInTheDocument();
    if (first === "gsc-estimate") expect(within(row).getByText("GSC estimate")).toBeInTheDocument();
    expect(screen.getByText("1 forecasted")).toBeInTheDocument();
    expect(screen.queryByText(/1 forecasted · 1 unranked/)).not.toBeInTheDocument();
    expect(listAllProjectForecastRows).toHaveBeenCalledTimes(1);

    const createUrl = vi.fn((_blob: Blob) => "blob:test");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.keyDown(screen.getByRole("button", { name: /Export CSV/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export all (1)" }));
    const blob = createUrl.mock.calls[0]![0] as Blob;
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob);
    });
    expect(csv.split("\n")[0]).toBe("Keyword,Device,Volume,Position,Opportunity,Intent,CTR%,Est Clicks/yr,Est Revenue/yr,Traffic Gain #1/yr,Revenue Gain #1/yr,TP,TP Traffic Gain/yr,TP Revenue Gain/yr");
    expect(csv.split("\n")[1]).toBe(`sample query,all,${first === "gsc-estimate" ? "100 (GSC estimate)" : "100"},7,improve,informational,2.5,30,300,90,600,3,90,600`);
    client.clear();
  });

  it("preserves verified zeros, null targets and priority in every consumer", () => {
    const [row] = selectPerformanceForecasts([{ ...forecast, ctrNow: 0, trafficGainAnnual: 0, harPosition: null, expectedIncrementalAnnual: 0 }]);
    expect(row).toMatchObject({ current_ctr_pct: 0, har_traffic_gain_annual: 0, har: null,
      har_revenue_gain_annual: 0, keyword_id: "query-1", keywords: { id: "query-1", keyword_priority: 1 } });
  });
});
