import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Copy, ExternalLink, ArrowUpDown, ChevronRight, ChevronDown, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import CompetitorBacklinkLandscape from "./CompetitorBacklinkLandscape";
import { listAllProjectForecastRows } from "@/integrations/gcp/calculations";
import {
  getProjectData,
  updateProjectKeywordPriority,
} from "@/integrations/gcp/project-data";
import { MetricHelp } from "@/components/briefing/MetricHelp";
import { LINK_BAND_DEFINITIONS } from "@/lib/metricGlossary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown as ChevDown, Info } from "lucide-react";
import { useRecomputeForecasts } from "@/hooks/useRecomputeForecasts";

interface Props {
  projectId: string;
}

type SortField = "priority" | "keyword" | "volume" | "har_position" | "client_ur" | "competitor_ur" | "base_rank" | "tp_revenue";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "achievable" | "not_achievable";
type PriorityFilter = "all" | "1" | "2" | "3" | "unassigned";

const getPriorityRank = (priority: number | null | undefined) => priority ?? 4;
const formatCurrency = (value: number | null | undefined) =>
  value == null ? "—" : `£${Math.round(value).toLocaleString("en-GB")}`;

function getHarColor(pos: number | null): string {
  if (pos === null) return "bg-[hsl(var(--ink-subtle))]";
  if (pos <= 3) return "bg-[hsl(var(--signal))]";              // teal — best
  if (pos <= 5) return "bg-[hsl(var(--signal)/0.7)]";          // teal soft
  if (pos <= 10) return "bg-[hsl(var(--signal-3))]";           // amber
  if (pos <= 15) return "bg-[hsl(var(--signal-2)/0.8)]";       // coral soft
  return "bg-[hsl(var(--signal-2))]";                          // coral — worst
}

function getHarTextColor(pos: number | null): string {
  if (pos === null) return "text-white";
  if (pos <= 3) return "text-white";
  if (pos <= 5) return "text-[hsl(var(--obsidian))]";
  if (pos <= 10) return "text-[hsl(var(--obsidian))]";
  if (pos <= 15) return "text-white";
  return "text-white";
}

export default function HarAnalysisSection({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [sortField, setSortField] = useState<SortField>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedKeyword, setExpandedKeyword] = useState<string | null>(null);
  const [priorityOverrides, setPriorityOverrides] = useState<Record<string, number | null>>({});

  const { data: clientMetrics } = useQuery({
    queryKey: ["client_domain_metrics", projectId],
    queryFn: async () => {
      const metrics = (await getProjectData(projectId)).authorityMetrics;
      return metrics
        ? {
            domain: metrics.domain,
            domain_rating: metrics.domainRating,
            fetched_at: metrics.fetchedAt,
            url_rating: metrics.urlRating,
          }
        : null;
    },
  });

  const { data: forecastData } = useQuery({
    queryKey: ["har_results", projectId],
    queryFn: async () => {
      const rows = await listAllProjectForecastRows(projectId);
      const forecastRevenueByKeyword: Record<string, number> = {};
      const harData = rows.map((row) => {
        forecastRevenueByKeyword[row.keywordId] =
          row.expectedIncrementalAnnual ?? 0;
        return {
          client_url_rating: row.clientUrlRating,
          har_competitor_ur: row.competitorUrlRating,
          har_competitor_url: row.competitorUrl,
          har_position: row.harPosition,
          keyword_id: row.keywordId,
          keywords: {
            avg_monthly_volume: row.averageMonthlyVolume,
            base_rank: row.baseRank,
            keyword: row.keyword,
            keyword_priority: row.keywordPriority,
          },
        };
      });
      return {
        forecastRevenueByKeyword,
        harData,
      };
    },
  });
  const harData = forecastData?.harData ?? [];
  const forecastRevenueByKeyword =
    forecastData?.forecastRevenueByKeyword ?? {};

  const { recompute: recomputeForecasts, isRecomputing } =
    useRecomputeForecasts(projectId);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const filteredData = useMemo(() => {
    let rows = harData;

    if (filter === "achievable") rows = rows.filter((r) => r.har_position !== null);
    if (filter === "not_achievable") rows = rows.filter((r) => r.har_position === null);

    if (priorityFilter !== "all") {
      rows = rows.filter((r) => {
        const priority = Object.prototype.hasOwnProperty.call(priorityOverrides, r.keyword_id)
          ? priorityOverrides[r.keyword_id]
          : r.keywords.keyword_priority;
        return priorityFilter === "unassigned" ? priority == null : priority === Number(priorityFilter);
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.keywords.keyword.toLowerCase().includes(q));
    }

    rows = [...rows].sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;
      switch (sortField) {
        case "priority": aVal = getPriorityRank(Object.prototype.hasOwnProperty.call(priorityOverrides, a.keyword_id) ? priorityOverrides[a.keyword_id] : a.keywords.keyword_priority); bVal = getPriorityRank(Object.prototype.hasOwnProperty.call(priorityOverrides, b.keyword_id) ? priorityOverrides[b.keyword_id] : b.keywords.keyword_priority); break;
        case "keyword": aVal = a.keywords.keyword; bVal = b.keywords.keyword; break;
        case "volume": aVal = a.keywords.avg_monthly_volume ?? 0; bVal = b.keywords.avg_monthly_volume ?? 0; break;
        case "har_position": aVal = a.har_position ?? 999; bVal = b.har_position ?? 999; break;
        case "client_ur": aVal = a.client_url_rating ?? 0; bVal = b.client_url_rating ?? 0; break;
        case "competitor_ur": aVal = a.har_competitor_ur ?? 0; bVal = b.har_competitor_ur ?? 0; break;
        case "base_rank": aVal = a.keywords.base_rank ?? 999; bVal = b.keywords.base_rank ?? 999; break;
        case "tp_revenue": aVal = forecastRevenueByKeyword[a.keyword_id] ?? 0; bVal = forecastRevenueByKeyword[b.keyword_id] ?? 0; break;
        default: aVal = 0; bVal = 0;
      }
      if (typeof aVal === "string") {
        return sortDir === "asc"
          ? aVal.localeCompare(String(bVal))
          : String(bVal).localeCompare(aVal);
      }
      const primary = sortDir === "asc"
        ? aVal - Number(bVal)
        : Number(bVal) - aVal;
      if (primary !== 0) return primary;
      return (forecastRevenueByKeyword[b.keyword_id] ?? 0) -
        (forecastRevenueByKeyword[a.keyword_id] ?? 0);
    });

    return rows;
  }, [harData, filter, priorityFilter, priorityOverrides, search, sortField, sortDir, forecastRevenueByKeyword]);

  const handleExport = () => {
    const lines = filteredData.map((r: any) =>
      `${(r.keywords as any)?.keyword ?? ""}\t${r.har_position ?? "N/A"}`
    );
    navigator.clipboard.writeText(lines.join("\n"));
    toast.success("TP positions copied — paste into Column G of Performance Output");
  };

  const handlePriorityChange = async (keywordId: string, value: string) => {
    const nextPriority =
      value === "unassigned" ? null : Number(value) as 1 | 2 | 3;
    try {
      await updateProjectKeywordPriority(projectId, nextPriority, [keywordId]);
    } catch {
      toast.error("Could not update keyword priority");
      return;
    }
    setPriorityOverrides((prev) => ({ ...prev, [keywordId]: nextPriority }));
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["project_sync_state", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["project-keywords", projectId] }),
    ]);
    toast.success("Priority changed", { description: "Sync to refresh TP ordering and dashboard breakdown." });
  };

  const SortButton = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <button
      className="flex items-center gap-1 hover:text-foreground transition-colors"
      onClick={() => toggleSort(field)}
    >
      {children}
      <ArrowUpDown className="h-3 w-3" />
    </button>
  );

  const achievableCount = harData.filter((r: any) => r.har_position !== null).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-accent" />
          TP Analysis
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          <span className="font-medium text-foreground">Top Potential (TP)</span> is the highest SERP position your link strength can realistically reach today —
          we walk the search results from rank 1 down and find the first competitor whose URL Rating you match or beat.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* How this is scored */}
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            <Info className="h-3.5 w-3.5" />
            How is link strength scored?
            <ChevDown className="h-3 w-3" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 rounded-lg border bg-muted/30 p-4 space-y-3 text-xs">
            <div>
              <p className="font-semibold text-sm mb-1">The inputs (from Ahrefs)</p>
              <p className="text-muted-foreground leading-relaxed">
                <strong>URL Rating (UR)</strong> measures the strength of a single page's backlink profile.
                <strong> Domain Rating (DR)</strong> measures the whole domain. Both run 0–100 on a
                <em> logarithmic</em> scale — moving from 30 → 40 takes roughly 4× the link work of moving from 10 → 20.
              </p>
            </div>
            <div>
              <p className="font-semibold text-sm mb-1">How TP is calculated</p>
              <pre className="rounded bg-background border p-2 text-[11px] leading-snug overflow-x-auto">{`Client UR = 32
SERP:  Rank 1  UR=58  → too strong, skip
       Rank 2  UR=45  → too strong, skip
       Rank 3  UR=28  → matched/beaten → TP = 3`}</pre>
              <p className="text-muted-foreground mt-1">Lower TP is better. TP = 1 means nothing on the SERP outranks your link strength.</p>
            </div>
            <div>
              <p className="font-semibold text-sm mb-1">Link strength bands (Performance Output table)</p>
              <div className="space-y-1">
                {LINK_BAND_DEFINITIONS.map((b) => (
                  <div key={b.label} className="flex items-start gap-2">
                    <Badge variant={b.tone === "pos" ? "pos" : b.tone === "warn" ? "warn" : "destructive"} className="mt-0.5 shrink-0">{b.label}</Badge>
                    <p className="text-muted-foreground leading-snug">
                      <span className="font-medium text-foreground">{b.range}.</span> {b.meaning}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Client Authority Summary */}
        {clientMetrics && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-lg bg-muted/50">
            <div>
              <p className="text-xs text-muted-foreground">Client Domain</p>
              <p className="text-sm font-medium">{clientMetrics.domain}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground"><MetricHelp metric="UR" /></p>
              <p className="text-sm font-bold">
                {clientMetrics.url_rating ?? <span className="text-xs font-normal text-muted-foreground">Not yet measured — run Sync Now</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground"><MetricHelp metric="DR" /></p>
              <p className="text-sm font-bold">
                {clientMetrics.domain_rating ?? <span className="text-xs font-normal text-muted-foreground">Not yet measured — run Sync Now</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last Calculated</p>
              <p className="text-sm">
                {clientMetrics.fetched_at
                  ? format(new Date(clientMetrics.fetched_at), "dd MMM yyyy HH:mm")
                  : "—"}
              </p>
            </div>
          </div>
        )}


        {/* Actions — HAR is now triggered exclusively by Sync Now */}
        <div className="flex items-center gap-3 flex-wrap">
          {harData.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Copy className="h-4 w-4 mr-1" />
                Export TP Column
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => recomputeForecasts(false)}
                disabled={isRecomputing}
                title="Recalculate TP Revenue from current HAR positions, CTR curves, AOV and conversion rate"
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${isRecomputing ? "animate-spin" : ""}`} />
                {isRecomputing ? "Recomputing…" : "Recompute TP Revenue"}
              </Button>
            </>
          )}
          {harData.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No TP data yet — press <span className="font-semibold text-foreground">Sync Now</span> in the header to run the calculation.
            </p>
          )}
        </div>

        {/* Filters */}
        {harData.length > 0 && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <Input
                placeholder="Search keywords…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
              />
              <Select value={filter} onValueChange={(v) => setFilter(v as FilterMode)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ({harData.length})</SelectItem>
                  <SelectItem value="achievable">Achievable ({achievableCount})</SelectItem>
                  <SelectItem value="not_achievable">Not Achievable ({harData.length - achievableCount})</SelectItem>
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as PriorityFilter)}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="1">Primary</SelectItem>
                  <SelectItem value="2">Secondary</SelectItem>
                  <SelectItem value="3">Tertiary</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {filteredData.length} keywords shown
              </span>
            </div>

            {/* Table */}
            <div className="rounded-md border overflow-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead><SortButton field="keyword">Keyword</SortButton></TableHead>
                    <TableHead><SortButton field="priority">Priority</SortButton></TableHead>
                    <TableHead className="text-right"><SortButton field="volume">Volume</SortButton></TableHead>
                    <TableHead className="text-right"><SortButton field="tp_revenue">TP Revenue</SortButton></TableHead>
                    <TableHead className="text-center">
                      <span className="inline-flex items-center gap-1 justify-center">
                        <SortButton field="har_position">TP Position</SortButton>
                        <MetricHelp metric="TP"><span className="sr-only">TP help</span></MetricHelp>
                      </span>
                    </TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center gap-1 justify-end">
                        <SortButton field="client_ur">Client UR</SortButton>
                        <MetricHelp metric="UR"><span className="sr-only">UR help</span></MetricHelp>
                      </span>
                    </TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center gap-1 justify-end">
                        <SortButton field="competitor_ur">Competitor UR @ TP</SortButton>
                        <MetricHelp metric="UR"><span className="sr-only">UR help</span></MetricHelp>
                      </span>
                    </TableHead>
                    <TableHead>Competitor URL</TableHead>
                    <TableHead className="text-right"><SortButton field="base_rank">Current Rank</SortButton></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredData.slice(0, 200).map((row: any) => {
                    const kw = row.keywords as any;
                    const isExpanded = expandedKeyword === row.keyword_id;
                    const currentPriority = Object.prototype.hasOwnProperty.call(priorityOverrides, row.keyword_id)
                      ? priorityOverrides[row.keyword_id]
                      : kw?.keyword_priority ?? null;
                    return (
                      <React.Fragment key={row.keyword_id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => setExpandedKeyword(isExpanded ? null : row.keyword_id)}
                        >
                          <TableCell className="text-center">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium max-w-[200px] truncate">
                            {kw?.keyword ?? "—"}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Select
                              value={currentPriority ? String(currentPriority) : "unassigned"}
                              onValueChange={(value) => handlePriorityChange(row.keyword_id, value)}
                            >
                              <SelectTrigger className="h-8 w-[130px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unassigned">Unassigned</SelectItem>
                                <SelectItem value="1">Primary</SelectItem>
                                <SelectItem value="2">Secondary</SelectItem>
                                <SelectItem value="3">Tertiary</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-right">
                            {kw?.avg_monthly_volume?.toLocaleString() ?? "—"}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency((forecastRevenueByKeyword as any)[row.keyword_id])}
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge
                              className={`${getHarColor(row.har_position)} ${getHarTextColor(row.har_position)} border-0`}
                            >
                              {row.har_position ?? "N/A"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {row.client_url_rating ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.har_competitor_ur ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate" onClick={(e) => e.stopPropagation()}>
                            {row.har_competitor_url ? (
                              <a
                                href={row.har_competitor_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                {row.har_competitor_url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
                                <ExternalLink className="h-3 w-3 flex-shrink-0" />
                              </a>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {kw?.base_rank ?? "—"}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow key={`${row.keyword_id}-expanded`} className="bg-muted/20">
                            <TableCell colSpan={10} className="p-4">
                              <CompetitorBacklinkLandscape
                                projectId={projectId}
                                keywordId={row.keyword_id}
                                clientUr={row.client_url_rating}
                                harCompetitorUrl={row.har_competitor_url}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {filteredData.length === 0 && (
                    <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                        No TP results yet — run the calculation above
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredData.length > 200 && (
                    <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground py-4 text-xs">
                        Showing 200 of {filteredData.length} results. Use search/filter to narrow down.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
