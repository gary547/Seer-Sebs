import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, HelpCircle as HelpCircleIcon, Info, Minus, ShieldCheck, Star, Target, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getClient,
  getProjectSummary,
} from "@/integrations/gcp/tenancy";
import { getProjectCtrCurves } from "@/integrations/gcp/calculations";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";
import { listAllProjectSerpResults } from "@/integrations/gcp/serp";

interface Props {
  projectId: string;
  clientDomain: string;
}

const FALLBACK_CTR_BY_RANK: Record<number, number> = {
  1: 0.28,
  2: 0.15,
  3: 0.11,
  4: 0.08,
  5: 0.06,
  6: 0.04,
  7: 0.03,
  8: 0.025,
  9: 0.02,
  10: 0.015,
};

// Link strength bands (matching Performance Output thresholds)
const parityBand = (delta: number): { label: string; color: string } => {
  if (delta >= -5) return { label: "Matched", color: "hsl(var(--signal))" };
  if (delta >= -15) return { label: "Slightly behind", color: "hsl(var(--signal-3))" };
  return { label: "Behind", color: "hsl(var(--signal-2))" };
};

const median = (arr: number[]) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
};

const normalizeDomain = (domain: string | null | undefined) =>
  (domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim();

type LeaderboardRow = {
  domain: string;
  fullDomain: string;
  score: number;
  delta: number;
  gap: number;
  overlap: number;
  medianRefDelta: number;
  status: "Stronger" | "Matched" | "Weaker";
  priority: "High" | "Medium" | "Low" | "Neutral";
  isDirectCompetitor: boolean;
};

const getPriority = (delta: number): LeaderboardRow["priority"] => {
  if (delta <= 1) return "Neutral";
  if (delta >= 7) return "High";
  if (delta >= 3) return "Medium";
  return "Low";
};

const getActionLabel = (row: LeaderboardRow) => {
  if (row.status === "Stronger") {
    if (row.priority === "High") return "Priority: High PR Opportunity";
    if (row.priority === "Medium") return "Build authority to close the gap";
    return "Monitor as a lower-gap authority target";
  }
  if (row.status === "Matched") return "Quick-win target — small authority gap";
  return "Defend your lead";
};

export default function CompetitorLandscapeReport({ projectId, clientDomain }: Props) {
  const domainNorm = normalizeDomain(clientDomain);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const { data: projectClient } = useQuery({
    queryKey: ["competitor_landscape_project_client", projectId],
    queryFn: () => getProjectSummary(projectId),
    enabled: !!projectId,
  });

  const { data: directCompetitors = [] } = useQuery({
    queryKey: ["client_direct_competitors", projectClient?.client_id],
    queryFn: async () =>
      (await getClient(projectClient!.client_id)).competitors,
    enabled: !!projectClient?.client_id,
  });

  const directCompetitorDomains = useMemo(
    () => new Set(directCompetitors.map((competitor: any) => normalizeDomain(competitor.competitor_domain)).filter(Boolean)),
    [directCompetitors],
  );

  // Rankings (top 20) for SoV + position distribution
  const { data: rankings = [] } = useQuery({
    queryKey: ["serp_rankings_report", projectId],
    queryFn: async () => {
      const [results, keywords] = await Promise.all([
        listAllProjectSerpResults(projectId),
        listAllProjectKeywords(projectId),
      ]);
      const keywordById = new Map(
        keywords.map((keyword) => [keyword.id, keyword]),
      );
      return results.map((result) => {
        const keyword = keywordById.get(result.keywordId);
        return {
          keyword_id: result.keywordId,
          keywords: {
            avg_monthly_volume: keyword?.avgMonthlyVolume ?? 0,
            keyword: result.keyword,
            search_intent: keyword?.searchIntent ?? null,
          },
          rank_position: result.rankAbsolute,
          ranking_domain: result.domain,
          ranking_url: result.url,
        };
      });
    },
  });

  // serp_results — for UR / ref domain comparisons (this is what HAR populates)
  const { data: serpResults = [] } = useQuery({
    queryKey: ["serp_results_landscape", projectId],
    queryFn: async () =>
      (await listAllProjectSerpResults(projectId)).map((result) => ({
        domain: result.domain,
        domain_rating: result.domainRating,
        keyword_id: result.keywordId,
        rank_absolute: result.rankAbsolute,
        referring_domains: result.referringDomains,
        url_rating: result.urlRating,
      })),
  });

  const { data: ctrCurves = [] } = useQuery({
    queryKey: ["share_of_search_ctr_curves", projectId],
    queryFn: async () =>
      (await getProjectCtrCurves(projectId)).curves.flatMap((curve) =>
        curve.points
          .filter((point) => point.rank <= 10)
          .map((point) => ({
            ctr_percentage: point.ctr * 100,
            device: curve.device,
            rank_position: point.rank,
          })),
      ),
    enabled: !!projectId,
  });

  const stats = useMemo(() => {
    if (!rankings.length && !serpResults.length) return null;

    const ctrByRank = new Map<number, number>();
    for (const row of ctrCurves) {
      const rank = Number(row.rank_position);
      const ctr = Number(row.ctr_percentage ?? 0) / 100;
      if (!rank || ctr <= 0) continue;
      if (row.device === "mobile" || !ctrByRank.has(rank)) ctrByRank.set(rank, ctr);
    }
    const getCtrForRank = (rank: number) => ctrByRank.get(rank) ?? FALLBACK_CTR_BY_RANK[rank] ?? 0;

    // ── Domain visibility table (rankings-driven) ────────────────────────
    const domainAppearances: Record<string, { count: number; totalRank: number; top3: number; top10: number }> = {};
    for (const r of rankings) {
      if (r.rank_position > 20) continue;
      const d = (r.ranking_domain || "").toLowerCase().replace(/^www\./, "");
      if (!d) continue;
      if (!domainAppearances[d]) domainAppearances[d] = { count: 0, totalRank: 0, top3: 0, top10: 0 };
      domainAppearances[d].count++;
      domainAppearances[d].totalRank += r.rank_position;
      if (r.rank_position <= 3) domainAppearances[d].top3++;
      if (r.rank_position <= 10) domainAppearances[d].top10++;
    }

    // ── Per-domain link metrics from serp_results ────────────────────────
    const domainLinks: Record<string, { urs: number[]; refs: number[] }> = {};
    for (const r of serpResults) {
      const d = (r.domain || "").toLowerCase().replace(/^www\./, "");
      if (!d) continue;
      if (!domainLinks[d]) domainLinks[d] = { urs: [], refs: [] };
      if (r.url_rating != null) domainLinks[d].urs.push(Number(r.url_rating));
      if (r.referring_domains != null) domainLinks[d].refs.push(Number(r.referring_domains));
    }

    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

    // ── Link Parity: per-keyword UR delta (competitor − client), then aggregate ─
    // Group serp_results by keyword
    const byKw = new Map<string, any[]>();
    for (const r of serpResults) {
      if (!byKw.has(r.keyword_id)) byKw.set(r.keyword_id, []);
      byKw.get(r.keyword_id)!.push(r);
    }

    // For each keyword: find client UR (best client URL) and each competitor's best UR
    const competitorDeltas: Record<string, { deltas: number[]; refDeltas: number[] }> = {};
    for (const [, rows] of byKw) {
      const clientRows = rows.filter((r: any) => {
        const d = (r.domain || "").toLowerCase().replace(/^www\./, "");
        return d === domainNorm;
      });
      if (clientRows.length === 0) continue;
      const clientUR = Math.max(...clientRows.map(r => Number(r.url_rating ?? 0)));
      const clientRefs = Math.max(...clientRows.map(r => Number(r.referring_domains ?? 0)));

      // Best UR per competitor domain on this keyword
      const bestPerDomain: Record<string, { ur: number; refs: number }> = {};
      for (const r of rows) {
        const d = (r.domain || "").toLowerCase().replace(/^www\./, "");
        if (!d || d === domainNorm) continue;
        const ur = Number(r.url_rating ?? 0);
        const refs = Number(r.referring_domains ?? 0);
        if (!bestPerDomain[d] || bestPerDomain[d].ur < ur) {
          bestPerDomain[d] = { ur, refs };
        }
      }
      for (const [d, v] of Object.entries(bestPerDomain)) {
        if (!competitorDeltas[d]) competitorDeltas[d] = { deltas: [], refDeltas: [] };
        competitorDeltas[d].deltas.push(v.ur - clientUR);
        competitorDeltas[d].refDeltas.push(v.refs - clientRefs);
      }
    }

    const parityChartData = Object.entries(competitorDeltas)
      .map(([domain, { deltas, refDeltas }]) => {
        const avgDelta = avg(deltas);
        const band = parityBand(-Math.abs(avgDelta));
        // For client visualisation: positive avgDelta means competitor stronger than client.
        // Color: red if competitor stronger, green if client stronger
        return {
          domain: domain.length > 25 ? domain.slice(0, 23) + "…" : domain,
          fullDomain: domain,
          avgDelta: Number(avgDelta.toFixed(2)),
          medianRefDelta: Math.round(median(refDeltas)),
          overlap: deltas.length,
          fill: avgDelta > 2 ? "hsl(var(--signal-2))" : avgDelta < -2 ? "hsl(var(--signal))" : "hsl(var(--signal-3))",
          band: band.label,
        };
      })
      .filter(d => d.overlap >= 2) // need ≥2 overlapping keywords for signal
      .sort((a, b) => b.avgDelta - a.avgDelta)
      .slice(0, 12);

    // Client metrics summary
    const clientLinkStats = domainLinks[domainNorm]
      ? { avgUR: avg(domainLinks[domainNorm].urs), avgRefs: avg(domainLinks[domainNorm].refs) }
      : { avgUR: 0, avgRefs: 0 };

    // Domain visibility table — augment with link metrics
    const domainTable = Object.entries(domainAppearances)
      .map(([domain, d]) => {
        const links = domainLinks[domain] || { urs: [], refs: [] };
        const dAvgUR = avg(links.urs);
        const dAvgRefs = avg(links.refs);
        const urDelta = dAvgUR - clientLinkStats.avgUR;
        const band = domain === domainNorm ? { label: "—", color: "hsl(var(--muted-foreground))" } : parityBand(-Math.abs(urDelta));
        return {
          domain,
          isClient: domain === domainNorm,
          count: d.count,
          avgRank: d.count > 0 ? d.totalRank / d.count : 0,
          top3: d.top3,
          top10: d.top10,
          avgUR: dAvgUR,
          avgRefs: dAvgRefs,
          band,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Campaign Share of Search — estimated clicks from campaign rankings
    const domainClicks: Record<string, number> = {};
    for (const r of rankings) {
      if (r.rank_position > 10) continue;
      const d = (r.ranking_domain || "").toLowerCase().replace(/^www\./, "");
      if (!d) continue;
      const vol = Number(r.keywords?.avg_monthly_volume || 0);
      const estimatedClicks = vol * getCtrForRank(Number(r.rank_position));
      domainClicks[d] = (domainClicks[d] || 0) + estimatedClicks;
    }
    const totalEstimatedClicks = Object.values(domainClicks).reduce((sum, clicks) => sum + clicks, 0);
    const shareOfSearchRows = Object.entries(domainClicks)
      .map(([domain, volume]) => ({
        name: domain.length > 20 ? domain.slice(0, 18) + "…" : domain,
        fullDomain: domain,
        value: volume,
        pct: totalEstimatedClicks > 0 ? (volume / totalEstimatedClicks) * 100 : 0,
        isClient: domain === domainNorm,
      }))
      .sort((a, b) => b.value - a.value);
    const topShareOfSearchRows = shareOfSearchRows.slice(0, 9);
    const otherShareOfSearchRows = shareOfSearchRows.slice(9);
    const otherClicks = otherShareOfSearchRows.reduce((sum, row) => sum + row.value, 0);
    const shareOfSearchData = otherClicks > 0
      ? [
          ...topShareOfSearchRows,
          {
            name: "Others",
            fullDomain: "Others",
            value: otherClicks,
            pct: totalEstimatedClicks > 0 ? (otherClicks / totalEstimatedClicks) * 100 : 0,
            isClient: false,
          },
        ]
      : topShareOfSearchRows;

    return { parityChartData, domainTable, shareOfSearchData, totalEstimatedClicks, clientLinkStats };
  }, [rankings, serpResults, ctrCurves, domainNorm]);

  if (!rankings.length && !serpResults.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm space-y-2">
        <p>No competitor SERP data available.</p>
        <p className="text-xs">Run <strong>TP Calculation</strong> to populate this report — it captures organic rankings and link metrics for the top 20 competitors per keyword.</p>
      </div>
    );
  }

  if (!stats) return null;

  const baseline = Number(stats.clientLinkStats.avgUR.toFixed(1));
  const leaderboardRows: LeaderboardRow[] = stats.parityChartData.map((d: any) => {
    const delta = Number(d.avgDelta);
    const gap = Math.abs(delta);
    const status: LeaderboardRow["status"] = gap <= 1 ? "Matched" : delta > 0 ? "Stronger" : "Weaker";
    return {
      domain: d.domain,
      fullDomain: d.fullDomain,
      score: Math.max(0, Number((baseline + delta).toFixed(1))),
      delta,
      gap: Number(gap.toFixed(1)),
      overlap: d.overlap,
      medianRefDelta: d.medianRefDelta,
      status,
      priority: status === "Stronger" ? getPriority(delta) : "Neutral",
      isDirectCompetitor: directCompetitorDomains.has(normalizeDomain(d.fullDomain)),
    };
  });

  const maxLeaderboardScore = Math.max(baseline, ...leaderboardRows.map((row) => row.score), 1);
  const leaderboardGroups = [
    {
      key: "chase",
      title: "Competitors to Chase",
      description: "Sites with a stronger link profile than your current baseline.",
      rows: leaderboardRows.filter((row) => row.status === "Stronger"),
      icon: TrendingUp,
      shellClass: "border-destructive/20 bg-destructive/5",
      iconClass: "bg-destructive/10 text-destructive",
      badgeClass: "border-destructive/30 bg-destructive/10 text-destructive",
      barFill: "hsl(var(--destructive))",
    },
    {
      key: "rivals",
      title: "Close Rivals",
      description: "Sites within 1.0 point of your link strength baseline.",
      rows: leaderboardRows.filter((row) => row.status === "Matched"),
      icon: Target,
      shellClass: "border-warning/25 bg-warning/5",
      iconClass: "bg-warning/10 text-warning",
      badgeClass: "border-warning/30 bg-warning/10 text-warning",
      barFill: "hsl(var(--warning))",
    },
    {
      key: "beating",
      title: "Sites You Are Beating",
      description: "Sites where your current link strength gives you a competitive lead.",
      rows: leaderboardRows.filter((row) => row.status === "Weaker"),
      icon: ShieldCheck,
      shellClass: "border-success/20 bg-success/5",
      iconClass: "bg-success/10 text-success",
      badgeClass: "border-success/30 bg-success/10 text-success",
      barFill: "hsl(var(--success))",
    },
  ];
  const shareOfSearchRows = stats.shareOfSearchData;
  const clientShareRow = shareOfSearchRows.find((row: any) => row.isClient);
  const leaderShareRow = shareOfSearchRows[0];
  const clientSharePct = clientShareRow?.pct ?? 0;
  const leaderSharePct = leaderShareRow?.pct ?? 0;
  const shareGap = Math.max(0, leaderSharePct - clientSharePct);
  const maxSharePct = Math.max(...shareOfSearchRows.map((row: any) => row.pct), 1);
  const shareInsight = !clientShareRow
    ? "Your site is not currently capturing top-10 campaign search demand."
    : clientShareRow.fullDomain === leaderShareRow?.fullDomain
      ? "You currently lead this campaign’s organic demand capture."
      : shareGap <= 5
        ? "Small gains on priority keywords could move you into the lead."
        : "The gap is driven by competitors ranking higher on high-volume campaign keywords.";

  return (
    <div className="space-y-4">
      {/* Link strength leaderboard — primary panel */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">SEO Competitive Leaderboard</CardTitle>
              <p className="text-xs text-muted-foreground">
                A plain-English view of which competitors need authority work, which are close, and where you already lead.
              </p>
            </div>
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 lg:min-w-[280px]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your site</p>
                  <p className="text-sm font-semibold text-foreground">{clientDomain}</p>
                </div>
                <div className="text-right">
                  <div className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    Baseline Link Strength
                    <TooltipProvider>
                      <UITooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          Link Strength measures the authority and trust of the ranking URL based on backlink metrics. Higher usually means harder to outrank.
                        </TooltipContent>
                      </UITooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-2xl type-display leading-tight text-primary">{baseline.toFixed(1)}</p>
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {stats.parityChartData.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-xs">
              Need at least 2 overlapping keywords with the client to compute UR delta.
            </div>
          ) : (
            leaderboardGroups.map((group) => {
              const Icon = group.icon;
              return (
                <Collapsible
                  key={group.key}
                  open={openGroups[group.key] ?? false}
                  onOpenChange={(open) => setOpenGroups((prev) => ({ ...prev, [group.key]: open }))}
                  className={cn("rounded-lg border p-3", group.shellClass)}
                >
                  <CollapsibleTrigger asChild>
                    <button type="button" className="group flex w-full items-center justify-between gap-3 text-left">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", group.iconClass)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold leading-tight">{group.title}</h4>
                          <p className="text-xs text-muted-foreground">{group.description}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className={cn("shrink-0", group.badgeClass)}>{group.rows.length}</Badge>
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3">
                    {group.rows.length === 0 ? (
                      <div className="rounded-md border bg-card/70 px-3 py-4 text-center text-xs text-muted-foreground">
                        No competitors currently fall into this group.
                      </div>
                    ) : (
                      <div className="space-y-2">
                      {group.rows.map((row) => {
                        const StandingIcon = row.status === "Stronger" ? TrendingUp : row.status === "Matched" ? Minus : TrendingDown;
                        const standingLabel = row.status === "Stronger"
                          ? `${row.gap.toFixed(1)} points ahead`
                          : row.status === "Matched"
                            ? row.gap === 0 ? "Matched" : `${row.gap.toFixed(1)} point gap`
                            : `Your lead: ${row.gap.toFixed(1)} points`;
                        const refLabel = row.medianRefDelta === 0
                          ? "Ref. domains matched"
                          : `${Math.abs(row.medianRefDelta).toLocaleString()} ref. domains ${row.medianRefDelta > 0 ? "ahead" : "behind"}`;

                        return (
                          <div key={row.fullDomain} className="grid gap-3 rounded-md border bg-card p-3 shadow-sm lg:grid-cols-[minmax(220px,1.2fr)_160px_minmax(190px,1fr)_minmax(220px,1.1fr)] lg:items-center">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <p className="truncate text-sm font-semibold" title={row.fullDomain}>{row.fullDomain}</p>
                                {row.isDirectCompetitor && (
                                  <TooltipProvider>
                                    <UITooltip>
                                      <TooltipTrigger asChild>
                                        <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />
                                      </TooltipTrigger>
                                      <TooltipContent side="top" className="text-xs">Direct competitor from client setup</TooltipContent>
                                    </UITooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{row.overlap} overlapping keywords · {refLabel}</p>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">Link Strength</span>
                                <span className="font-semibold text-foreground">{row.score.toFixed(1)}</span>
                              </div>
                              <div className="h-4 w-full overflow-hidden rounded-full bg-muted">
                                <ResponsiveContainer width="100%" height={16}>
                                  <BarChart data={[{ name: row.fullDomain, score: row.score }]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
                                    <XAxis type="number" domain={[0, maxLeaderboardScore]} hide />
                                    <YAxis type="category" dataKey="name" hide />
                                    <Bar dataKey="score" fill={group.barFill} radius={[8, 8, 8, 8]} isAnimationActive={false} background={false} />
                                  </BarChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <StandingIcon className={cn("h-4 w-4", group.iconClass.replace("bg-", "text-").replace("/10", ""))} />
                              <span>{standingLabel}</span>
                            </div>
                            <div className="text-sm font-medium leading-snug text-muted-foreground">
                              {getActionLabel(row)}
                            </div>
                          </div>
                        );
                      })}
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Campaign Share of Search */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              <span className="inline-flex items-center gap-1">
                Campaign Share of Search
                <TooltipProvider>
                  <UITooltip>
                    <TooltipTrigger asChild><HelpCircleIcon className="h-3 w-3 opacity-50 cursor-help" /></TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">Organic, campaign-specific Share of Search: estimated clicks from tracked keyword rankings, weighted by search volume and rank CTR. This is not paid Share of Voice or pure branded-demand Share of Search.</TooltipContent>
                  </UITooltip>
                </TooltipProvider>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">Estimated share of organic clicks captured across this campaign’s tracked keywords, weighted by search volume and ranking position.</p>
            {shareOfSearchRows.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-xs">No top-10 ranking data yet.</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div className="rounded-md border bg-primary/5 p-3">
                    <p className="text-[11px] font-medium text-muted-foreground">Your share</p>
                    <p className="text-xl type-display text-primary">{clientSharePct.toFixed(1)}%</p>
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <p className="text-[11px] font-medium text-muted-foreground">Leader</p>
                    <p className="truncate text-sm font-semibold" title={leaderShareRow?.fullDomain}>{leaderShareRow?.name || "—"}</p>
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <p className="text-[11px] font-medium text-muted-foreground">Gap to leader</p>
                    <p className="text-xl type-display text-foreground">{shareGap.toFixed(1)}%</p>
                  </div>
                  <div className="rounded-md border bg-card p-3">
                    <p className="text-[11px] font-medium text-muted-foreground">Est. monthly clicks</p>
                    <p className="text-xl type-display text-foreground">{Math.round(stats.totalEstimatedClicks).toLocaleString()}</p>
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-xs font-medium text-muted-foreground">{shareInsight}</div>
                <div className="space-y-2">
                  {shareOfSearchRows.map((row: any, index: number) => (
                    <div key={row.fullDomain} className={cn("rounded-md border bg-card p-3", row.isClient && "border-primary/30 bg-primary/5")}>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">{index + 1}</span>
                          <span className="truncate text-sm font-semibold" title={row.fullDomain}>{row.fullDomain}</span>
                          {row.isClient && <Badge className="h-5 px-1.5 text-[10px]" variant="default">You</Badge>}
                          {directCompetitorDomains.has(normalizeDomain(row.fullDomain)) && (
                            <TooltipProvider>
                              <UITooltip>
                                <TooltipTrigger asChild><Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" /></TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">Direct competitor from client setup</TooltipContent>
                              </UITooltip>
                            </TooltipProvider>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold text-foreground">{row.pct.toFixed(1)}%</p>
                          <p className="text-[11px] text-muted-foreground">{Math.round(row.value).toLocaleString()} clicks</p>
                        </div>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", row.isClient ? "bg-primary" : "bg-accent")} style={{ width: `${Math.max(2, (row.pct / maxSharePct) * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Domain visibility table */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Domain Visibility</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[300px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Domain</TableHead>
                    <TableHead className="text-right text-xs">App.</TableHead>
                    <TableHead className="text-right text-xs">Avg Rank</TableHead>
                    <TableHead className="text-right text-xs">Top 10</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.domainTable.slice(0, 10).map((d: any) => (
                    <TableRow key={d.domain} className={d.isClient ? "bg-primary/5" : ""}>
                      <TableCell className="text-xs font-medium truncate max-w-[180px]" title={d.domain}>
                        {d.domain}
                        {d.isClient && <Badge className="ml-1.5 text-[10px] h-4 px-1" variant="default">You</Badge>}
                      </TableCell>
                      <TableCell className="text-right text-xs">{d.count}</TableCell>
                      <TableCell className="text-right text-xs">{d.avgRank.toFixed(1)}</TableCell>
                      <TableCell className="text-right text-xs">{d.top10}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Full domain visibility + link strength table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Domain Visibility + Link Strength</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border max-h-[400px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Appearances</TableHead>
                  <TableHead className="text-right">Avg Rank</TableHead>
                  <TableHead className="text-right">Top 3</TableHead>
                  <TableHead className="text-right">Top 10</TableHead>
                  <TableHead className="text-right">Avg link strength</TableHead>
                  <TableHead className="text-right">Avg ref. domains</TableHead>
                  <TableHead>Link strength vs your site</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.domainTable.map((d: any, i: number) => (
                  <TableRow key={d.domain} className={d.isClient ? "bg-primary/5" : ""}>
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="text-xs font-medium">
                      {d.domain}
                      {d.isClient && <Badge className="ml-2 text-[10px]" variant="default">You</Badge>}
                    </TableCell>
                    <TableCell className="text-right text-xs">{d.count}</TableCell>
                    <TableCell className="text-right text-xs">{d.avgRank.toFixed(1)}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">{d.top3}</TableCell>
                    <TableCell className="text-right text-xs">{d.top10}</TableCell>
                    <TableCell className="text-right text-xs">{d.avgUR > 0 ? d.avgUR.toFixed(1) : "—"}</TableCell>
                    <TableCell className="text-right text-xs">{d.avgRefs > 0 ? Math.round(d.avgRefs).toLocaleString() : "—"}</TableCell>
                    <TableCell>
                      {d.isClient ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] h-5"
                          style={{ borderColor: d.band.color, color: d.band.color }}
                        >
                          {d.band.label}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
