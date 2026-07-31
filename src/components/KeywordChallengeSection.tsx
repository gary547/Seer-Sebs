import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAllProjectForecastRows } from "@/integrations/gcp/calculations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { getUrlPath } from "@/lib/utils";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

interface Props {
  projectId: string;
}

export default function KeywordChallengeSection({ projectId }: Props) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const { data: challenges = [], isLoading } = useQuery({
    queryKey: ["keyword_challenges", projectId],
    queryFn: async () => {
      const forecasts = await listAllProjectForecastRows(projectId);
      const byUrl = new Map<string, typeof forecasts>();
      for (const forecast of forecasts) {
        if (!forecast.rankingUrl) continue;
        const rows = byUrl.get(forecast.rankingUrl) ?? [];
        rows.push(forecast);
        byUrl.set(forecast.rankingUrl, rows);
      }
      return [...byUrl.entries()]
        .flatMap(([rankingUrl, rows]) => {
          if (rows.length < 2) return [];
          const ordered = [...rows].sort(
            (left, right) =>
              (right.currentRevenueAnnual ?? 0) -
                (left.currentRevenueAnnual ?? 0) ||
              (left.baseRank ?? Number.MAX_SAFE_INTEGER) -
                (right.baseRank ?? Number.MAX_SAFE_INTEGER),
          );
          const current = ordered[0];
          return ordered.slice(1).map((challenger) => {
            const currentRevenue = current.currentRevenueAnnual ?? 0;
            const revenueGain = challenger.expectedIncrementalAnnual ?? 0;
            return {
              challenge_keyword: {
                avg_monthly_volume: challenger.averageMonthlyVolume,
                base_rank: challenger.baseRank,
                keyword: challenger.keyword,
              },
              challenge_revenue_gain: revenueGain,
              current_annual_revenue: currentRevenue,
              current_keyword: {
                avg_monthly_volume: current.averageMonthlyVolume,
                base_rank: current.baseRank,
                keyword: current.keyword,
              },
              id: `${current.keywordId}:${challenger.keywordId}`,
              ranking_url: rankingUrl,
              revenue_uplift_pct:
                currentRevenue > 0 ? (revenueGain / currentRevenue) * 100 : 0,
            };
          });
        })
        .sort(
          (left, right) =>
            right.challenge_revenue_gain - left.challenge_revenue_gain,
        );
    },
  });

  // Group by ranking URL for summary
  const urlStats = new Map<string, { count: number; totalGain: number }>();
  for (const c of challenges) {
    const url = c.ranking_url;
    const existing = urlStats.get(url) || { count: 0, totalGain: 0 };
    existing.count++;
    existing.totalGain += c.challenge_revenue_gain ?? 0;
    urlStats.set(url, existing);
  }

  const cannibalizedUrls = urlStats.size;
  const totalUplift = challenges.reduce((sum: number, c: any) => sum + (c.challenge_revenue_gain ?? 0), 0);

  const fmtCurrency = (v: number | null | undefined) =>
    v != null ? `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  const fmtPct = (v: number | null | undefined) =>
    v != null ? `${v.toFixed(1)}%` : "—";

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-accent" />
            Keyword Cannibalisation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-accent" />
          Keyword Cannibalisation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {challenges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cannibalisation detected. Run forecasts first to generate challenge data.
          </p>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Cannibalised URLs</p>
                <p className="text-2xl type-display">{cannibalizedUrls}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Challenge Keywords</p>
                <p className="text-2xl type-display">{challenges.length}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Total Revenue Uplift</p>
                <p className="text-2xl type-display text-accent">{fmtCurrency(totalUplift)}</p>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ranking URL</TableHead>
                    <TableHead>Current Keyword</TableHead>
                    <TableHead className="text-right">Current Revenue/yr</TableHead>
                    <TableHead>Challenger Keyword</TableHead>
                    <TableHead className="text-right">Vol</TableHead>
                    <TableHead className="text-right">Pos</TableHead>
                    <TableHead className="text-right">Revenue Gain</TableHead>
                    <TableHead className="text-right">Uplift %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {challenges.slice(page * pageSize, page * pageSize + pageSize).map((c: any) => (
                    <TableRow key={c.id}>
                      <TableCell className="max-w-[200px] truncate text-xs">
                        <span className="flex items-center gap-1" title={c.ranking_url}>
                          {getUrlPath(c.ranking_url)}
                          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate text-xs">
                        {c.current_keyword?.keyword ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {fmtCurrency(c.current_annual_revenue)}
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate text-xs font-medium">
                        {c.challenge_keyword?.keyword ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {c.challenge_keyword?.avg_monthly_volume?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {c.challenge_keyword?.base_rank ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs font-medium text-accent">
                        {fmtCurrency(c.challenge_revenue_gain)}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <Badge variant={
                          (c.revenue_uplift_pct ?? 0) > 50 ? "destructive" :
                          (c.revenue_uplift_pct ?? 0) > 20 ? "secondary" : "outline"
                        } className="text-xs">
                          {fmtPct(c.revenue_uplift_pct)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {(() => {
              const pageCount = Math.max(1, Math.ceil(challenges.length / pageSize));
              const start = page * pageSize;
              const end = Math.min(challenges.length, start + pageSize);
              return (
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    Showing {(start + 1).toLocaleString()}–{end.toLocaleString()} of {challenges.length.toLocaleString()} challenges
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
