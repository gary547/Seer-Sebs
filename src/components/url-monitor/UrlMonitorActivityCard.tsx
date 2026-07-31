import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/briefing/Sparkline";
import { getMonitorCampaignHistory } from "@/integrations/gcp/url-monitor";
import { Activity } from "lucide-react";

type Props = {
  campaignId: string;
  refreshKey?: number;
};

const WINDOW_DAYS = 14;

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function UrlMonitorActivityCard({ campaignId, refreshKey }: Props) {
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<{ checked_at: string }[]>([]);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [nextCheck, setNextCheck] = useState<string | null>(null);
  const [activeUrlCount, setActiveUrlCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const history = await getMonitorCampaignHistory(campaignId, WINDOW_DAYS);
      const active = history.urls.filter((url) => url.is_active);
      const last = active
        .map((url) => url.last_checked_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .pop() ?? null;
      const next = active
        .map((url) => url.next_check_at)
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null;

      if (history.urls.length === 0) {
        if (!cancelled) {
          setSnapshots([]);
          setLastChecked(null);
          setNextCheck(null);
          setActiveUrlCount(0);
          setLoading(false);
        }
        return;
      }

      if (cancelled) return;
      setSnapshots(
        history.snapshots.map((snapshot) => ({
          checked_at: snapshot.checked_at,
        })),
      );
      setLastChecked(last);
      setNextCheck(next);
      setActiveUrlCount(active.length);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [campaignId, refreshKey]);

  const { todayCount, totalCount, sparkData } = useMemo(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      days.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    const counts = new Map<string, number>(days.map((d) => [d, 0]));
    for (const s of snapshots) {
      const k = dayKey(s.checked_at);
      if (counts.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const arr = days.map((d) => counts.get(d) || 0);
    const todayKey = days[days.length - 1];
    return {
      todayCount: counts.get(todayKey) || 0,
      totalCount: arr.reduce((a, b) => a + b, 0),
      sparkData: arr,
    };
  }, [snapshots]);

  if (loading) {
    return <Card className="p-5 h-[120px] animate-pulse bg-muted/30" />;
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-signal/10 text-signal flex items-center justify-center shrink-0">
            <Activity className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="type-eyebrow">Monitor activity</div>
            <div className="mt-1 flex items-baseline gap-2 flex-wrap">
              <span className="type-display text-[28px] leading-none tabular-nums text-gradient-signal">{todayCount}</span>
              <span className="text-sm text-ink-muted">checks today</span>
            </div>
            <div className="text-xs text-ink-muted mt-1.5">
              {totalCount} checks · last {WINDOW_DAYS} days · {activeUrlCount} active URL{activeUrlCount === 1 ? "" : "s"}
            </div>
            <div className="text-xs text-ink-muted mt-1">
              Last check {formatRelative(lastChecked)}
              {nextCheck ? ` · next ${formatRelative(nextCheck).replace(" ago", "").replace("just now", "now")}` : ""}
            </div>
          </div>
        </div>
        <div className="text-signal shrink-0 self-center">
          <Sparkline
            data={sparkData}
            width={160}
            height={44}
            fill="hsl(var(--signal) / 0.12)"
            strokeWidth={1.75}
          />
        </div>
      </div>
    </Card>
  );
}
