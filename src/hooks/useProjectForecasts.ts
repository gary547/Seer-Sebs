import { useQuery } from "@tanstack/react-query";
import { listAllProjectForecastRows, type ForecastRow } from "@/integrations/gcp/calculations";

export function selectPerformanceForecasts(rows: ForecastRow[]) {
  return rows.map((row) => ({
    client_url_rating: row.clientUrlRating,
    competitor_url_rating: row.competitorUrlRating,
    current_ctr_pct: (row.ctrNow ?? 0) * 100,
    est_current_clicks_annual: (row.annualVolume ?? 0) * (row.ctrNow ?? 0),
    est_current_revenue_annual: row.currentRevenueAnnual,
    har: row.harPosition,
    har_revenue_gain_annual: row.expectedIncrementalAnnual,
    har_traffic_gain_annual: row.trafficGainAnnual,
    keyword_id: row.keywordId,
    keywords: {
      avg_monthly_volume: row.averageMonthlyVolume,
      base_rank: row.baseRank,
      device: row.device,
      id: row.keywordId,
      keyword: row.keyword,
      keyword_priority: row.keywordPriority,
      ranking_url: row.rankingUrl,
      search_intent: row.searchIntent,
      volume_source: row.explanation.volumeSource === "gsc_impressions" ? "gsc_impressions" : null,
    },
    opportunity: row.opportunity,
    yearly_revenue_gain_rank1: row.targetIncrementalRevenueAnnual,
    yearly_traffic_gain_rank1: row.trafficGainAnnual,
  }));
}

export function useProjectForecasts(projectId: string) {
  return useQuery({
    queryKey: ["keyword_forecasts", projectId],
    queryFn: () => listAllProjectForecastRows(projectId),
    select: selectPerformanceForecasts,
  });
}
