import { useMemo } from "react";
import { Link } from "react-router";
import { format, formatDistanceToNow } from "date-fns";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import {
  ArrowRight,
  Building2,
  CalendarClock,
  Eye,
  FileText,
  Plus,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useDashboardData, type ClientRevenue } from "@/hooks/useDashboardData";
import { useClients, type ClientSummary } from "@/hooks/useClients";
import { useNavigatorProjects, type NavigatorProjectSummary } from "@/hooks/useNavigatorProjects";
import { useArchivedClientsCount } from "@/hooks/useArchive";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { BriefingCard } from "@/components/briefing/BriefingCard";
import { CadenceStrip } from "@/components/briefing/CadenceStrip";
import { SiteArchitectureActionCard } from "@/components/briefing/SiteArchitectureActionCard";
import { ShareBar } from "@/components/briefing/ShareBar";
import { InsightQuote } from "@/components/briefing/InsightQuote";
import { toDisplayName } from "@/lib/formatName";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { axisProps, gridProps, tooltipProps, chartColors } from "@/lib/chartTheme";
import { clientHome, projectHome, newClientProject, archivePath } from "@/lib/routes";
import { cn } from "@/lib/utils";

/* ──────────────────────────────────────────────────────────── helpers ─── */

const compactCurrency = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
    style: "currency",
    currency: "GBP",
  }).format(n || 0);

const compactNumber = (n: number) =>
  new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ────────────────────────────────────────────────────────────── hero ─── */

function HeroBriefing({ summary }: { summary: ReturnType<typeof useDashboardData>["summary"] }) {
  const { user } = useAuth();
  const firstName = useMemo(() => {
    const name =
      (user?.user_metadata as Record<string, unknown> | undefined)?.full_name ||
      user?.email?.split("@")[0] ||
      "there";
    return toDisplayName(String(name).split(" ")[0]);
  }, [user]);

  const today = format(new Date(), "EEEE, d MMMM yyyy");
  const lastSync = summary?.lastSyncedAt
    ? formatDistanceToNow(new Date(summary.lastSyncedAt), { addSuffix: true })
    : "—";

  return (
    <EditorialSection tone="obsidian" bare className="animate-briefing-rise relative overflow-hidden">
      {/* Soft brand-colour wash — amber → coral → teal blended across the right side */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <div
          className="absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 55% 70% at 100% 0%, hsl(44 99% 55% / 0.55), transparent 60%)",
              "radial-gradient(ellipse 60% 75% at 95% 55%, hsl(9 78% 62% / 0.50), transparent 65%)",
              "radial-gradient(ellipse 55% 70% at 100% 100%, hsl(182 80% 38% / 0.55), transparent 65%)",
            ].join(", "),
            filter: "blur(20px)",
          }}
        />
        {/* Navy vignette on the left for headline legibility */}
        <div
          className="absolute inset-y-0 left-0 w-2/3"
          style={{
            background: "linear-gradient(90deg, hsl(var(--obsidian)) 35%, transparent 100%)",
          }}
        />
      </div>
      <div className="relative z-10 grid gap-6 lg:grid-cols-[1.5fr,1fr] items-start">
        <div>
          <div className="type-eyebrow text-obsidian-ink-muted">
            {today} · Morning briefing
          </div>
          <h1 className="mt-3 type-display text-[36px] sm:text-[44px] leading-[1.05] text-obsidian-ink">
            Good morning, {firstName}.
            <span className="block text-gradient-signal mt-1">
              Welcome to Search + Discovery - let's get started.
            </span>
          </h1>
          <p className="mt-5 max-w-xl type-insight text-[15px] text-obsidian-ink/85">
            {summary?.captureWindow.totalKeywords ? (
              <>
                You have{" "}
                <span className="text-signal-ink not-italic font-semibold">
                  {summary.projectCount} Seer® {summary.projectCount === 1 ? "project" : "projects"} in progress
                </span>{" "}
                across {summary.clientCount} {summary.clientCount === 1 ? "client" : "clients"}, and{" "}
                <Link
                  to="/capture-window"
                  className="text-signal-ink not-italic font-semibold underline-offset-4 hover:underline"
                >
                  {summary.captureWindow.totalKeywords} keywords
                </Link>{" "}
                are entering their content planning window.
              </>
            ) : (
              <>
                You have{" "}
                <span className="text-signal-ink not-italic font-semibold">
                  {summary?.projectCount ?? 0} Seer® {summary?.projectCount === 1 ? "project" : "projects"} in progress
                </span>{" "}
                across {summary?.clientCount ?? 0} {summary?.clientCount === 1 ? "client" : "clients"}.{" "}
                {summary?.totalRoadmaps ?? 0} roadmaps generated to date.
              </>
            )}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link
              to="/clients"
              className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-3/40 px-3 py-1.5 text-[12px] font-medium text-obsidian-ink hover:border-signal hover:text-signal-ink transition-colors"
            >
              <Eye className="h-3.5 w-3.5" /> Open Seer® projects
            </Link>
            <Link
              to="/clients"
              className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-3/40 px-3 py-1.5 text-[12px] font-medium text-obsidian-ink hover:border-signal hover:text-signal-ink transition-colors"
            >
              <Building2 className="h-3.5 w-3.5" /> Client roster
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 lg:gap-4 rounded-xl border border-obsidian-line bg-obsidian/60 backdrop-blur-md p-4 lg:p-5">
          <PulseStat label="Clients" value={summary?.clientCount ?? 0} />
          <PulseStat label="Projects" value={summary?.projectCount ?? 0} />
          <PulseStat
            label="Last sync"
            value={lastSync}
            isText
          />
        </div>
      </div>
    </EditorialSection>
  );
}

function PulseStat({ label, value, isText }: { label: string; value: number | string; isText?: boolean }) {
  return (
    <div>
      <div className="type-eyebrow text-obsidian-ink-muted">{label}</div>
      <div
        className={cn(
          "mt-1.5 type-display text-obsidian-ink tabular-nums",
          isText ? "text-[14px] font-normal leading-tight" : "text-[28px] leading-none",
        )}
        data-tabular
      >
        {value}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────── kpi ribbon ─── */

function UrlMonitorMini({ stats }: { stats: NonNullable<ReturnType<typeof useDashboardData>["summary"]>["urlMonitor"] }) {
  const total = Math.max(stats.total, 1);
  const segs = [
    { key: "good", value: stats.good, color: "hsl(var(--pos))" },
    { key: "warning", value: stats.warning, color: "hsl(var(--warn))" },
    { key: "critical", value: stats.critical, color: "hsl(var(--neg))" },
  ];
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunk">
        {segs.map((s) =>
          s.value > 0 ? (
            <div
              key={s.key}
              style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
              title={`${s.key}: ${s.value}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-pos" /> {stats.good} good
        </span>
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-warn" /> {stats.warning} warn
        </span>
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-neg" /> {stats.critical} crit
        </span>
      </div>
    </div>
  );
}

function KpiRibbon({ summary }: { summary: NonNullable<ReturnType<typeof useDashboardData>["summary"]> }) {
  const latest = summary.latestProject;
  const upcoming = summary.recentRoadmaps[0];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 animate-briefing-rise" style={{ animationDelay: "60ms" }}>
      {/* 1 — Latest client campaign in Seer (TP Revenue Uplift, matches Performance Dashboard) */}
      <BriefingCard
        eyebrow="Latest Seer® campaign"
        value={latest ? compactCurrency(latest.tpRevenueUplift) : "—"}
        delta={
          latest
            ? {
                value: 0,
                label: formatDistanceToNow(new Date(latest.createdAt), { addSuffix: true }),
                sub: "added",
                tone: "neutral",
              }
            : undefined
        }
        viz={
          latest && latest.seasonalityMonthly.some((v) => v > 0) ? (
            <CadenceStrip
              data={latest.seasonalityMonthly}
              labels={MONTH_LABELS}
              highlightIndex={new Date().getMonth()}
              width={96}
              height={32}
              ariaLabel="Monthly seasonality"
            />
          ) : null
        }
        insight={
          latest ? (
            <>
              <span className="not-italic font-semibold text-ink">{latest.clientName ?? "Client"}</span>
              {" · "}
              {latest.projectName}
              <span className="block text-[11px] text-ink-muted mt-0.5">TP Revenue Uplift · matches project dashboard</span>
            </>
          ) : (
            "No projects in Seer yet."
          )
        }
        action={
          latest
            ? {
                label: "Open project",
                to: latest.clientId
                  ? projectHome(latest.clientId, latest.projectId)
                  : `/navigator/${latest.projectId}`,
              }
            : undefined
        }
        confidence={latest ? "high" : null}
      />

      {/* 2 — Latest roadmap, with weekly cadence strip from real generated_at */}
      <BriefingCard
        eyebrow="Latest roadmap"
        value={upcoming ? format(new Date(upcoming.generatedAt), "d MMM") : "—"}
        unit={upcoming ? format(new Date(upcoming.generatedAt), "yyyy") : ""}
        delta={
          upcoming
            ? { value: 0, label: formatDistanceToNow(new Date(upcoming.generatedAt), { addSuffix: true }), tone: "neutral" }
            : undefined
        }
        viz={
          summary.roadmapCadenceWeekly.some((v) => v > 0) ? (
            <CadenceStrip
              data={summary.roadmapCadenceWeekly}
              highlightIndex={11}
              width={96}
              height={32}
              ariaLabel="Roadmaps per week, last 12 weeks"
            />
          ) : null
        }
        insight={
          upcoming ? (
            <>
              {upcoming.clientName ?? "Project"} · <span className="not-italic">{upcoming.projectName}</span>
            </>
          ) : (
            "No roadmaps generated yet."
          )
        }
        action={
          upcoming
            ? {
                label: "Open latest roadmap",
                to: upcoming.clientId
                  ? projectHome(upcoming.clientId, upcoming.projectId)
                  : `/navigator/${upcoming.projectId}`,
              }
            : undefined
        }
        confidence={upcoming ? "high" : null}
      />


      {/* 4 — URL Monitor links */}
      <BriefingCard
        eyebrow="URL Monitor"
        value={compactNumber(summary.urlMonitor.total)}
        unit={summary.urlMonitor.total === 1 ? "link" : "links"}
        insight={<UrlMonitorMini stats={summary.urlMonitor} />}
        action={{ label: "Open URL Monitor", to: "/tools/url-monitor" }}
        confidence={summary.urlMonitor.critical > 0 ? "low" : summary.urlMonitor.warning > 0 ? "medium" : "high"}
      />
    </div>
  );
}

/* ─────────────────────────────────────────── revenue by client module ─── */

function RevenueByClientModule({ rows }: { rows: ClientRevenue[] }) {
  const top = rows.slice(0, 10);
  const totalTp = rows.reduce((s, r) => s + r.tpRevenueUplift, 0) || 1;

  const chartData = top.map((r) => ({
    name: r.clientName.length > 18 ? r.clientName.slice(0, 17) + "…" : r.clientName,
    rev: r.tpRevenueUplift,
  }));

  return (
    <EditorialSection
      eyebrow="Portfolio revenue"
      title="TP Revenue Uplift by client"
      dek="Annual revenue gain if every keyword reaches its Top Potential — matches each project's headline."
      className="animate-briefing-rise"
      actions={
        <Link to="/clients" className="text-[12px] font-semibold text-signal-ink hover:text-signal inline-flex items-center gap-1">
          All clients <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[3fr,2fr]">
        <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card">
          {top.length === 0 ? (
            <EmptyBlock icon={TrendingUp} message="No forecast revenue yet — generate a forecast in any Seer® project." />
          ) : (
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 28, top: 8, bottom: 8 }}>
                  <CartesianGrid {...gridProps} horizontal={false} />
                  <XAxis type="number" {...axisProps} tickFormatter={(v) => compactCurrency(v)} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={130} />
                  <Tooltip {...tooltipProps} formatter={(v: number) => [compactCurrency(v), "TP Revenue Uplift"]} />
                  <Bar dataKey="rev" radius={[0, 4, 4, 0]} barSize={18}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? chartColors.signal : i === 1 ? chartColors.signal2 : chartColors.ink} fillOpacity={i === 0 ? 1 : i === 1 ? 0.95 : 0.6} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-hairline bg-surface-sunk">
            <div className="type-eyebrow">Ranked book</div>
          </div>
          <ul className="divide-y divide-hairline">
            {top.length === 0 ? (
              <li className="p-6 text-center text-[13px] text-ink-muted">No active clients with forecasts.</li>
            ) : (
              top.map((r, i) => {
                const share = r.tpRevenueUplift / totalTp;
                return (
                  <li key={r.clientId}>
                    <Link
                      to={`/clients/${r.clientId}/edit`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-signal-soft/40 transition-colors"
                    >
                      <span className="type-mono text-[11px] text-ink-subtle w-5">{String(i + 1).padStart(2, "0")}</span>
                      <span className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{r.clientName}</div>
                        <div className="text-[11px] text-ink-muted truncate">
                          {r.projectCount} project{r.projectCount === 1 ? "" : "s"}
                          {r.domain ? ` · ${r.domain}` : ""}
                        </div>
                      </span>
                      <span className="text-right flex flex-col items-end gap-1">
                        <div className="type-mono text-[12px] font-semibold text-ink">
                          {compactCurrency(r.tpRevenueUplift)}
                        </div>
                        <ShareBar share={share} width={60} />
                      </span>
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </EditorialSection>
  );
}

/* ───────────────────────────────────────────────── roadmap pulse ─── */

function RoadmapPulse({ summary }: { summary: NonNullable<ReturnType<typeof useDashboardData>["summary"]> }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2 animate-briefing-rise">
      <EditorialSection
        eyebrow="Latest plans"
        title="Recently generated roadmaps"
        dek="The freshest strategic outputs across the book."
        bare
      >
        <div className="rounded-xl border border-hairline bg-surface shadow-card divide-y divide-hairline">
          {summary.recentRoadmaps.length === 0 ? (
            <EmptyBlock icon={Sparkles} message="Generate a Roadmap to Success in any Seer® project to seed this feed." />
          ) : (
            summary.recentRoadmaps.map((r) => (
              <Link
                key={r.id}
                to={r.clientId ? projectHome(r.clientId, r.projectId) : `/navigator/${r.projectId}`}
                className="block p-4 hover:bg-signal-soft/40 transition-colors group"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="type-eyebrow text-ink-muted">
                    {r.clientName ?? "Untitled client"}
                  </div>
                  <time className="type-mono text-[10px] text-ink-subtle">
                    {format(new Date(r.generatedAt), "d MMM yyyy")}
                  </time>
                </div>
                <h3 className="mt-1.5 text-[14px] font-semibold text-ink truncate group-hover:text-signal-ink transition-colors">
                  {r.projectName}
                </h3>
                <p className="mt-1.5 text-[12.5px] text-ink-muted leading-relaxed line-clamp-2">{r.excerpt || "—"}</p>
                <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-signal-ink">
                  Open roadmap <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            ))
          )}
        </div>
      </EditorialSection>

      <EditorialSection
        eyebrow="Insight"
        title="Where the portfolio leans"
        dek="A read on the shape of the work in flight."
        bare
      >
        <div className="rounded-xl surface-obsidian-flat border border-obsidian-line shadow-obsidian p-6">
          <InsightQuote tone="obsidian" size="md" attribution={`Across ${summary.projectCount} projects`}>
            {summary.totalRoadmaps > 0 ? (
              <>
                {summary.totalRoadmaps} roadmaps already in market —
                most of the modelled upside concentrates in the top three clients.
              </>
            ) : (
              <>The book is pre-roadmap. Generate plans in any project to start surfacing strategic patterns here.</>
            )}
          </InsightQuote>
          <div className="mt-6 grid grid-cols-2 gap-4">
            {Object.entries(summary.statusDistribution).slice(0, 6).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between border-b border-obsidian-line pb-2">
                <span className="type-eyebrow text-obsidian-ink-muted truncate">{k}</span>
                <span className="type-mono text-[14px] text-obsidian-ink">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </EditorialSection>
    </div>
  );
}

/* ─────────────────────────────────────────────── portfolio table ─── */

function PortfolioTable({ rows }: { rows: ClientRevenue[] }) {
  const totalTp = rows.reduce((s, r) => s + r.tpRevenueUplift, 0) || 1;
  return (
    <EditorialSection
      eyebrow="At a glance"
      title="Portfolio status"
      dek="Every active client, ranked by TP Revenue Uplift."
      className="animate-briefing-rise"
    >
      <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Projects</TableHead>
              <TableHead className="text-right">TP Revenue Uplift</TableHead>
              <TableHead className="text-right">Forecast clicks</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="text-right">Share of book</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-ink-muted py-10">
                  No clients with active projects yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const tone: "pos" | "warn" | "neutral" = r.tpRevenueUplift > 0 ? "pos" : r.projectCount > 0 ? "warn" : "neutral";
                const share = r.tpRevenueUplift / totalTp;
                return (
                  <TableRow key={r.clientId}>
                    <TableCell className="p-0 pl-0 w-1">
                      <div className="h-12 flex items-stretch">
                        <span className={cn(
                          "block w-[2px] rounded-full",
                          tone === "pos" ? "bg-pos" : tone === "warn" ? "bg-warn" : "bg-hairline-strong",
                        )} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link to={`/clients/${r.clientId}/edit`} className="font-medium text-ink hover:text-signal-ink">
                        {r.clientName}
                      </Link>
                      {r.domain && <div className="text-[11px] text-ink-muted">{r.domain}</div>}
                    </TableCell>
                    <TableCell className="text-right type-mono">{r.projectCount}</TableCell>
                    <TableCell className="text-right type-mono font-semibold">{compactCurrency(r.tpRevenueUplift)}</TableCell>
                    <TableCell className="text-right type-mono text-ink-muted">{compactNumber(r.forecastClicks)}</TableCell>
                    <TableCell className="text-[12px] text-ink-muted">
                      {r.lastSyncedAt ? formatDistanceToNow(new Date(r.lastSyncedAt), { addSuffix: true }) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <span className="type-mono text-[11px] text-ink-muted tabular-nums">
                          {(share * 100).toFixed(1)}%
                        </span>
                        <ShareBar share={share} width={60} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </EditorialSection>
  );
}

/* ───────────────────────────────────────────────── quick actions ─── */

function QuickActionsFooter() {
  // Recent items piped from CommandPalette localStorage key.
  const recents = useMemo(() => {
    try {
      const raw = localStorage.getItem("seer:recent-nav");
      return raw ? (JSON.parse(raw) as Array<{ label: string; path: string }>) : [];
    } catch {
      return [];
    }
  }, []);

  const { canEdit } = useAuth();

  return (
    <EditorialSection eyebrow="Pick up where you left off" bare className="animate-briefing-rise">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-surface p-5 shadow-card">
          <div className="type-eyebrow">Recent</div>
          {recents.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-muted">Nothing yet — open a client or project to start your trail.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {recents.map((r) => (
                <li key={r.path}>
                  <Link to={r.path} className="flex items-center gap-2 text-[13px] text-ink hover:text-signal-ink group">
                    <ArrowRight className="h-3.5 w-3.5 text-ink-subtle group-hover:text-signal" />
                    {r.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-5 shadow-card">
          <div className="type-eyebrow">Quick actions</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canEdit && (
              <>
                {/* TODO(nav-ia): no canonical "new project" route without a client context.
                    Keep legacy /navigator/new until a client picker step is added. */}
                <Button asChild variant="signal" size="sm">
                  <Link to="/navigator/new"><Plus className="h-3.5 w-3.5" /> New Seer® project</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/clients/new"><Plus className="h-3.5 w-3.5" /> New client</Link>
                </Button>
              </>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/audience-insights"><FileText className="h-3.5 w-3.5" /> Audience insights</Link>
            </Button>
          </div>
        </div>
      </div>
    </EditorialSection>
  );
}

/* ──────────────────────────────────────────────── empty state primitive ─── */

function EmptyBlock({ icon: Icon, message }: { icon: typeof TrendingUp; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="h-9 w-9 rounded-full bg-secondary text-ink-muted flex items-center justify-center">
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-3 max-w-sm text-[13px] text-ink-muted">{message}</p>
    </div>
  );
}

/* ──────────────────────────────────────────────── client portfolio ─── */

interface RecentNavEntry {
  label?: string;
  path?: string;
  clientId?: string;
  projectId?: string;
  openedAt?: string;
}

const RECENT_NAV_KEY = "seer:recent-nav:v2";
const LEGACY_PROJECT_PATH = /^\/navigator\/[^/]+$/;

/**
 * Read recents and drop legacy `/navigator/:id` entries. If anything was
 * dropped, persist the cleaned array so the same legacy entries don't
 * reappear on every load. Phase D, UX_AUDIT §3.1.
 */
function readAndNormaliseRecentProjects(): RecentNavEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_NAV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const all = parsed.filter((r): r is RecentNavEntry => r && typeof r === "object");
    const cleaned = all.filter(
      (r) => typeof r.path === "string" && !LEGACY_PROJECT_PATH.test(r.path),
    );

    if (cleaned.length !== all.length) {
      try {
        localStorage.setItem(RECENT_NAV_KEY, JSON.stringify(cleaned));
      } catch {
        /* ignore quota */
      }
    }

    return cleaned
      .filter((r) => typeof r.path === "string" && /\/projects\//.test(r.path as string))
      .slice(0, 6);
  } catch {
    return [];
  }
}

function RecentProjectsStrip() {
  const recents = useMemo(readAndNormaliseRecentProjects, []);
  if (recents.length === 0) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <span className="type-eyebrow shrink-0 text-ink-muted">Recently opened</span>
      <div className="flex items-center gap-2">
        {recents.map((r, i) => (
          <Link
            key={`${r.path}-${i}`}
            to={r.path!}
            className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-1 text-[12px] text-ink hover:border-signal hover:text-signal-ink transition-colors whitespace-nowrap"
          >
            <Eye className="h-3 w-3 opacity-60" />
            <span className="truncate max-w-[180px]">{r.label || "Project"}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}


interface ClientCardModel {
  client: ClientSummary;
  stats: ClientRevenue | null;
  latestProject: NavigatorProjectSummary | null;
}

function ClientPortfolioSection({
  clients,
  byClient,
  projects,
  isLoading,
}: {
  clients: ClientSummary[];
  byClient: ClientRevenue[];
  projects: NavigatorProjectSummary[];
  isLoading: boolean;
}) {
  const { canEdit } = useAuth();

  const cards: ClientCardModel[] = useMemo(() => {
    const statsByClient = new Map(byClient.map((b) => [b.clientId, b]));
    // projects is ordered by updated_at desc — first match is the latest.
    const latestByClient = new Map<string, NavigatorProjectSummary>();
    for (const p of projects) {
      if (!latestByClient.has(p.client_id)) latestByClient.set(p.client_id, p);
    }
    return clients.map((c) => ({
      client: c,
      stats: statsByClient.get(c.id) ?? null,
      latestProject: latestByClient.get(c.id) ?? null,
    }));
  }, [clients, byClient, projects]);

  return (
    <EditorialSection
      eyebrow="Your book"
      title="Client portfolio"
      dek="Every client you can access. Click through to open the client workspace."
      className="animate-briefing-rise"
      actions={
        canEdit ? (
          <Button asChild variant="signal" size="sm">
            <Link to="/clients/new">
              <Plus className="h-3.5 w-3.5" /> New client
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="mb-3">
        <RecentProjectsStrip />
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[148px] rounded-xl shimmer" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface p-8 text-center shadow-card">
          <div className="mx-auto h-9 w-9 rounded-full bg-secondary text-ink-muted flex items-center justify-center">
            <Building2 className="h-4 w-4" />
          </div>
          <p className="mt-3 text-[13px] text-ink-muted max-w-md mx-auto">
            You don't have access to any clients yet.
            {canEdit ? " Create your first client to get started." : " Ask an admin to grant access."}
          </p>
          {canEdit && (
            <Button asChild variant="signal" size="sm" className="mt-4">
              <Link to="/clients/new"><Plus className="h-3.5 w-3.5" /> New client</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <ClientCard key={card.client.id} card={card} canEdit={canEdit} />
          ))}
        </div>
      )}
    </EditorialSection>
  );
}

function ClientCard({ card, canEdit }: { card: ClientCardModel; canEdit: boolean }) {
  const { client, stats, latestProject } = card;
  const { data: clientLogoUrl } = useClientLogoUrl(client.logo_url);
  const projectCount = stats?.projectCount ?? 0;
  const lastSyncedAt = stats?.lastSyncedAt ?? null;
  const tpUplift = stats?.tpRevenueUplift ?? 0;

  return (
    <Link
      to={clientHome(client.id)}
      className="group relative flex flex-col rounded-xl border border-hairline bg-surface p-4 shadow-card transition-shadow hover:shadow-raised hover:border-signal/40"
    >
      <div className="flex items-start gap-3">
        {clientLogoUrl ? (
          <img
            src={clientLogoUrl}
            alt=""
            className="h-9 w-9 rounded-md border border-hairline object-cover bg-surface-sunk"
          />
        ) : (
          <div className="h-9 w-9 rounded-md border border-hairline bg-surface-sunk flex items-center justify-center text-ink-muted">
            <Building2 className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink truncate group-hover:text-signal-ink transition-colors">
            {client.company_name}
          </div>
          {client.domain && (
            <div className="text-[11px] text-ink-muted truncate">{client.domain}</div>
          )}
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-ink-subtle group-hover:text-signal transition-colors shrink-0 mt-1" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="type-eyebrow">Projects</div>
          <div className="mt-0.5 type-mono font-semibold text-ink tabular-nums">{projectCount}</div>
        </div>
        <div>
          <div className="type-eyebrow">TP Revenue</div>
          <div className="mt-0.5 type-mono font-semibold text-ink tabular-nums">
            {tpUplift > 0 ? compactCurrency(tpUplift) : "—"}
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-hairline pt-2.5 flex items-center justify-between gap-2 text-[11px] text-ink-muted">
        {latestProject ? (
          <span className="truncate">
            Latest:&nbsp;
            <span className="text-ink font-medium">{latestProject.project_name}</span>
          </span>
        ) : (
          <span className="italic">No projects yet</span>
        )}
        <span className="shrink-0 type-mono">
          {lastSyncedAt
            ? formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })
            : "—"}
        </span>
      </div>

      {projectCount === 0 && canEdit && (
        <div className="mt-2">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.location.assign(newClientProject(client.id));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                window.location.assign(newClientProject(client.id));
              }
            }}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-signal-ink hover:text-signal cursor-pointer"
          >
            <Plus className="h-3 w-3" /> Start first project
          </span>
        </div>
      )}
    </Link>
  );
}

/* ──────────────────────────────────────────────────────────── page ─── */

export default function DashboardPage() {
  const { summary, isLoading, error } = useDashboardData();
  const { clients, isLoading: clientsLoading } = useClients();
  const { projects } = useNavigatorProjects();
  const { canArchive } = useCanArchive();
  const { count: archivedClientsCount } = useArchivedClientsCount();

  if (isLoading || !summary) {
    return (
      <div className="space-y-6 max-w-[1400px] mx-auto">
        <div className="h-[220px] rounded-xl shimmer" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[200px] rounded-xl shimmer" />
          ))}
        </div>
        <div className="h-[360px] rounded-xl shimmer" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-neg/30 bg-neg-soft p-6 text-neg">
        Couldn't load the briefing. {String((error as Error).message ?? "")}
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-[1400px] mx-auto pb-12">
      <HeroBriefing summary={summary} />
      <KpiRibbon summary={summary} />
      {canArchive && archivedClientsCount > 0 && (
        <div className="rounded-xl border border-hairline bg-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-card">
          <div className="flex items-center gap-3 text-sm">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-amber-600">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>
            </span>
            <span className="text-ink">
              <span className="font-semibold">{archivedClientsCount}</span> archived{" "}
              {archivedClientsCount === 1 ? "client" : "clients"} hidden from the live workspace.
            </span>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={archivePath()}>Open archive</Link>
          </Button>
        </div>
      )}
      <ClientPortfolioSection
        clients={clients}
        byClient={summary.byClient}
        projects={projects}
        isLoading={clientsLoading}
      />
      <SiteArchitectureActionCard />
      <CaptureWindowCard summary={summary} />
      <RevenueByClientModule rows={summary.byClient} />
      <RoadmapPulse summary={summary} />
      <PortfolioTable rows={summary.byClient} />
      <QuickActionsFooter />
    </div>
  );
}

/* ─────────────────────────────────── capture window briefing card ─── */

function CaptureWindowCard({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof useDashboardData>["summary"]>;
}) {
  const cw = summary.captureWindow;
  const projectCount = cw.projectIds.size;
  const clientCount = cw.clientIds.size;

  if (cw.totalKeywords === 0) {
    // Quiet state — keep the row position predictable.
    return (
      <EditorialSection
        eyebrow="Content planner"
        title="Nothing entering peak demand right now"
        dek="Keywords will appear here when they're 8–16 weeks from their seasonal peak."
        bare
        className="animate-briefing-rise"
      >
        <div className="rounded-xl border border-hairline bg-surface p-6 text-[13px] text-ink-muted">
          Sync a Seer® project to refresh peak-month detection.
        </div>
      </EditorialSection>
    );
  }

  return (
    <Link
      to="/capture-window"
      aria-label={`View ${cw.totalKeywords} keywords entering content planning window`}
      className="block group animate-briefing-rise"
    >
      <article className="relative overflow-hidden rounded-xl border border-hairline bg-surface shadow-card transition-shadow hover:shadow-raised">
        {/* Brand wash on the right */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <div
            className="absolute inset-0 opacity-90"
            style={{
              background: [
                "radial-gradient(ellipse 40% 90% at 100% 0%, hsl(44 99% 55% / 0.18), transparent 60%)",
                "radial-gradient(ellipse 35% 80% at 100% 100%, hsl(182 80% 38% / 0.22), transparent 65%)",
              ].join(", "),
            }}
          />
        </div>

        <div className="relative z-10 grid gap-6 p-6 lg:grid-cols-[1.1fr,1fr]">
          {/* Left — hero */}
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <div className="type-eyebrow inline-flex items-center gap-1.5">
                <CalendarClock className="h-3 w-3" /> Content planner
              </div>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-signal-ink opacity-0 group-hover:opacity-100 transition-opacity">
                Open queue <ArrowRight className="h-3 w-3" />
              </span>
            </div>

            <div
              className="mt-3 type-display tabular-nums leading-[1] text-[64px] text-ink text-gradient-signal"
              data-tabular
            >
              {cw.totalKeywords}
            </div>
            <p className="mt-2 text-[15px] font-medium text-ink leading-snug">
              keywords are <span className="text-signal-ink">~3 months</span> from peak demand
            </p>

            <div className="mt-5 grid grid-cols-2 gap-4 max-w-md">
              <div>
                <div className="type-eyebrow">Combined upside</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-ink">
                  {compactCurrency(cw.totalRevenue)}
                </div>
                <div className="text-[11px] text-ink-muted">/ yr at rank 1</div>
              </div>
              <div>
                <div className="type-eyebrow">Across</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-ink">
                  {projectCount} project{projectCount === 1 ? "" : "s"}
                </div>
                <div className="text-[11px] text-ink-muted">
                  {clientCount} client{clientCount === 1 ? "" : "s"}
                </div>
              </div>
            </div>
          </div>

          {/* Right — top movers */}
          <div className="min-w-0 lg:border-l lg:border-hairline lg:pl-6">
            <div className="type-eyebrow">Top movers this week</div>
            <ul className="mt-3 divide-y divide-hairline">
              {cw.topMovers.length === 0 ? (
                <li className="py-4 text-[12.5px] text-ink-muted">
                  No qualifying movers yet — sync a project to refresh.
                </li>
              ) : (
                cw.topMovers.map((kw) => (
                  <li key={kw.keywordId} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">
                        {kw.keyword}
                      </div>
                      <div className="text-[11px] text-ink-muted truncate">
                        {kw.weeksToPeak}w to peak · {kw.projectName}
                      </div>
                    </div>
                    <div className="type-mono text-[12px] font-semibold text-ink tabular-nums shrink-0">
                      {compactCurrency(kw.revenueAtRank1)}
                    </div>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-signal-ink group-hover:text-signal transition-colors">
              View capture queue <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
}
