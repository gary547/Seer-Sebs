import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Layers, Download, HelpCircle } from "lucide-react";
import { getUrlPath } from "@/lib/utils";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import SyncStaleBanner from "./SyncStaleBanner";
import { listAllProjectSiteArchitecture } from "@/integrations/gcp/calculations";

interface Props {
  projectId: string;
}

// DB values: green, amber, red
const STATUS_LABELS: Record<string, string> = {
  green: "Optimised",
  amber: "Needs Optimisation",
  red: "Content Gap / Poor Match",
};

const STATUS_BADGE: Record<string, string> = {
  green: "bg-[hsl(var(--signal))]/10 text-[hsl(var(--signal))]",
  amber: "bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))]",
  red: "bg-[hsl(var(--signal-2))]/10 text-[hsl(var(--signal-2))]",
};

// DB values: no_action_needed, create_content, optimise_content, new_content, green, watch
const TACTIC_LABELS: Record<string, string> = {
  no_action_needed: "No Action",
  optimise_content: "Optimise",
  create_content: "Create",
  new_content: "New Content",
  green: "Good",
  watch: "Watch",
};

function relevancyColor(score: number): string {
  if (score >= 80) return "text-[hsl(var(--signal))]";
  if (score >= 50) return "text-[hsl(var(--signal-3))]";
  if (score >= 20) return "text-[hsl(var(--signal-2))]/80";
  return "text-[hsl(var(--signal-2))]";
}

type ArchRow = {
  id: string;
  keyword_id: string;
  matched_url: string | null;
  relevancy_score: number | null;
  content_status: string | null;
  tactical_rag_status: string | null;
  keyword: string;
  search_intent: string | null;
  tag_1: string | null;
  avg_monthly_volume: number | null;
  base_rank: number | null;
  ranking_url: string | null;
  isUnscored: boolean;
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

export default function SiteArchitectureSection({ projectId }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [tacticFilter, setTacticFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // Fetch all kept keywords + their site_architecture row (LEFT JOIN semantics)
  // so we can show "Pending analysis" rows for keywords the orchestrator
  // hasn't scored yet (typically: newly-added keywords with no ranking_url
  // because DataForSEO returned no SERP match).
  const { data: rows = [], isLoading } = useQuery<ArchRow[]>({
    queryKey: ["site_architecture_with_unscored", projectId],
    queryFn: async () => {
      const targetRows = await listAllProjectSiteArchitecture(projectId);
      return targetRows.map((row): ArchRow => ({
        avg_monthly_volume: row.averageMonthlyVolume,
        base_rank: row.baseRank,
        content_status: row.contentStatus,
        id: `${row.isUnscored ? "unscored" : "scored"}-${row.keywordId}`,
        isUnscored: row.isUnscored,
        keyword: row.keyword,
        keyword_id: row.keywordId,
        matched_url: row.matchedUrl,
        ranking_url: row.rankingUrl,
        relevancy_score: row.relevancyScore,
        search_intent: row.searchIntent,
        tactical_rag_status: row.tacticalStatus,
        tag_1: row.category,
      }));
    },
  });

  const scored = useMemo(() => rows.filter((r) => !r.isUnscored), [rows]);
  const unscored = useMemo(() => rows.filter((r) => r.isUnscored), [rows]);

  const filtered = useMemo(
    () => rows.filter((r) => {
      if (r.isUnscored) {
        // Unscored rows: only show when both filters are "all", otherwise
        // they don't fit any specific status/tactic filter.
        return statusFilter === "all" && tacticFilter === "all";
      }
      return (
        (statusFilter === "all" || r.content_status === statusFilter) &&
        (tacticFilter === "all" || r.tactical_rag_status === tacticFilter)
      );
    }),
    [rows, statusFilter, tacticFilter],
  );

  const stats = useMemo(() => {
    const statusCounts: Record<string, number> = {};
    const tacticCounts: Record<string, number> = {};
    let totalRelevancy = 0;
    for (const r of scored) {
      if (r.content_status) statusCounts[r.content_status] = (statusCounts[r.content_status] || 0) + 1;
      if (r.tactical_rag_status) tacticCounts[r.tactical_rag_status] = (tacticCounts[r.tactical_rag_status] || 0) + 1;
      totalRelevancy += r.relevancy_score ?? 0;
    }
    return {
      statusCounts,
      tacticCounts,
      avgRelevancy: scored.length ? totalRelevancy / scored.length : 0,
    };
  }, [scored]);

  const handleExportCSV = () => {
    if (!rows.length) return;
    const headers = ["Keyword", "Category", "Intent", "Volume", "Matched URL", "Relevancy", "Content Status", "Action"];
    const csvRows = rows.map((r) => [
      r.keyword,
      r.tag_1 ?? "",
      r.search_intent ?? "",
      r.avg_monthly_volume ?? "",
      r.matched_url ?? "",
      r.relevancy_score?.toFixed(2) ?? "",
      r.content_status ? (STATUS_LABELS[r.content_status] || r.content_status) : "Pending",
      r.tactical_rag_status ? (TACTIC_LABELS[r.tactical_rag_status] || r.tactical_rag_status) : "Pending",
    ]);
    const csv = [headers, ...csvRows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "site_architecture.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Layers className="h-5 w-5 text-accent" />
            Site Architecture
          </CardTitle>
          {rows.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleExportCSV}>
              <Download className="h-4 w-4 mr-1" />
              Export CSV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <SyncStaleBanner
          projectId={projectId}
          message="Site architecture reflects the last sync. Press Sync Now in the header to re-score newly-added keywords."
        />

        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {!isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No kept keywords yet. Add keywords and run <strong>Sync Now</strong> to populate this report.
          </p>
        )}

        {rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Total Kept</p>
                <p className="text-xl type-display">{rows.length}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {scored.length} scored
                  {unscored.length > 0 && ` · ${unscored.length} pending`}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Avg Relevancy</p>
                <p className={`text-xl type-display ${relevancyColor(stats.avgRelevancy)}`}>
                  {stats.avgRelevancy.toFixed(0)}%
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Content Gaps</p>
                <p className="text-xl type-display text-[hsl(var(--signal-2))]">{stats.statusCounts["red"] || 0}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">To Optimise</p>
                <p className="text-xl type-display text-[hsl(var(--signal-3))]">{stats.tacticCounts["optimise_content"] || 0}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  Watch
                  <TooltipProvider>
                    <UITooltip>
                      <TooltipTrigger asChild><HelpCircle className="h-3 w-3 opacity-50 cursor-help" /></TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Parked: no volume signal yet — re-evaluated automatically once DataForSEO returns volume data.
                      </TooltipContent>
                    </UITooltip>
                  </TooltipProvider>
                </p>
                <p className="text-xl type-display text-[hsl(var(--signal-3))]">{stats.tacticCounts["watch"] || 0}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">To Create</p>
                <p className="text-xl type-display text-[hsl(var(--signal-2))]">
                  {(stats.tacticCounts["create_content"] || 0) + (stats.tacticCounts["new_content"] || 0)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Content Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(STATUS_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={tacticFilter} onValueChange={setTacticFilter}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {Object.entries(TACTIC_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-sm text-muted-foreground ml-auto">
                {filtered.length} keyword{filtered.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="rounded-md border max-h-[500px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Keyword</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead>Matched URL</TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center justify-end gap-1">
                        Relevancy
                        <TooltipProvider>
                          <UITooltip>
                            <TooltipTrigger asChild><HelpCircle className="h-3 w-3 opacity-50 cursor-help" /></TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs text-xs">How well the matched URL aligns with the keyword (0–100%, AI-scored).</TooltipContent>
                          </UITooltip>
                        </TooltipProvider>
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        Status
                        <TooltipProvider>
                          <UITooltip>
                            <TooltipTrigger asChild><HelpCircle className="h-3 w-3 opacity-50 cursor-help" /></TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs text-xs">Optimised · Needs optimisation · Content gap.</TooltipContent>
                          </UITooltip>
                        </TooltipProvider>
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        Action
                        <TooltipProvider>
                          <UITooltip>
                            <TooltipTrigger asChild><HelpCircle className="h-3 w-3 opacity-50 cursor-help" /></TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs text-xs">Recommended next step: Optimise · Create · New Content · No Action.</TooltipContent>
                          </UITooltip>
                        </TooltipProvider>
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(page * pageSize, page * pageSize + pageSize).map((r) => (
                    <TableRow key={r.id} className={r.isUnscored ? "bg-muted/30" : ""}>
                      <TableCell className="max-w-[180px] truncate text-xs font-medium">
                        {r.keyword}
                      </TableCell>
                      <TableCell className="text-xs">{r.tag_1 ?? "—"}</TableCell>
                      <TableCell className="text-right text-xs">
                        {r.avg_monthly_volume?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs">
                        {r.matched_url ? (
                          <span title={r.matched_url}>
                            {getUrlPath(r.matched_url)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground italic">No URL</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.relevancy_score != null ? (
                          <span className={`font-semibold ${relevancyColor(r.relevancy_score)}`}>
                            {r.relevancy_score.toFixed(0)}%
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {r.isUnscored ? (
                          <TooltipProvider>
                            <UITooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="text-xs cursor-help">
                                  {r.base_rank == null ? "Unranked" : "Pending"}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs text-xs">
                                {r.base_rank == null
                                  ? "DataForSEO returned no ranking match for this keyword. Excluded from relevancy scoring until a ranking URL is resolved."
                                  : "Awaiting site-architecture analysis on the next Sync."}
                              </TooltipContent>
                            </UITooltip>
                          </TooltipProvider>
                        ) : (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.content_status!] || ""}`}>
                            {STATUS_LABELS[r.content_status!] || r.content_status}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.isUnscored ? (
                          <span className="text-xs text-muted-foreground italic">—</span>
                        ) : r.tactical_rag_status === "watch" ? (
                          <TooltipProvider>
                            <UITooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))] cursor-help">
                                  Watch
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs text-xs">
                                No volume signal yet — will be re-evaluated once DataForSEO returns volume data.
                              </TooltipContent>
                            </UITooltip>
                          </TooltipProvider>
                        ) : (
                          <Badge variant={
                            r.tactical_rag_status === "create_content" || r.tactical_rag_status === "new_content" ? "destructive" :
                            r.tactical_rag_status === "optimise_content" ? "secondary" :
                            "default"
                          } className="text-xs">
                            {TACTIC_LABELS[r.tactical_rag_status!] || r.tactical_rag_status}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {(() => {
              const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
              const start = page * pageSize;
              const end = Math.min(filtered.length, start + pageSize);
              return (
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {filtered.length === 0
                      ? "No keywords match the current filters."
                      : `Showing ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${filtered.length.toLocaleString()} keywords`}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span>Rows</span>
                      <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(0); }}>
                        <SelectTrigger className="h-7 w-[72px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>)}
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
              );
            })()}
            {unscored.length > 0 && (statusFilter !== "all" || tacticFilter !== "all") && (
              <p className="text-xs text-muted-foreground italic">
                {unscored.length} pending/unranked keyword{unscored.length === 1 ? "" : "s"} hidden by current filter — clear filters to see them.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
