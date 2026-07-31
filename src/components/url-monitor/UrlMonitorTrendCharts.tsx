import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend,
} from "recharts";
import { Card } from "@/components/ui/card";
import { getMonitorCampaignHistory } from "@/integrations/gcp/url-monitor";
import { axisProps, gridProps, tooltipProps, brand } from "@/lib/chartTheme";
import { cn } from "@/lib/utils";

type Snapshot = {
  monitored_url_id: string;
  checked_at: string;
  http_status: number | null;
};

type IssueRow = {
  snapshot_id: string;
  severity: string;
};

type Props = {
  campaignId: string;
  /** Bump to force a refresh after a check is run. */
  refreshKey?: number;
};

type Status = "critical" | "warning" | "good";

const MAX_DAYS = 90;
type WindowChoice = "auto" | 14 | 30 | 90;

function classify(s: Snapshot, criticalSnaps: Set<string>, warningSnaps: Set<string>, snapshotId: string): Status {
  if (s.http_status === null || s.http_status >= 400) return "critical";
  if (criticalSnaps.has(snapshotId)) return "critical";
  if (warningSnaps.has(snapshotId)) return "warning";
  return "good";
}

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export default function UrlMonitorTrendCharts({ campaignId, refreshKey }: Props) {
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<(Snapshot & { id: string })[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [urlIds, setUrlIds] = useState<string[]>([]);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("auto");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const history = await getMonitorCampaignHistory(campaignId, MAX_DAYS);
      const ids = history.urls.map((url) => url.id);
      if (ids.length === 0) {
        if (!cancelled) { setSnapshots([]); setIssues([]); setUrlIds([]); setLoading(false); }
        return;
      }
      if (cancelled) return;
      setUrlIds(ids);
      setSnapshots(
        history.snapshots.map((snapshot) => ({
          checked_at: snapshot.checked_at,
          http_status: snapshot.http_status,
          id: snapshot.id,
          monitored_url_id: snapshot.monitored_url_id,
        })),
      );
      setIssues(
        history.issues.map((issue) => ({
          severity: issue.severity,
          snapshot_id: issue.snapshot_id,
        })),
      );
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [campaignId, refreshKey]);

  // Effective window: clamp to days since first snapshot when "auto".
  const effectiveDays = useMemo(() => {
    if (typeof windowChoice === "number") return windowChoice;
    if (snapshots.length === 0) return MAX_DAYS;
    const first = new Date(snapshots[0].checked_at);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const diffDays = Math.floor((today.getTime() - first.getTime()) / 86_400_000) + 1;
    return Math.max(1, Math.min(MAX_DAYS, diffDays));
  }, [snapshots, windowChoice]);

  const { dailySeries, periodSeries, hasData, allHealthy } = useMemo(() => {
    const criticalSnaps = new Set(issues.filter((i) => i.severity === "critical").map((i) => i.snapshot_id));
    const warningSnaps = new Set(issues.filter((i) => i.severity === "warning").map((i) => i.snapshot_id));

    const perUrlByDay = new Map<string, Map<string, Status>>();
    for (const s of snapshots as (Snapshot & { id: string })[]) {
      const k = dayKey(s.checked_at);
      const status = classify(s, criticalSnaps, warningSnaps, s.id);
      let m = perUrlByDay.get(s.monitored_url_id);
      if (!m) { m = new Map(); perUrlByDay.set(s.monitored_url_id, m); }
      m.set(k, status);
    }

    const days: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = effectiveDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      days.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }

    const dailySeries = days.map((dk) => {
      let critical = 0, warning = 0, good = 0;
      for (const urlId of urlIds) {
        const m = perUrlByDay.get(urlId);
        if (!m) continue;
        let status: Status | undefined;
        for (let i = days.indexOf(dk); i >= 0; i--) {
          const candidate = m.get(days[i]);
          if (candidate) { status = candidate; break; }
        }
        if (!status) continue;
        if (status === "critical") critical++;
        else if (status === "warning") warning++;
        else good++;
      }
      const d = new Date(dk + "T00:00:00Z");
      return {
        date: dk,
        label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        critical, warning, good,
      };
    });

    // Period checkpoints relative to current window
    const checkpoints = Array.from(new Set([effectiveDays, 60, 30, 0].filter((n) => n <= effectiveDays))).sort((a, b) => b - a);
    const periodSeries = checkpoints.map((offset) => {
      const idx = effectiveDays - 1 - offset;
      if (idx < 0 || idx >= dailySeries.length) {
        return { period: offset === 0 ? "Today" : `${offset}d ago`, critical: 0, warning: 0, good: 0 };
      }
      const row = dailySeries[idx];
      return {
        period: offset === 0 ? "Today" : `${offset}d ago`,
        critical: row.critical,
        warning: row.warning,
        good: row.good,
      };
    });

    const hasData = snapshots.length > 0;
    const allHealthy = hasData && dailySeries.every((r) => r.critical === 0 && r.warning === 0);
    return { dailySeries, periodSeries, hasData, allHealthy };
  }, [snapshots, issues, urlIds, effectiveDays]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4 h-[260px] animate-pulse bg-muted/30" />
        <Card className="p-4 h-[260px] animate-pulse bg-muted/30" />
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-6 h-[260px] flex items-center justify-center text-sm text-ink-muted text-center">
          No snapshots yet — run a check to start building history.
        </Card>
        <Card className="p-6 h-[260px] flex items-center justify-center text-sm text-ink-muted text-center">
          No snapshots yet — comparison will appear after a few checks.
        </Card>
      </div>
    );
  }

  const windowOptions: { label: string; value: WindowChoice }[] = [
    { label: "Auto", value: "auto" },
    { label: "14d", value: 14 },
    { label: "30d", value: 30 },
    { label: "90d", value: 90 },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <div className="type-eyebrow">Daily status · last {effectiveDays} day{effectiveDays === 1 ? "" : "s"}</div>
            <div className="text-xs text-ink-muted mt-0.5">Stacked count of URLs in each state, per day.</div>
          </div>
          <div className="inline-flex rounded-md border border-hairline overflow-hidden text-[11px]" role="tablist">
            {windowOptions.map((opt) => {
              const active = windowChoice === opt.value;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setWindowChoice(opt.value)}
                  className={cn(
                    "px-2 py-1 transition-colors",
                    active ? "bg-signal/10 text-signal font-semibold" : "text-ink-muted hover:bg-muted/50",
                  )}
                  aria-pressed={active}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="relative h-[200px] mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailySeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gCritical" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={brand.coral} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={brand.coral} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gWarning" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={brand.amber} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={brand.amber} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gGood" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={brand.teal} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={brand.teal} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={28} />
              <YAxis {...axisProps} allowDecimals={false} />
              <Tooltip {...tooltipProps} />
              <Area type="monotone" stackId="1" dataKey="good" stroke={brand.teal} strokeWidth={0} fill="url(#gGood)" name="Good" isAnimationActive={false} activeDot={false} />
              <Area type="monotone" stackId="1" dataKey="warning" stroke={brand.amber} strokeWidth={0} fill="url(#gWarning)" name="Warning" isAnimationActive={false} activeDot={false} />
              <Area type="monotone" stackId="1" dataKey="critical" stroke={brand.coral} strokeWidth={0} fill="url(#gCritical)" name="Critical" isAnimationActive={false} activeDot={false} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            </AreaChart>
          </ResponsiveContainer>
          {allHealthy && (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-3">
              <span className="px-2.5 py-1 rounded-full bg-signal/10 text-signal text-[11px] font-medium border border-signal/30">
                All URLs healthy — no status variation to plot
              </span>
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <div className="type-eyebrow mb-1">Progress · checkpoints vs today</div>
        <div className="text-xs text-ink-muted mb-2">Status mix at each checkpoint to showcase change over time.</div>
        <div className="relative h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={periodSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="period" {...axisProps} />
              <YAxis {...axisProps} allowDecimals={false} />
              <Tooltip {...tooltipProps} cursor={{ fill: "hsl(var(--ink-subtle) / 0.08)" }} />
              <Bar dataKey="good" stackId="a" fill={brand.teal} name="Good" radius={[0, 0, 0, 0]} />
              <Bar dataKey="warning" stackId="a" fill={brand.amber} name="Warning" />
              <Bar dataKey="critical" stackId="a" fill={brand.coral} name="Critical" radius={[4, 4, 0, 0]} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            </BarChart>
          </ResponsiveContainer>
          {allHealthy && (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-3">
              <span className="px-2.5 py-1 rounded-full bg-signal/10 text-signal text-[11px] font-medium border border-signal/30">
                No status changes across checkpoints
              </span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
