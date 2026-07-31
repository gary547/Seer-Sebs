import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calculator, Download, ArrowUp, ArrowDown, ArrowUpDown, TrendingUp, Rocket, Sparkles, Shield, HelpCircle, X } from "lucide-react";
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import SyncStaleBanner from "@/components/SyncStaleBanner";
import { MetricHelp } from "@/components/briefing/MetricHelp";
import { listAllProjectForecastRows } from "@/integrations/gcp/calculations";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";
import { useRecomputeForecasts } from "@/hooks/useRecomputeForecasts";

interface Props {
  projectId: string;
}

const INTENT_OPTIONS: { key: string; label: string }[] = [
  { key: "transactional", label: "Transactional" },
  { key: "commercial", label: "Commercial" },
  { key: "informational", label: "Informational" },
  { key: "navigational", label: "Navigational" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const OPP_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  maintain: { label: "Maintain", icon: <Shield className="h-5 w-5" />, color: "text-accent", bg: "bg-accent/10 border-accent/20" },
  improve: { label: "Improve", icon: <TrendingUp className="h-5 w-5" />, color: "text-primary", bg: "bg-primary/10 border-primary/20" },
  grow: { label: "Grow", icon: <Rocket className="h-5 w-5" />, color: "text-[hsl(var(--signal-3))]", bg: "bg-[hsl(var(--signal-3))]/10 border-[hsl(var(--signal-3))]/20" },
  opportunity: { label: "Opportunity", icon: <Sparkles className="h-5 w-5" />, color: "text-[hsl(var(--signal-2))]", bg: "bg-[hsl(var(--signal-2))]/10 border-[hsl(var(--signal-2))]/20" },
};

type SortKey = "keyword" | "device" | "volume" | "position" | "opportunity" | "ctr" | "clicks" | "revenue" | "traffic_gain" | "revenue_gain" | "har" | "link_delta";
type SortDir = "asc" | "desc";

type LinkBand = "parity" | "stretch" | "gap" | null;

function getLinkBand(clientUr: number | null, competitorUr: number | null): LinkBand {
  if (clientUr == null || competitorUr == null) return null;
  const delta = clientUr - competitorUr;
  if (delta >= -5) return "parity";
  if (delta >= -15) return "stretch";
  return "gap";
}

const LINK_BAND_STYLES: Record<Exclude<LinkBand, null>, { label: string; classes: string }> = {
  parity: { label: "Matched", classes: "bg-[hsl(var(--signal))]/15 text-[hsl(var(--signal))] border-[hsl(var(--signal))]/30" },
  stretch: { label: "Slightly behind", classes: "bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))] border-[hsl(var(--signal-3))]/30" },
  gap: { label: "Behind", classes: "bg-[hsl(var(--signal-2))]/15 text-[hsl(var(--signal-2))] border-[hsl(var(--signal-2))]/30" },
};

export default function PerformanceOutputSection({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isRunning, setIsRunning] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("revenue_gain");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [oppFilter, setOppFilter] = useState<string | null>(searchParams.get("opp"));
  const [intentFilter, setIntentFilter] = useState<string | null>(searchParams.get("intent"));
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);
  const { recompute } = useRecomputeForecasts(projectId);

  // Sync filters to URL so people can share/bookmark a filtered view
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (oppFilter) next.set("opp", oppFilter); else next.delete("opp");
    if (intentFilter) next.set("intent", intentFilter); else next.delete("intent");
    setSearchParams(next, { replace: true });
    setPage(0); // reset to first page when filters change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oppFilter, intentFilter]);

  const { data: forecasts = [], isLoading } = useQuery({
    queryKey: ["keyword_forecasts", projectId],
    queryFn: async () => {
      const rows = await listAllProjectForecastRows(projectId);
      return rows.map((row) => ({
        client_url_rating: row.clientUrlRating,
        competitor_url_rating: row.competitorUrlRating,
        current_ctr_pct: (row.ctrNow ?? 0) * 100,
        est_current_clicks_annual:
          (row.annualVolume ?? 0) * (row.ctrNow ?? 0),
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
          ranking_url: row.rankingUrl,
          search_intent: row.searchIntent,
        },
        opportunity: row.opportunity,
        yearly_revenue_gain_rank1: row.targetIncrementalRevenueAnnual,
        yearly_traffic_gain_rank1: row.trafficGainAnnual,
      }));
    },
  });

  // Fetch ALL kept keywords so we can surface kw with no forecast (e.g. unranked
  // by DataForSEO) as "Unranked" rows. Charts/score-cards still use `forecasts`
  // only, but the table + total count include the unranked tail for transparency.
  const { data: keptKeywords = [] } = useQuery({
    queryKey: ["kept_keywords_for_output", projectId],
    queryFn: async () => {
      const rows = await listAllProjectKeywords(projectId, {
        detoxStatus: "keep",
      });
      return rows.map((row) => ({
        avg_monthly_volume: row.avgMonthlyVolume,
        base_rank: row.baseRank,
        device: "mobile",
        id: row.id,
        keyword: row.text,
        ranking_url: row.rankingUrl,
        search_intent: row.searchIntent,
      }));
    },
  });

  // Fetch HAR results to get client_ur / competitor_ur per keyword for Link Δ
  const { data: harByKeyword = {} } = useQuery({
    queryKey: ["har_results_map", projectId],
    queryFn: async () => {
      const map: Record<string, { client_ur: number | null; competitor_ur: number | null }> = {};
      const rows = await listAllProjectForecastRows(projectId);
      for (const row of rows) {
        map[row.keywordId] = {
          client_ur: row.clientUrlRating,
          competitor_ur: row.competitorUrlRating,
        };
      }
      return map;
    },
  });

  const handleRunForecasts = async () => {
    setIsRunning(true);
    try {
      const result = await recompute(true);
      if (!result.ok) throw new Error(result.error ?? "Forecast computation failed");
      toast.success("Forecast pipeline completed");
      queryClient.invalidateQueries({ queryKey: ["keyword_forecasts", projectId] });
      queryClient.invalidateQueries({ queryKey: ["keyword_challenges", projectId] });
    } catch (err: any) {
      toast.error(err.message || "Forecast computation failed");
    } finally {
      setIsRunning(false);
    }
  };

  const buildCsv = (rows: any[]) => {
    const headers = [
      "Keyword", "Device", "Volume", "Position", "Opportunity", "Intent", "CTR%",
      "Est Clicks/yr", "Est Revenue/yr", "Traffic Gain #1/yr", "Revenue Gain #1/yr",
      "TP", "TP Traffic Gain/yr", "TP Revenue Gain/yr"
    ];
    const body = rows.map((f: any) => [
      f.keywords?.keyword,
      f.keywords?.device,
      f.keywords?.avg_monthly_volume,
      f.keywords?.base_rank ?? "",
      f.opportunity,
      f.keywords?.search_intent ?? "",
      f.current_ctr_pct,
      f.est_current_clicks_annual,
      f.est_current_revenue_annual,
      f.yearly_traffic_gain_rank1,
      f.yearly_revenue_gain_rank1,
      f.har ?? "",
      f.har_traffic_gain_annual ?? "",
      f.har_revenue_gain_annual ?? "",
    ]);
    return [headers, ...body].map(r => r.join(",")).join("\n");
  };

  const downloadCsv = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportFiltered = () => {
    if (!sorted.length) return;
    downloadCsv(buildCsv(sorted), "performance_output_filtered.csv");
  };

  const handleExportAll = () => {
    if (!forecasts.length) return;
    downloadCsv(buildCsv(forecasts), "performance_output.csv");
  };

  const oppCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const source = intentFilter
      ? forecasts.filter((f: any) => (f.keywords?.search_intent ?? "").toLowerCase() === intentFilter)
      : forecasts;
    for (const f of source) {
      const opp = f.opportunity || "opportunity";
      counts[opp] = (counts[opp] || 0) + 1;
    }
    return counts;
  }, [forecasts, intentFilter]);

  const intentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const source = oppFilter
      ? forecasts.filter((f: any) => (f.opportunity || "opportunity") === oppFilter)
      : forecasts;
    for (const f of source) {
      const intent = (f.keywords?.search_intent ?? "").toLowerCase();
      if (intent) counts[intent] = (counts[intent] || 0) + 1;
    }
    return counts;
  }, [forecasts, oppFilter]);

  // Kept keywords with no forecast row — typically because DataForSEO returned
  // no rank for them. We surface these as "Unranked" in the table so the user
  // sees the full kept-keyword set, not a silently-truncated subset.
  const unrankedKeywords = useMemo(() => {
    const forecastedIds = new Set(forecasts.map((f: any) => f.keyword_id));
    return keptKeywords.filter((k: any) => !forecastedIds.has(k.id));
  }, [keptKeywords, forecasts]);

  const totalKeptCount = keptKeywords.length;

  const getValue = (f: any, key: SortKey): string | number => {
    switch (key) {
      case "keyword": return f.keywords?.keyword ?? "";
      case "device": return f.keywords?.device ?? "";
      case "volume": return f.keywords?.avg_monthly_volume ?? 0;
      case "position": return f.keywords?.base_rank ?? 999;
      case "opportunity": return f.opportunity ?? "";
      case "ctr": return f.current_ctr_pct ?? 0;
      case "clicks": return f.est_current_clicks_annual ?? 0;
      case "revenue": return f.est_current_revenue_annual ?? 0;
      case "traffic_gain": return f.yearly_traffic_gain_rank1 ?? 0;
      case "revenue_gain": return f.yearly_revenue_gain_rank1 ?? 0;
      case "har": return f.har ?? 999;
      case "link_delta": {
        const h = (harByKeyword as any)[f.keyword_id];
        if (!h || h.client_ur == null || h.competitor_ur == null) return -999;
        return h.client_ur - h.competitor_ur;
      }
      default: return 0;
    }
  };

  const sorted = useMemo(() => {
    let list: any[] = forecasts;
    if (oppFilter) list = list.filter((f: any) => (f.opportunity || "opportunity") === oppFilter);
    if (intentFilter) list = list.filter((f: any) => (f.keywords?.search_intent ?? "").toLowerCase() === intentFilter);
    const copy = [...list];
    copy.sort((a, b) => {
      const va = getValue(a, sortKey);
      const vb = getValue(b, sortKey);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [forecasts, sortKey, sortDir, oppFilter, intentFilter]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const visibleStart = page * pageSize;
  const visibleEnd = Math.min(sorted.length, visibleStart + pageSize);
  const visibleRows = sorted.slice(visibleStart, visibleEnd);
  const filtersActive = Boolean(oppFilter || intentFilter);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const fmt = (v: number | null | undefined) =>
    v != null ? v.toLocaleString("en-GB", { maximumFractionDigits: 0 }) : "—";
  const fmtCurrency = (v: number | null | undefined) =>
    v != null ? `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Calculator className="h-5 w-5 text-accent" />
            Performance Output
          </CardTitle>
          {forecasts.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-1" />
                  Export CSV
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportFiltered} disabled={!sorted.length}>
                  Export filtered ({sorted.length.toLocaleString()})
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportAll}>
                  Export all ({forecasts.length.toLocaleString()})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <SyncStaleBanner projectId={projectId} message="Forecasts may be out of date — press Sync Now in the header to recompute with the latest inputs." />

        {totalKeptCount === 0 && (
          <p className="text-sm text-muted-foreground">
            No kept keywords yet — add keywords on the Keywords tab and press <span className="font-semibold text-foreground">Sync Now</span>.
          </p>
        )}

        {totalKeptCount > 0 && (
          <>
            {/* Score Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {/* Total card — counts ALL kept keywords (forecasted + unranked) */}
              <button
                onClick={() => setOppFilter(null)}
                className={`rounded-xl border p-4 text-left transition-all ${
                  oppFilter === null
                    ? "bg-muted ring-2 ring-primary/40"
                    : "bg-muted/40 hover:bg-muted/60"
                }`}
              >
                <div className="flex items-center gap-2 mb-2 text-foreground">
                  <Calculator className="h-5 w-5" />
                  <span className="text-xs font-semibold uppercase tracking-wider">Total Keywords</span>
                </div>
                <p className="text-3xl type-display">{totalKeptCount}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {forecasts.length} forecasted{unrankedKeywords.length > 0 ? ` · ${unrankedKeywords.length} unranked` : ""}
                </p>
              </button>

              {["maintain", "improve", "grow", "opportunity"].map(opp => {
                const config = OPP_CONFIG[opp];
                const count = oppCounts[opp] || 0;
                return (
                  <button
                    key={opp}
                    onClick={() => setOppFilter(oppFilter === opp ? null : opp)}
                    className={`rounded-xl border p-4 text-left transition-all ${config.bg} ${
                      oppFilter === opp ? "ring-2 ring-primary/40 scale-[1.02]" : "hover:scale-[1.01]"
                    }`}
                  >
                    <div className={`flex items-center gap-2 mb-2 ${config.color}`}>
                      {config.icon}
                      <span className="text-xs font-semibold uppercase tracking-wider">{config.label}</span>
                    </div>
                    <p className={`text-3xl type-display ${config.color}`}>{count}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">keywords</p>
                  </button>
                );
              })}
            </div>

            {/* Intent filter chips + active-filter summary */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Intent</span>
              {INTENT_OPTIONS.map((opt) => {
                const active = intentFilter === opt.key;
                const count = intentCounts[opt.key] ?? 0;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setIntentFilter(active ? null : opt.key)}
                    disabled={count === 0 && !active}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                      active
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "bg-muted/40 border-transparent text-muted-foreground hover:bg-muted/70 disabled:opacity-40 disabled:hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                    <span className="opacity-70">{count.toLocaleString()}</span>
                  </button>
                );
              })}
              {filtersActive && (
                <button
                  type="button"
                  onClick={() => { setOppFilter(null); setIntentFilter(null); }}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  Clear filters
                </button>
              )}
            </div>

            {filtersActive && (
              <p className="text-xs text-muted-foreground">
                Showing <span className="text-foreground font-medium">{sorted.length.toLocaleString()}</span>{" "}
                {intentFilter ? <span className="capitalize">{intentFilter} </span> : null}
                keyword{sorted.length === 1 ? "" : "s"}
                {oppFilter ? <> with <span className="text-foreground font-medium capitalize">{oppFilter}</span> opportunity</> : null}
                {" · "}
                <button onClick={() => { setOppFilter(null); setIntentFilter(null); }} className="underline hover:text-foreground">clear</button>
              </p>
            )}

            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("keyword")}>
                      <span className="flex items-center">Keyword<SortIcon col="keyword" /></span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("device")}>
                      <span className="flex items-center">Device<SortIcon col="device" /></span>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("volume")}>
                      <HeaderWithHelp align="right" help="Average monthly Google searches over the last 12 months.">
                        Volume<SortIcon col="volume" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("position")}>
                      <HeaderWithHelp align="right" help="Current Google rank for this keyword on the chosen device.">
                        Position<SortIcon col="position" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("opportunity")}>
                      <HeaderWithHelp help="Maintain (top 3) · Improve (4–10) · Grow (11–20) · Opportunity (21+).">
                        Opportunity<SortIcon col="opportunity" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("ctr")}>
                      <HeaderWithHelp align="right" help="Estimated click-through rate at the current ranking position.">
                        CTR%<SortIcon col="ctr" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("clicks")}>
                      <HeaderWithHelp align="right" help="Projected annual clicks at the current rank (volume × CTR).">
                        Est Clicks/yr<SortIcon col="clicks" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("revenue")}>
                      <HeaderWithHelp align="right" help="Estimated annual revenue: clicks × conversion rate × AOV.">
                        Est Revenue/yr<SortIcon col="revenue" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("traffic_gain")}>
                      <HeaderWithHelp align="right" help="Extra annual clicks if this keyword reached position 1.">
                        Traffic Gain #1<SortIcon col="traffic_gain" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("revenue_gain")}>
                      <HeaderWithHelp align="right" help="Extra annual revenue if this keyword reached position 1.">
                        Revenue Gain #1<SortIcon col="revenue_gain" />
                      </HeaderWithHelp>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("har")}>
                      <MetricHelp metric="TP" align="right" label={<span>TP<SortIcon col="har" /></span>} />
                    </TableHead>
                    <TableHead className="text-center cursor-pointer select-none" onClick={() => toggleSort("link_delta")}>
                      <MetricHelp metric="LinkBand" align="center" label={<span>Link strength<SortIcon col="link_delta" /></span>} />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((f: any, rowIndex) => {
                    const h = (harByKeyword as any)[f.keyword_id];
                    const band = h ? getLinkBand(h.client_ur, h.competitor_ur) : null;
                    const delta = h && h.client_ur != null && h.competitor_ur != null
                      ? h.client_ur - h.competitor_ur
                      : null;
                    return (
                      <TableRow key={`${f.keyword_id}-${rowIndex}`}>
                        <TableCell className="max-w-[200px] truncate text-xs">{f.keywords?.keyword}</TableCell>
                        <TableCell className="text-xs">{f.keywords?.device}</TableCell>
                        <TableCell className="text-right text-xs">{fmt(f.keywords?.avg_monthly_volume)}</TableCell>
                        <TableCell className="text-right text-xs">{f.keywords?.base_rank ?? "—"}</TableCell>
                        <TableCell>
                          <span className={`text-xs font-medium capitalize ${OPP_CONFIG[f.opportunity]?.color ?? "text-muted-foreground"}`}>
                            {f.opportunity}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs">{f.current_ctr_pct?.toFixed(1)}%</TableCell>
                        <TableCell className="text-right text-xs">{fmt(f.est_current_clicks_annual)}</TableCell>
                        <TableCell className="text-right text-xs">{fmtCurrency(f.est_current_revenue_annual)}</TableCell>
                        <TableCell className="text-right text-xs">{fmt(f.yearly_traffic_gain_rank1)}</TableCell>
                        <TableCell className="text-right text-xs">{fmtCurrency(f.yearly_revenue_gain_rank1)}</TableCell>
                        <TableCell className="text-right text-xs">{f.har ?? "—"}</TableCell>
                        <TableCell className="text-center">
                          {band ? (
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${LINK_BAND_STYLES[band].classes}`}
                              title={`Your link strength ${h.client_ur} vs ranking page ${h.competitor_ur} (${delta! >= 0 ? "+" : ""}${delta})`}
                            >
                              {LINK_BAND_STYLES[band].label}
                              <span className="opacity-70">{delta! >= 0 ? "+" : ""}{delta}</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {/* Unranked tail — only on the first page when no filters are active */}
                  {!filtersActive && page === 0 && unrankedKeywords.slice(0, Math.max(0, pageSize - visibleRows.length)).map((k: any, rowIndex) => (
                    <TableRow key={`unranked-${k.id}-${rowIndex}`} className="bg-muted/30">
                      <TableCell className="max-w-[200px] truncate text-xs">{k.keyword}</TableCell>
                      <TableCell className="text-xs">{k.device}</TableCell>
                      <TableCell className="text-right text-xs">{fmt(k.avg_monthly_volume)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                      <TableCell>
                        <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border border-muted-foreground/30 text-muted-foreground">
                          Unranked
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" colSpan={7}>
                        No rank data — excluded from forecasts &amp; charts
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pager */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {sorted.length === 0
                  ? "No keywords match the current filters."
                  : `Showing ${(visibleStart + 1).toLocaleString()}–${visibleEnd.toLocaleString()} of ${sorted.length.toLocaleString()} keywords${filtersActive ? " (filtered)" : ""}`}
              </span>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span>Rows</span>
                  <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(0); }}>
                    <SelectTrigger className="h-7 w-[72px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Prev</Button>
                  <span className="px-2">Page {page + 1} of {pageCount}</span>
                  <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next</Button>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HeaderWithHelp({
  children,
  help,
  align = "left",
}: {
  children: React.ReactNode;
  help: string;
  align?: "left" | "right" | "center";
}) {
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <span className={`flex items-center gap-1 ${justify}`}>
      {children}
      <TooltipProvider>
        <UITooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="h-3 w-3 opacity-50 cursor-help" onClick={(e) => e.stopPropagation()} />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">{help}</TooltipContent>
        </UITooltip>
      </TooltipProvider>
    </span>
  );
}
