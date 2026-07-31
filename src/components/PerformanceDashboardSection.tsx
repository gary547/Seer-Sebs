import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  ResponsiveContainer, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { TrendingUp, Target, PoundSterling, BarChart3, Link2, HelpCircle, Sparkles, Loader2, ChevronDown } from "lucide-react";
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import SyncStaleBanner from "./SyncStaleBanner";
import { toast } from "sonner";
import {
  generateProjectRoadmap,
  listAllProjectForecastRows,
  listProjectRoadmaps,
} from "@/integrations/gcp/calculations";
import {
  getProjectData,
  listAllProjectKeywords,
} from "@/integrations/gcp/project-data";

interface Props {
  projectId: string;
}

const OPP_COLORS: Record<string, string> = {
  maintain: "hsl(var(--signal))",
  improve: "hsl(var(--cat-navy))",
  grow: "hsl(var(--signal-3))",
  opportunity: "hsl(var(--signal-2))",
};

const TP_COLORS = [
  { range: "1–3",   color: "hsl(var(--signal))" },
  { range: "4–6",   color: "hsl(var(--signal) / 0.75)" },
  { range: "7–10",  color: "hsl(var(--signal-3))" },
  { range: "11–15", color: "hsl(var(--signal-3) / 0.7)" },
  { range: "16–20", color: "hsl(var(--signal-2))" },
  { range: "N/A",   color: "hsl(var(--ink-subtle))" },
];

function getTpBucket(har: number | null): string {
  if (har == null) return "N/A";
  if (har <= 3) return "1–3";
  if (har <= 6) return "4–6";
  if (har <= 10) return "7–10";
  if (har <= 15) return "11–15";
  return "16–20";
}

const fmtCurrency = (v: number) =>
  `£${v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const PRIORITY_LABELS: Record<number, string> = { 1: "Primary", 2: "Secondary", 3: "Tertiary" };

const ROADMAP_FIELD_LABELS: Record<string, string> = {
  target: "Target",
  rank: "Rank",
  revenue: "Revenue",
  evidence: "Evidence",
  action: "Action",
  "expected impact": "Impact",
};

const cleanMarkdown = (text: string) => text.replace(/\*\*/g, "").replace(/^#+\s*/, "").trim();

function renderInlineMarkdown(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function RoadmapContent({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n").map((line) => line.trim()).filter(Boolean);

  return (
    <div className="space-y-3">
      {lines.map((line, index) => {
        const headingMatch = line.match(/^#{1,3}\s*(?:\d+\.\s*)?(.*)$/);
        if (headingMatch) {
          const title = cleanMarkdown(headingMatch[1]);
          if (!title) return null;
          if (line.startsWith("###")) {
            const actionNumber = lines.slice(0, index + 1).filter((item) => item.startsWith("###")).length;
            return (
              <div key={index} className="mt-5 flex items-center gap-3 border-t pt-4 first:mt-0 first:border-t-0 first:pt-0">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
                  {actionNumber}
                </span>
                <h5 className="text-base font-semibold leading-snug">{title}</h5>
              </div>
            );
          }
          return <h5 key={index} className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h5>;
        }

        const labelledSegments = line.split("|").map((part) => part.trim()).filter(Boolean);
        if (labelledSegments.length > 1) {
          return (
            <div key={index} className="flex flex-wrap gap-2">
              {labelledSegments.map((segment, segmentIndex) => {
                const [rawLabel, ...valueParts] = cleanMarkdown(segment).split(":");
                const label = ROADMAP_FIELD_LABELS[rawLabel.toLowerCase()] ?? rawLabel;
                const value = valueParts.join(":").trim();
                return (
                  <span key={segmentIndex} className="rounded-md border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{label}</span>{value ? `: ${value}` : ""}
                  </span>
                );
              })}
            </div>
          );
        }

        const fieldMatch = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);
        if (fieldMatch) {
          const label = ROADMAP_FIELD_LABELS[fieldMatch[1].toLowerCase()] ?? fieldMatch[1];
          return (
            <div key={index} className="rounded-md bg-muted/30 p-3 text-sm leading-6">
              <span className="font-semibold text-foreground">{label}: </span>
              <span className="text-muted-foreground">{renderInlineMarkdown(fieldMatch[2])}</span>
            </div>
          );
        }

        return <p key={index} className="text-sm leading-6 text-muted-foreground">{renderInlineMarkdown(cleanMarkdown(line))}</p>;
      })}
    </div>
  );
}

export default function PerformanceDashboardSection({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [isGeneratingRoadmap, setIsGeneratingRoadmap] = useState(false);
  const [isRoadmapOpen, setIsRoadmapOpen] = useState(true);
  const [roadmapTab, setRoadmapTab] = useState<"latest" | "history">("latest");
  const [historySearch, setHistorySearch] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const { data: forecasts = [], isLoading } = useQuery({
    queryKey: ["keyword_forecasts", projectId],
    queryFn: async () => {
      const rows = await listAllProjectForecastRows(projectId);
      return rows.map((row) => ({
        est_current_clicks_annual:
          (row.annualVolume ?? 0) * (row.ctrNow ?? 0),
        est_current_revenue_annual: row.currentRevenueAnnual,
        har: row.harPosition,
        har_revenue_gain_annual: row.expectedIncrementalAnnual,
        keywords: {
          avg_monthly_volume: row.averageMonthlyVolume,
          base_rank: row.baseRank,
          device: row.device,
          keyword: row.keyword,
          keyword_priority: row.keywordPriority,
          ranking_url: row.rankingUrl,
          search_intent: row.searchIntent,
        },
        opportunity: row.opportunity,
        yearly_revenue_gain_rank1: row.targetIncrementalRevenueAnnual,
        yearly_traffic_gain_rank1: row.trafficGainAnnual,
      }));
    },
  });

  // Total kept keywords for this project (incl. ones DataForSEO returned no
  // SERP match for and that are therefore excluded from forecasts/charts).
  const { data: keptStats } = useQuery({
    queryKey: ["dashboard_kept_stats", projectId],
    queryFn: async () => {
      const rows = await listAllProjectKeywords(projectId, {
        detoxStatus: "keep",
      });
      return {
        kept: rows.length,
        unranked: rows.filter((row) => row.baseRank === null).length,
      };
    },
  });
  const { data: clientMetrics } = useQuery({
    queryKey: ["client_domain_metrics", projectId],
    queryFn: async () => {
      const project = await getProjectData(projectId);
      return project.authorityMetrics
        ? {
            domain_rating: project.authorityMetrics.domainRating,
            url_rating: project.authorityMetrics.urlRating,
          }
        : null;
    },
  });

  const { data: harResults = [] } = useQuery({
    queryKey: ["har_results_link_profile", projectId],
    queryFn: async () => {
      const rows = await listAllProjectForecastRows(projectId);
      return rows.map((row) => ({
        client_url_rating: row.clientUrlRating,
        har_competitor_ur: row.competitorUrlRating,
      }));
    },
  });

  const { data: roadmapHistory } = useQuery({
    queryKey: ["project_roadmap_history", projectId],
    queryFn: async () => {
      const roadmaps = await listProjectRoadmaps(projectId);
      return roadmaps.map((roadmap) => ({
        generated_at: roadmap.generatedAt,
        id: roadmap.id,
        roadmap_markdown: roadmap.roadmapMarkdown,
        synced_at: roadmap.syncedAt,
      }));
    },
  });

  const roadmap = roadmapHistory?.[0] ?? null;


  const linkProfile = useMemo(() => {
    const competitorUrs = harResults
      .map((r: any) => r.har_competitor_ur)
      .filter((v: any): v is number => typeof v === "number");
    if (competitorUrs.length === 0) return null;
    const sorted = [...competitorUrs].sort((a, b) => a - b);
    const medianUr = sorted[Math.floor(sorted.length / 2)];
    const avgClientUr = harResults
      .map((r: any) => r.client_url_rating)
      .filter((v: any): v is number => typeof v === "number")
      .reduce((a, b, _, arr) => a + b / arr.length, 0);

    const clientDr = clientMetrics?.domain_rating ?? null;
    const clientUr = clientMetrics?.url_rating ?? avgClientUr ?? null;
    const delta = clientUr != null ? clientUr - medianUr : null;

    let band: "parity" | "stretch" | "gap" = "parity";
    if (delta != null) {
      if (delta < -15) band = "gap";
      else if (delta < -5) band = "stretch";
    }

    let headline = "";
    if (clientUr == null) {
      headline = "Run TP calculation to see how your link strength compares to competitors.";
    } else if (band === "gap") {
      headline = `Your link strength (${Math.round(clientUr)}) is behind the typical competitor (${Math.round(medianUr)}) — closing this gap is the biggest unlock.`;
    } else if (band === "stretch") {
      headline = `Your link strength (${Math.round(clientUr)}) is slightly behind the typical competitor (${Math.round(medianUr)}) on top-tier keywords.`;
    } else {
      headline = `Your link strength (${Math.round(clientUr)}) matches the typical competitor (${Math.round(medianUr)}) — content & relevance are the main levers.`;
    }

    return { clientDr, clientUr: Math.round(clientUr), medianUr: Math.round(medianUr), delta, band, headline, sampleSize: competitorUrs.length };
  }, [harResults, clientMetrics]);

  const stats = useMemo(() => {
    if (!forecasts.length) return null;

    let totalCurrentRevenue = 0;
    let totalRevenueGainRank1 = 0;
    let totalHarRevenueGain = 0;
    let totalCurrentClicks = 0;
    let totalTrafficGainRank1 = 0;
    let harCount = 0;

    const oppCounts: Record<string, { count: number; revenue: number }> = {};
    const harBuckets: Record<string, number> = {};
    const intentRevenue: Record<string, number> = {};
    const priorityRevenue: Record<number, { count: number; revenue: number }> = {
      1: { count: 0, revenue: 0 },
      2: { count: 0, revenue: 0 },
      3: { count: 0, revenue: 0 },
    };

    for (const f of forecasts) {
      totalCurrentRevenue += f.est_current_revenue_annual ?? 0;
      totalRevenueGainRank1 += f.yearly_revenue_gain_rank1 ?? 0;
      totalHarRevenueGain += f.har_revenue_gain_annual ?? 0;
      totalCurrentClicks += f.est_current_clicks_annual ?? 0;
      totalTrafficGainRank1 += f.yearly_traffic_gain_rank1 ?? 0;

      const opp = f.opportunity || "opportunity";
      if (!oppCounts[opp]) oppCounts[opp] = { count: 0, revenue: 0 };
      oppCounts[opp].count++;
      oppCounts[opp].revenue += f.yearly_revenue_gain_rank1 ?? 0;

      const bucket = getTpBucket(f.har);
      harBuckets[bucket] = (harBuckets[bucket] || 0) + 1;
      if (f.har != null) harCount++;

      const intent = f.keywords?.search_intent || "unknown";
      intentRevenue[intent] = (intentRevenue[intent] || 0) + (f.yearly_revenue_gain_rank1 ?? 0);

      const priority = f.keywords?.keyword_priority;
      if (priority === 1 || priority === 2 || priority === 3) {
        priorityRevenue[priority].count++;
        priorityRevenue[priority].revenue += f.har_revenue_gain_annual ?? 0;
      }
    }

    const oppData = Object.entries(oppCounts).map(([name, { count, revenue }]) => ({
      name, count, revenue,
    }));

    const harData = TP_COLORS.map(({ range, color }) => ({
      name: range, value: harBuckets[range] || 0, fill: color,
    })).filter(d => d.value > 0);

    const intentData = Object.entries(intentRevenue)
      .map(([name, revenue]) => ({ name, revenue: Math.round(revenue) }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      totalKeywords: forecasts.length,
      totalCurrentRevenue,
      totalRevenueGainRank1,
      totalHarRevenueGain,
      totalCurrentClicks,
      totalTrafficGainRank1,
      harCount,
      oppData,
      harData,
      intentData,
      priorityData: [1, 2, 3].map((priority) => ({
        priority,
        label: PRIORITY_LABELS[priority],
        count: priorityRevenue[priority].count,
        revenue: priorityRevenue[priority].revenue,
      })),
    };
  }, [forecasts]);

  const handleGenerateRoadmap = async () => {
    setIsGeneratingRoadmap(true);
    try {
      await generateProjectRoadmap(projectId);
      await queryClient.invalidateQueries({ queryKey: ["project_roadmap_history", projectId] });
      toast.success("Roadmap generated");
    } catch (err: any) {
      toast.error(err.message || "Roadmap generation failed");
    } finally {
      setIsGeneratingRoadmap(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-lg">Performance Dashboard</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading…</p></CardContent>
      </Card>
    );
  }

  if (!stats) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-accent" />
          Performance Dashboard
        </CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Run forecasts first to see the dashboard.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-accent" />
          Performance Dashboard
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SyncStaleBanner
          projectId={projectId}
          message="Dashboard reflects the last successful sync. Press Sync Now in the header to refresh."
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard
            icon={<Target className="h-4 w-4" />}
            label="TP Revenue"
            value={fmtCurrency(stats.totalHarRevenueGain)}
            sub={`${stats.harCount} of ${stats.totalKeywords} with TP`}
            accent
            featured
            help="Forecasted annual revenue if every keyword performs at its Top Potential position — the realistic ceiling set by your link strength vs competitors."
          />
          <SummaryCard
            icon={<PoundSterling className="h-4 w-4" />}
            label="Current Revenue/yr"
            value={fmtCurrency(stats.totalCurrentRevenue)}
            help="Estimated annual revenue from your kept keywords at their current rankings."
          />
          <SummaryCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Revenue Uplift (#1)"
            value={fmtCurrency(stats.totalRevenueGainRank1)}
            help="Total extra annual revenue if every keyword reached position 1."
          />
          <SummaryCard
            icon={<BarChart3 className="h-4 w-4" />}
            label="Total Keywords"
            value={(keptStats?.kept ?? stats.totalKeywords).toLocaleString()}
            sub={
              keptStats && keptStats.unranked > 0
                ? `${stats.totalKeywords} forecasted · ${keptStats.unranked} unranked`
                : `${stats.totalTrafficGainRank1.toLocaleString()} traffic gain`
            }
            help="All kept keywords. 'Forecasted' = with rank data. 'Unranked' = not currently ranking and excluded from forecasts."
          />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <h4 className="text-sm font-semibold">Revenue Opportunity by Keyword Priority</h4>
            <TooltipProvider>
              <UITooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Uses TP Revenue for keywords marked Primary, Secondary, or Tertiary.
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {stats.priorityData.map((item) => (
              <div key={item.priority} className="rounded-lg border p-4 bg-muted/20">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                  <Badge variant="secondary" className="text-[10px]">P{item.priority}</Badge>
                </div>
                <p className="text-2xl type-display">{fmtCurrency(item.revenue)}</p>
                <p className="text-xs text-muted-foreground mt-1">{item.count} keywords</p>
              </div>
            ))}
          </div>
        </div>

        <div id="roadmap" className="scroll-mt-24">
        <Collapsible open={isRoadmapOpen} onOpenChange={setIsRoadmapOpen} className="rounded-lg border bg-card">
          <div className="flex items-start justify-between gap-4 mb-3">
            <CollapsibleTrigger asChild>
              <button type="button" className="group flex flex-1 items-start gap-3 p-4 text-left">
                <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
                <div>
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <span className="rounded-md bg-accent/10 p-1 text-accent">
                  <Sparkles className="h-4 w-4" />
                </span>
                Roadmap to Success
              </h4>
              {roadmap?.generated_at && (
                <p className="text-xs text-muted-foreground mt-1">
                  Generated {new Date(roadmap.generated_at).toLocaleString("en-GB")}
                </p>
              )}
                </div>
              </button>
            </CollapsibleTrigger>
            <Button size="sm" variant="outline" className="m-4 ml-0" onClick={handleGenerateRoadmap} disabled={isGeneratingRoadmap}>
              {isGeneratingRoadmap ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {roadmap ? "Refresh Roadmap" : "Generate Roadmap"}
            </Button>
          </div>
          <CollapsibleContent className="px-4 pb-4">
            {roadmap?.roadmap_markdown ? (
              <Tabs value={roadmapTab} onValueChange={(v) => setRoadmapTab(v as "latest" | "history")}>
                <TabsList>
                  <TabsTrigger value="latest">Latest</TabsTrigger>
                  <TabsTrigger value="history">
                    History {roadmapHistory && roadmapHistory.length > 1 ? `(${roadmapHistory.length})` : ""}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="latest" className="mt-3">
                  <div className="rounded-lg border bg-background/60 p-4">
                    <RoadmapContent markdown={roadmap.roadmap_markdown} />
                  </div>
                </TabsContent>

                <TabsContent value="history" className="mt-3">
                  {(() => {
                    const all = roadmapHistory ?? [];
                    const q = historySearch.trim().toLowerCase();
                    const filtered = q
                      ? all.filter(
                          (r) =>
                            r.roadmap_markdown.toLowerCase().includes(q) ||
                            new Date(r.generated_at).toLocaleString("en-GB").toLowerCase().includes(q),
                        )
                      : all;
                    const selected =
                      filtered.find((r) => r.id === selectedHistoryId) ?? filtered[0] ?? null;

                    return (
                      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
                        <div className="space-y-2">
                          <Input
                            placeholder="Search roadmaps…"
                            value={historySearch}
                            onChange={(e) => setHistorySearch(e.target.value)}
                            className="h-8"
                          />
                          <div className="h-[420px] overflow-y-auto rounded-md border">
                            <ul className="divide-y">
                              {filtered.length === 0 && (
                                <li className="p-3 text-xs text-muted-foreground">No matches.</li>
                              )}
                              {filtered.map((r) => {
                                const isActive = selected?.id === r.id;
                                return (
                                  <li key={r.id}>
                                    <button
                                      type="button"
                                      onClick={() => setSelectedHistoryId(r.id)}
                                      className={`w-full px-3 py-2 text-left text-xs transition-colors ${
                                        isActive ? "bg-accent/10 text-foreground" : "hover:bg-muted/50"
                                      }`}
                                    >
                                      <div className="font-medium">
                                        {new Date(r.generated_at).toLocaleString("en-GB")}
                                      </div>
                                      <div className="mt-1 line-clamp-2 text-muted-foreground">
                                        {r.roadmap_markdown.replace(/[#*`>_-]/g, "").slice(0, 120)}
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </div>
                        <div className="rounded-lg border bg-background/60 p-4">
                          {selected ? (
                            <>
                              <p className="mb-3 text-xs text-muted-foreground">
                                Generated {new Date(selected.generated_at).toLocaleString("en-GB")}
                              </p>
                              <RoadmapContent markdown={selected.roadmap_markdown} />
                            </>
                          ) : (
                            <p className="text-sm text-muted-foreground">Select a roadmap to view.</p>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </TabsContent>
              </Tabs>
            ) : (
              <p className="text-sm text-muted-foreground">
                Assign keyword priorities, sync the project, then generate a strategic roadmap from TP opportunity, site architecture, and link gaps.
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
        </div>

        {/* Link Profile Card */}
        {linkProfile && (
          <div
            className={`rounded-lg border p-4 flex items-start gap-4 ${
              linkProfile.band === "gap"
                ? "border-[hsl(var(--signal-2))]/30 bg-[hsl(var(--signal-2))]/5"
                : linkProfile.band === "stretch"
                ? "border-[hsl(var(--signal-3))]/30 bg-[hsl(var(--signal-3))]/5"
                : "border-[hsl(var(--signal))]/30 bg-[hsl(var(--signal))]/5"
            }`}
          >
            <div
              className={`shrink-0 rounded-md p-2 ${
                linkProfile.band === "gap"
                  ? "bg-[hsl(var(--signal-2))]/15 text-[hsl(var(--signal-2))]"
                  : linkProfile.band === "stretch"
                  ? "bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))]"
                  : "bg-[hsl(var(--signal))]/15 text-[hsl(var(--signal))]"
              }`}
            >
              <Link2 className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h4 className="text-sm font-semibold">Link Profile</h4>
                <span
                  className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                    linkProfile.band === "gap"
                      ? "bg-[hsl(var(--signal-2))]/15 text-[hsl(var(--signal-2))]"
                      : linkProfile.band === "stretch"
                      ? "bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))]"
                      : "bg-[hsl(var(--signal))]/15 text-[hsl(var(--signal))]"
                  }`}
                >
                  {linkProfile.band === "gap" ? "Behind" : linkProfile.band === "stretch" ? "Slightly behind" : "Matched"}
                </span>
              </div>
              <p className="text-sm text-foreground mb-2">{linkProfile.headline}</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Your link strength: <strong className="text-foreground">{linkProfile.clientUr}</strong>
                </span>
                {linkProfile.clientDr != null && (
                  <span>
                    Your domain strength: <strong className="text-foreground">{Math.round(linkProfile.clientDr)}</strong>
                  </span>
                )}
                <span>
                  Typical competitor link strength: <strong className="text-foreground">{linkProfile.medianUr}</strong>
                </span>
                <span>
                  vs typical: <strong className="text-foreground">{linkProfile.delta! >= 0 ? "+" : ""}{linkProfile.delta}</strong>
                </span>
                <span>Sample: {linkProfile.sampleSize} keywords</span>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Opportunity Breakdown */}
          <div>
            <h4 className="text-sm font-semibold mb-3">Opportunity Classification</h4>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={stats.oppData}
                    dataKey="count"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                    label={({ name, value }) => `${name} (${value})`}
                    style={{ fontSize: 9 }}
                  >
                    {stats.oppData.map((d) => (
                      <Cell key={d.name} fill={OPP_COLORS[d.name] || "hsl(var(--muted))"} stroke="hsl(var(--canvas))" strokeWidth={1} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => v.toLocaleString()} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* TP Distribution */}
          <div>
            <h4 className="text-sm font-semibold mb-3">TP Distribution</h4>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.harData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                   <XAxis type="number" tick={{ fontSize: 9 }} />
                   <YAxis type="category" dataKey="name" width={50} tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v: number) => `${v} keywords`} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {stats.harData.map((d, i) => (
                      <Cell key={i} fill={d.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Revenue by Intent */}
          <div>
            <h4 className="text-sm font-semibold mb-3">Revenue Uplift by Intent</h4>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.intentData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                   <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                   <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v: number) => fmtCurrency(v)} />
                  <Bar dataKey="revenue" fill="hsl(var(--signal))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Opportunity Revenue Table */}
        <div>
          <h4 className="text-sm font-semibold mb-3">Revenue by Opportunity</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {stats.oppData.map((d) => (
              <div key={d.name} className="rounded-lg border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: OPP_COLORS[d.name] }} />
                  <span className="text-xs text-muted-foreground capitalize">{d.name}</span>
                </div>
                <p className="text-lg font-bold">{fmtCurrency(d.revenue)}</p>
                <p className="text-xs text-muted-foreground">{d.count} keywords</p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryCard({ icon, label, value, sub, accent, featured, help }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; accent?: boolean; featured?: boolean; help?: string;
}) {
  return (
    <div className={`rounded-lg border p-4 ${featured ? "border-accent/50 bg-accent/10 shadow-sm" : ""}`}>
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs flex items-center gap-1">
          {label}
          {help && (
            <TooltipProvider>
              <UITooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">{help}</TooltipContent>
              </UITooltip>
            </TooltipProvider>
          )}
        </span>
      </div>
      <p className={`text-xl type-display ${accent ? "text-accent" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
