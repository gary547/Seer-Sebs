import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface CalculationControl {
  archived: boolean;
  baseRank: {
    missing: number;
    sources: Record<string, number>;
    total: number;
    withRank: number;
  };
  brandClassification: {
    brandTerms: string[];
    branded: number;
    total: number;
    unbranded: number;
    unclassified: number;
  };
  clustering: {
    canonicalBases: Record<string, number>;
    clusterCount: number;
    largestCluster: number | null;
    memberCount: number;
    multiMemberCount: number;
    topClusters: Array<{
      canonicalKeyword: string;
      clusterKey: string;
      memberCount: number;
    }>;
  };
  comparisons: {
    averageHarDelta: number | null;
    comparableHarCount: number;
    comparableRevenueCount: number;
    items: Array<{
      currentRevenueV1: number | null;
      currentRevenueV2: number | null;
      harV1: number | null;
      harV2: number | null;
      keyword: string;
      keywordId: string;
      targetIncrementalRevenueV1: number | null;
      targetIncrementalRevenueV2: number | null;
    }>;
    keywordCount: number;
  };
  contentFit: {
    averageScore: number | null;
    matched: number;
    missing: number;
    scored: number;
    total: number;
    zero: number;
    zeroRows: Array<{
      keyword: string;
      rankingUrl: string | null;
      tacticalStatus: string | null;
    }>;
  };
  demand: {
    averageCoverageMonths: number | null;
    categories: Array<{
      category: string;
      keywordCount: number;
      monthlyVolume: number;
      warningCount: number;
    }>;
    confidenceDistribution: Record<string, number>;
    samples: Array<{
      category: string;
      coverageMonths: number;
      demandWarning: boolean;
      demandWarningReason: string | null;
      keyword: string;
      keywordId: string;
      monthlyVolume: number;
      peakMonths: number[];
      seasonalityStrength: number | null;
      trendConfidence: string;
      trendDirection: string;
      trendPct: number | null;
      volatilityScore: number | null;
    }>;
    signals: number;
    trendDirections: Record<string, number>;
    warnings: number;
    warningReasons: Record<string, number>;
  };
  generatedAt: string;
  gscReadiness: {
    uploads: Array<{
      createdAt: string;
      dateRangeEnd: string | null;
      dateRangeStart: string | null;
      device: string;
      id: string;
      originalFilename: string | null;
      pageRows: number;
      queryRows: number;
      rowCount: number;
      sourceName: string;
    }>;
  };
  latestSuccessfulRun: { completedAt: string; id: string } | null;
  projectId: string;
  recentRuns: Array<{
    completedAt: string | null;
    createdAt: string;
    failureStage: string | null;
    id: string;
    startedAt: string | null;
    status: string;
  }>;
  serpVisibility: {
    averageMultiplier: number | null;
    featureCount: number;
    featureTypes: Array<{
      count: number;
      ownedCount: number;
      resultType: string;
    }>;
    keywordCount: number;
    ownedCount: number;
    samples: Array<{
      featureCount: number;
      keyword: string;
      keywordId: string;
      multiplier: number | null;
      ownedCount: number;
      resultTypes: string[];
      searchIntent: string | null;
    }>;
  };
  volumeHistory: {
    earliestMonth: string | null;
    historyRows: number;
    keptKeywords: number;
    latestMonth: string | null;
    maximumMonths: number | null;
    medianMonths: number | null;
    minimumMonths: number | null;
    sample: Array<{
      keyword: string;
      keywordId: string;
      monthCount: number;
      months: Array<{ month: string; volume: number }>;
    }>;
    with12Months: number;
    with24Months: number;
    withHistory: number;
  };
}

async function authenticatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export function getProjectCalculationControl(
  projectId: string,
): Promise<CalculationControl> {
  return authenticatedRequest(`/v1/projects/${projectId}/calculation-control`);
}

export function deleteProjectGscUpload(
  projectId: string,
  uploadId: string,
): Promise<{ deleted: boolean; projectId: string; uploadId: string }> {
  return authenticatedRequest(
    `/v1/projects/${projectId}/gsc-uploads/${uploadId}`,
    { method: "DELETE" },
  );
}
