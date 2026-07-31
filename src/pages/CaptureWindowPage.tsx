import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, Download, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import {
  listCaptureWindowRows,
  type CaptureWindowRow,
} from "@/integrations/gcp/portfolio";
import { updateProjectKeywordPriority } from "@/integrations/gcp/project-data";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { SeasonalityBadge, formatPeakMonth, deriveIntensity } from "@/components/briefing/SeasonalityBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { projectHome } from "@/lib/routes";
import { GeneratePlanDialog } from "@/components/content-planner/GeneratePlanDialog";

/* ───────────────────────────────────────────────────── helpers ─── */

const compactGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
    style: "currency",
    currency: "GBP",
  }).format(n || 0);

const fullGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n || 0);

type Row = CaptureWindowRow;

type UrgencyBand = "all" | "sweet" | "approaching" | "closing" | "late";

function bandFor(weeks: number): UrgencyBand {
  if (weeks >= 12 && weeks <= 16) return "sweet";
  if (weeks >= 8 && weeks < 12) return "approaching";
  if (weeks >= 4 && weeks < 8) return "closing";
  return "late";
}

const BAND_LABELS: Record<UrgencyBand, string> = {
  all: "All bands",
  sweet: "Sweet spot · 12–16w",
  approaching: "Approaching · 8–12w",
  closing: "Closing · 4–8w",
  late: "Late · 0–4w",
};

/* ─────────────────────────────────────────────── data fetching ─── */

function useCaptureWindowRows(inWindowOnly: boolean) {
  return useQuery({
    queryKey: ["capture-window-rows", inWindowOnly],
    queryFn: (): Promise<Row[]> => listCaptureWindowRows(inWindowOnly),
  });
}

/* ─────────────────────────────────────────────────────── page ─── */

export default function CaptureWindowPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const clientIdParam = searchParams.get("clientId");


  const [inWindowOnly, setInWindowOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string>(clientIdParam ?? "all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [bandFilter, setBandFilter] = useState<UrgencyBand>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planDialogOpen, setPlanDialogOpen] = useState(false);

  // Keep filter in sync when URL changes (e.g. switching client from header switcher).
  useEffect(() => {
    if (clientIdParam) {
      setClientFilter(clientIdParam);
      setProjectFilter("all");
    }
  }, [clientIdParam]);

  const queryClient = useQueryClient();
  const { data: rows = [], isLoading, error } = useCaptureWindowRows(inWindowOnly);

  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) if (r.clientId) map.set(r.clientId, r.clientName ?? r.clientId);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const projectOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (clientFilter !== "all" && r.clientId !== clientFilter) continue;
      if (r.projectId) map.set(r.projectId, r.projectName);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, clientFilter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (clientFilter !== "all" && r.clientId !== clientFilter) return false;
      if (projectFilter !== "all" && r.projectId !== projectFilter) return false;
      if (bandFilter !== "all" && bandFor(r.weeksToPeak) !== bandFilter) return false;
      if (term && !r.keyword.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [rows, search, clientFilter, projectFilter, bandFilter]);

  // Sorted by weeks-to-peak ascending (most urgent first within filter set)
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => a.weeksToPeak - b.weeksToPeak),
    [filtered],
  );

  const stats = useMemo(() => {
    const total = filtered.length;
    const revenue = filtered.reduce((s, r) => s + r.revenueAtRank1, 0);
    const avgWeeks =
      total > 0 ? Math.round(filtered.reduce((s, r) => s + r.weeksToPeak, 0) / total) : 0;
    return { total, revenue, avgWeeks };
  }, [filtered]);

  // Per-project top-quartile revenue → drives badge intensity
  const topQuartileByProject = useMemo(() => {
    const map = new Map<string, number>();
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.projectId) continue;
      const arr = groups.get(r.projectId) ?? [];
      arr.push(r.revenueAtRank1);
      groups.set(r.projectId, arr);
    }
    for (const [pid, arr] of groups) {
      const sortedArr = [...arr].sort((a, b) => a - b);
      const idx = Math.floor(sortedArr.length * 0.75);
      map.set(pid, sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))] ?? 0);
    }
    return map;
  }, [rows]);

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === sorted.length) setSelected(new Set());
    else setSelected(new Set(sorted.map((r) => r.keywordId)));
  };

  async function setPriority(ids: string[], priority: number | null) {
    try {
      const selectedRows = rows.filter((row) => ids.includes(row.keywordId));
      const byProject = new Map<string, string[]>();
      for (const row of selectedRows) {
        byProject.set(row.projectId, [
          ...(byProject.get(row.projectId) ?? []),
          row.keywordId,
        ]);
      }
      const results = await Promise.all(
        [...byProject].map(([projectId, keywordIds]) =>
          updateProjectKeywordPriority(
            projectId,
            priority as 1 | 2 | 3 | null,
            keywordIds,
          ),
        ),
      );
      const affected = results.reduce(
        (total, result) => total + result.affectedKeywordCount,
        0,
      );
      if (affected !== ids.length) {
        throw new Error("One or more selected keywords are no longer available.");
      }
      toast.success(
        priority
          ? `Set ${ids.length} keyword${ids.length === 1 ? "" : "s"} to P${priority}`
          : `Cleared priority on ${ids.length} keyword${ids.length === 1 ? "" : "s"}`,
      );
      await queryClient.invalidateQueries({ queryKey: ["capture-window-rows"] });
    } catch (updateError) {
      toast.error("Couldn't update priority", {
        description:
          updateError instanceof Error
            ? updateError.message
            : "The update could not be completed.",
      });
    }
  }

  function exportCsv() {
    const header = [
      "keyword",
      "client",
      "project",
      "weeks_to_peak",
      "peak_month",
      "revenue_at_rank_1",
      "har_revenue_gain",
      "current_rank",
      "priority",
    ];
    const lines = [header.join(",")];
    for (const r of sorted) {
      lines.push(
        [
          JSON.stringify(r.keyword),
          JSON.stringify(r.clientName ?? ""),
          JSON.stringify(r.projectName),
          r.weeksToPeak,
          formatPeakMonth(r.peakMonth) ?? "",
          r.revenueAtRank1,
          r.harRevenueGain,
          r.baseRank ?? "",
          r.keywordPriority ?? "",
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `capture-window-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selectedIds = Array.from(selected);

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto pb-12">
      <EditorialSection
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="h-3 w-3" /> Seasonal prioritisation
          </span>
        }
        title="Content Opportunities"
        dek="Keywords entering their 3-month content planning window — start now to capture this year's peak demand."
        bare
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        }
      />

      {clientIdParam && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
            <span>
              Filtered to{" "}
              <span className="font-medium text-ink">
                {clientOptions.find(([id]) => id === clientIdParam)?.[1] ?? "this client"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("clientId");
                setSearchParams(next, { replace: true });
              }}
              className="text-ink-subtle hover:text-ink"
              aria-label="Clear client filter"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}


      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiTile label="Keywords in window" value={stats.total.toLocaleString()} />
        <KpiTile label="Combined upside" value={compactGBP(stats.revenue)} sub="/ yr at rank 1" />
        <KpiTile label="Avg time to peak" value={`${stats.avgWeeks}w`} sub="weeks until peak" />
      </div>

      {/* Filter row */}
      <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="type-eyebrow block mb-1.5">Search</label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter keywords…"
            className="h-9"
          />
        </div>
        <div className="min-w-[160px]">
          <label className="type-eyebrow block mb-1.5">Client</label>
          <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setProjectFilter("all"); }}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clientOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[160px]">
          <label className="type-eyebrow block mb-1.5">Project</label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projectOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[180px]">
          <label className="type-eyebrow block mb-1.5">Urgency band</label>
          <Select value={bandFilter} onValueChange={(v) => setBandFilter(v as UrgencyBand)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(BAND_LABELS) as UrgencyBand[]).map((b) => (
                <SelectItem key={b} value={b}>{BAND_LABELS[b]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer pb-2 text-[12.5px] text-ink">
          <Checkbox
            checked={inWindowOnly}
            onCheckedChange={(c) => setInWindowOnly(c === true)}
          />
          In-window only
        </label>
      </div>

      {/* Bulk action bar — visible when selection > 0 */}
      {selectedIds.length > 0 && (
        <div className="rounded-xl border border-signal/40 bg-signal-soft/40 p-3 flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-medium text-ink">
            {selectedIds.length} selected
          </span>
          <Button size="sm" variant="signal" onClick={() => setPlanDialogOpen(true)}>
            <Sparkles className="h-3.5 w-3.5" /> Generate 3-month plan
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPriority(selectedIds, 1)}>
            Promote to P1
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPriority(selectedIds, 2)}>
            Set P2
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPriority(selectedIds, 3)}>
            Set P3
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPriority(selectedIds, null)}>
            Clear priority
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Deselect
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-ink-muted text-[13px]">
            Loading content planner…
          </div>
        ) : error ? (
          <div className="p-6 text-neg text-[13px]">
            Couldn't load keywords. {String((error as Error).message ?? "")}
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-12 text-center">
            <div className="mx-auto h-10 w-10 rounded-full bg-secondary flex items-center justify-center mb-3">
              <CalendarClock className="h-4 w-4 text-ink-muted" />
            </div>
            <p className="text-[13px] text-ink-muted max-w-md mx-auto">
              No keywords are entering their content planning window with the current filters.
              Sync a project or recompute peak months to refresh.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link to="/clients">Open Seer® projects</Link>
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selected.size > 0 && selected.size === sorted.length}
                      onCheckedChange={toggleAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Keyword</TableHead>
                  <TableHead className="hidden md:table-cell">Project</TableHead>
                  <TableHead className="text-right">Weeks to peak</TableHead>
                  <TableHead className="hidden lg:table-cell">Peak month</TableHead>
                  <TableHead className="text-right">Rev. at rank 1</TableHead>
                  <TableHead className="hidden xl:table-cell text-right">HAR uplift</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Rank</TableHead>
                  <TableHead className="w-[120px]">Priority</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => {
                  const intensity = deriveIntensity({
                    weeksToPeak: r.weeksToPeak,
                    isInCaptureWindow: r.isInCaptureWindow,
                    revenueAtRank1: r.revenueAtRank1,
                    projectTopQuartileRevenue: topQuartileByProject.get(r.projectId) ?? 0,
                  });
                  const peakLabel = formatPeakMonth(r.peakMonth);
                  const isSelected = selected.has(r.keywordId);
                  return (
                    <TableRow key={r.keywordId} className={cn(isSelected && "bg-signal-soft/30")}>
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(r.keywordId)}
                          aria-label={`Select ${r.keyword}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="font-medium text-ink truncate max-w-[280px]">
                            {r.keyword}
                          </span>
                          {intensity && (
                            <SeasonalityBadge
                              intensity={intensity}
                              weeksToPeak={r.weeksToPeak}
                              peakMonthLabel={peakLabel}
                              revenueAtRank1={r.revenueAtRank1}
                              compact
                            />
                          )}
                        </div>
                        <div className="text-[11px] text-ink-muted md:hidden mt-0.5 truncate">
                          {r.projectName}
                          {r.clientName ? ` · ${r.clientName}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Link
                          to={r.clientId ? projectHome(r.clientId, r.projectId) : `/navigator/${r.projectId}`}
                          className="text-[13px] text-ink hover:text-signal-ink truncate block max-w-[220px]"
                        >
                          {r.projectName}
                        </Link>
                        {r.clientName && (
                          <div className="text-[11px] text-ink-muted truncate max-w-[220px]">
                            {r.clientName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {r.weeksToPeak}w
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-[12.5px] text-ink-muted">
                        {peakLabel ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold text-ink">
                        {fullGBP(r.revenueAtRank1)}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-right tabular-nums text-ink-muted">
                        {r.harRevenueGain ? fullGBP(r.harRevenueGain) : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-right tabular-nums">
                        {r.baseRank ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={r.keywordPriority?.toString() ?? "none"}
                          onValueChange={(v) =>
                            setPriority([r.keywordId], v === "none" ? null : Number(v))
                          }
                        >
                          <SelectTrigger className="h-8 text-[12px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">P1 · Primary</SelectItem>
                            <SelectItem value="2">P2 · Secondary</SelectItem>
                            <SelectItem value="3">P3 · Tertiary</SelectItem>
                            <SelectItem value="none">— Unassigned</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={r.clientId ? projectHome(r.clientId, r.projectId) : `/navigator/${r.projectId}`}
                          className="text-ink-muted hover:text-signal-ink"
                          aria-label="Open project"
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <GeneratePlanDialog
        open={planDialogOpen}
        onOpenChange={setPlanDialogOpen}
        selected={sorted.filter((r) => selected.has(r.keywordId)).map((r) => ({
          keywordId: r.keywordId,
          keyword: r.keyword,
          clientId: r.clientId,
          projectId: r.projectId,
          projectName: r.projectName,
          clientName: r.clientName,
        }))}
      />
    </div>
  );
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card">
      <div className="type-eyebrow">{label}</div>
      <div className="mt-1.5 text-[28px] font-semibold tabular-nums text-ink leading-none">
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}
