import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowRight, Settings, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { getProjectSummary } from "@/integrations/gcp/tenancy";
import {
  listAllProjectForecastRows,
  listAllProjectSiteArchitecture,
} from "@/integrations/gcp/calculations";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";
import { getLatestProjectPipelineRun } from "@/integrations/gcp/pipeline";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import { useProjectNextAction } from "@/hooks/useProjectNextAction";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { decimalToPct } from "@/lib/validation/conversionOverride";

// ── Formatters ─────────────────────────────────────────────────────────────
function gbp(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
}

function num(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB").format(n);
}

function scorePct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

// ── Types ──────────────────────────────────────────────────────────────────
interface ProjectMeta {
  last_synced_at: string | null;
  aov: number | null;
  conversion_rate: number | null;
  category_focus: string | null;
}

interface OverviewStats {
  meta: ProjectMeta | null;
  keywordCount: number;
  keptCount: number;
  tpRevenueAnnualKept: number;
  performanceOutputTotal: number;
  tpUnderThree: number;
  avgRelevancy: number | null;
  topKeywords: Array<{
    keyword: string;
    har: number | null;
    tpRevenue: number;
  }>;
  blockedDetox: boolean;
}

// ── Query ──────────────────────────────────────────────────────────────────
function useProjectOverviewStats(projectId: string | null) {
  return useQuery({
    queryKey: ["project-overview-stats-v2", projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<OverviewStats> => {
      const id = projectId as string;

      const [project, keywords, forecasts, architecture, pipeline] =
        await Promise.all([
          getProjectSummary(id),
          listAllProjectKeywords(id),
          listAllProjectForecastRows(id),
          listAllProjectSiteArchitecture(id),
          getLatestProjectPipelineRun(id),
        ]);
      const keptIds = new Set(
        keywords
          .filter((keyword) => keyword.detoxStatus === "keep")
          .map((keyword) => keyword.id),
      );
      const rows = forecasts.filter((forecast) =>
        keptIds.has(forecast.keywordId),
      );

      const tpRevenueAnnualKept = rows.reduce(
        (total, row) => total + (row.expectedIncrementalAnnual ?? 0),
        0,
      );
      const performanceOutputTotal = rows.reduce(
        (total, row) =>
          total +
          (row.currentRevenueAnnual ?? 0) +
          (row.expectedIncrementalAnnual ?? 0),
        0,
      );
      const tpUnderThree = rows.filter(
        (row) => row.harPosition !== null && row.harPosition <= 3,
      ).length;
      const relevancyScores = architecture
        .map((row) => row.relevancyScore)
        .filter((score): score is number => score !== null);
      const avgRelevancy =
        relevancyScores.length === 0
          ? null
          : relevancyScores.reduce((sum, score) => sum + score, 0) /
            relevancyScores.length;
      const topKeywords = rows
        .filter((row) => (row.expectedIncrementalAnnual ?? 0) > 0)
        .map((row) => ({
          har: row.harPosition,
          keyword: row.keyword,
          tpRevenue: row.expectedIncrementalAnnual ?? 0,
        }))
        .sort((left, right) => right.tpRevenue - left.tpRevenue)
        .slice(0, 5);
      const blockedDetox =
        pipeline.run?.status === "failed" &&
        pipeline.run.stages.some(
          (stage) => stage.id === "detox" && stage.state === "failed",
        );

      return {
        avgRelevancy,
        blockedDetox,
        keptCount: keptIds.size,
        keywordCount: keywords.length,
        meta: project,
        performanceOutputTotal,
        topKeywords,
        tpRevenueAnnualKept,
        tpUnderThree,
      };
    },
  });
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function ProjectOverviewPage() {
  const ctx = useSeerRouteContext();
  const { activeClient, activeProject, urls } = ctx;
  const { data: stats, isLoading: statsLoading } = useProjectOverviewStats(
    activeProject?.id ?? null,
  );

  // Shared next-action source of truth — also drives the workspace header CTA.
  // Must be called before any early returns to satisfy the rules of hooks.
  const sharedNext = useProjectNextAction(activeClient?.id, activeProject?.id);

  if (!activeProject || !activeClient) return null;

  const lastSyncedAt = stats?.meta?.last_synced_at ?? null;
  const isFirstRun = !lastSyncedAt;
  const view = urls.projectView;

  const nextAction = {
    label: sharedNext?.label ?? "Open Setup",
    to: sharedNext?.to ?? (view ? view("setup") : "#"),
    why: sharedNext?.reason ?? "",
    tone: (sharedNext?.tone ?? "default") as "default" | "warn",
  };



  return (
    <div className="space-y-6">
      {/* Hero header */}
      <header className="rounded-xl border border-hairline bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-ink truncate">
              {activeProject.project_name}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-muted">
              <Badge variant="outline" className="capitalize">
                {activeProject.status}
              </Badge>
              {activeProject.category_focus && (
                <span className="truncate">{activeProject.category_focus}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to={view ? view("setup") : "#"}>
                <Settings className="h-3.5 w-3.5" /> Setup
              </Link>
            </Button>
            <Button asChild variant="signal" size="sm">
              <Link to={nextAction.to}>
                {nextAction.label} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        {/* Stat strip — identity facts */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-hairline pt-4">
          <Stat
            label="Last sync"
            value={
              lastSyncedAt
                ? formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })
                : "Never"
            }
            tone={lastSyncedAt ? "default" : "warn"}
          />
          <Stat
            label="Keywords"
            value={statsLoading ? "…" : num(stats?.keywordCount)}
            sub={stats ? `${num(stats.keptCount)} kept` : undefined}
          />
          <Stat
            label="TP Revenue (annual)"
            value={statsLoading ? "…" : gbp(stats?.tpRevenueAnnualKept)}
          />
          <Stat
            label="AOV / CVR"
            value={
              stats?.meta
                ? `${gbp(stats.meta.aov)} · ${
                    stats.meta.conversion_rate != null
                      ? `${decimalToPct(stats.meta.conversion_rate)}%`
                      : "—"
                  }`
                : "—"
            }
          />
        </div>
      </header>

      {/* Next action card */}
      <EditorialSection
        eyebrow="Next step"
        title="What to do next"
        dek={nextAction.why}
        actions={
          <Button asChild variant="signal" size="sm">
            <Link to={nextAction.to}>
              {nextAction.label} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <div
          className={`rounded-xl border p-4 text-[13px] shadow-card ${
            nextAction.tone === "warn"
              ? "border-warn/30 bg-warn/5 text-ink"
              : "border-hairline bg-surface text-ink-muted"
          }`}
        >
          {nextAction.tone === "warn" && (
            <div className="mb-2 flex items-center gap-2 text-warn text-[12px] font-semibold uppercase tracking-wider">
              <AlertTriangle className="h-3.5 w-3.5" />
              Attention
            </div>
          )}
          {isFirstRun ? (
            <p>
              New projects need a first sync before SERPs, intent, forecasts and roadmap can be
              generated. Head to Setup to start the pipeline.
            </p>
          ) : stats?.blockedDetox ? (
            <p>
              The keyword detox couldn't complete. From Setup you can skip detox and keep all
              keywords, or retry once AI credits are topped up.
            </p>
          ) : (
            <p>
              All major datasets exist for this project. Use the KPIs and snapshot below, or jump
              into a specific view from the tabs above.
            </p>
          )}
        </div>
      </EditorialSection>

      {/* Headline KPIs */}
      <EditorialSection
        eyebrow="Project health"
        title="Headline KPIs"
        dek="Snapshot of the forecast model for kept keywords. Open Forecast or Site Architecture to dig in."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Performance Output (annual)"
            value={statsLoading ? "…" : gbp(stats?.performanceOutputTotal)}
            sub="Current + TP uplift"
            to={view ? view("forecast") : undefined}
          />
          <KpiCard
            label="TP Revenue uplift"
            value={statsLoading ? "…" : gbp(stats?.tpRevenueAnnualKept)}
            sub="Kept keywords only"
            to={view ? view("forecast") : undefined}
          />
          <KpiCard
            label="Keywords at TP ≤ 3"
            value={statsLoading ? "…" : num(stats?.tpUnderThree)}
            sub={stats ? `of ${num(stats.keptCount)} kept` : undefined}
            to={view ? view("rankingUrlsTp") : undefined}
          />
          <KpiCard
            label="Avg site relevancy"
            value={statsLoading ? "…" : scorePct(stats?.avgRelevancy ?? null)}
            sub="Scored keywords"
            to={view ? view("siteArchitecture") : undefined}
          />
        </div>
      </EditorialSection>

      {/* Top TP Revenue keywords snapshot */}
      <EditorialSection
        eyebrow="Forecast snapshot"
        title="Top 5 TP Revenue keywords"
        dek="The kept keywords with the largest projected annual uplift if they reach their Top Potential rank."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={view ? view("forecast") : "#"}>
              Open Forecast <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-hidden">
          {statsLoading ? (
            <div className="p-6 text-[13px] text-ink-muted">Loading…</div>
          ) : !stats?.topKeywords.length ? (
            <div className="p-6 text-[13px] text-ink-muted">
              No TP Revenue forecasts yet.{" "}
              <Link
                to={view ? view("forecast") : "#"}
                className="text-signal hover:underline"
              >
                Open Forecast
              </Link>{" "}
              to run the calculation.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Keyword</TableHead>
                  <TableHead className="text-right w-[120px]">TP position</TableHead>
                  <TableHead className="text-right w-[180px]">TP Revenue / yr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.topKeywords.map((r) => (
                  <TableRow key={r.keyword}>
                    <TableCell className="font-medium text-ink">{r.keyword}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.har != null ? r.har : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {gbp(r.tpRevenue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </EditorialSection>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div>
      <div className="type-eyebrow text-ink-muted">{label}</div>
      <div
        className={`mt-1 type-mono font-semibold tabular-nums text-lg ${
          tone === "warn" ? "text-warn" : "text-ink"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
}) {
  const body = (
    <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card transition-shadow hover:shadow-raised hover:border-signal/40">
      <div className="type-eyebrow text-ink-muted">{label}</div>
      <div className="mt-1 type-mono font-semibold tabular-nums text-2xl text-ink">
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-muted mt-1">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
