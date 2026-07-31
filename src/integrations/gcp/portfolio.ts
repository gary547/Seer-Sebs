import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface CaptureWindowRow {
  averageMonthlyVolume: number | null;
  baseRank: number | null;
  clientId: string;
  clientName: string;
  harRevenueGain: number;
  isInCaptureWindow: boolean;
  keyword: string;
  keywordId: string;
  keywordPriority: number | null;
  monthsToPeak: number;
  peakMonth: string;
  projectId: string;
  projectName: string;
  revenueAtRank1: number;
  seasonalUrgency: number;
  weeksToPeak: number;
}

export interface PortfolioDashboardData {
  captureWindow: { items: CaptureWindowRow[] };
  projectForecasts: Array<{
    forecastClicks: number;
    keywordCount: number;
    projectId: string;
    revenueUpliftRank1: number;
    tpRevenueUplift: number;
  }>;
  roadmaps: Array<{
    generatedAt: string;
    id: string;
    projectId: string;
    roadmapMarkdown: string;
  }>;
  seasonality: Array<{
    month: number;
    projectId: string;
    volume: number;
  }>;
  urlMonitor: {
    critical: number;
    good: number;
    total: number;
    warning: number;
  };
}

async function authenticatedRequest<T>(path: string): Promise<T> {
  return seerApiRequest<T>(path, {}, await getAccessToken());
}

export async function getPortfolioDashboard(): Promise<PortfolioDashboardData> {
  return authenticatedRequest<PortfolioDashboardData>("/v1/portfolio");
}

export async function listCaptureWindowRows(
  inWindowOnly: boolean,
): Promise<CaptureWindowRow[]> {
  const result = await authenticatedRequest<{ items: CaptureWindowRow[] }>(
    `/v1/capture-window?inWindowOnly=${inWindowOnly}`,
  );
  return result.items;
}
