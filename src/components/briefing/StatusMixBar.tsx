import * as React from "react";
import { cn } from "@/lib/utils";

interface StatusMixBarProps {
  /** Map of status → count. Order respected. */
  distribution: Record<string, number>;
  className?: string;
  /** Show legend chips beneath the bar. */
  showLegend?: boolean;
}

/** Status palette using semantic tokens — kept in one place so the bar + chips agree. */
const STATUS_COLORS: Record<string, string> = {
  draft: "hsl(var(--ink-subtle))",
  "data collection": "hsl(var(--warn))",
  forecast: "hsl(var(--signal) / 0.7)",
  active: "hsl(var(--signal))",
  review: "hsl(var(--accent-2, var(--signal)))",
  complete: "hsl(var(--pos))",
};

function colourFor(status: string) {
  return STATUS_COLORS[status.toLowerCase()] ?? "hsl(var(--ink-subtle))";
}

/**
 * Segmented horizontal bar showing project status mix.
 * Modelled on the existing UrlMonitorMini for visual consistency.
 */
export function StatusMixBar({ distribution, className, showLegend = true }: StatusMixBarProps) {
  const entries = Object.entries(distribution).filter(([, v]) => v > 0);
  const total = Math.max(
    entries.reduce((s, [, v]) => s + v, 0),
    1,
  );
  if (entries.length === 0) {
    return <div className={cn("h-2 w-full rounded-full bg-surface-sunk", className)} aria-hidden />;
  }
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunk">
        {entries.map(([k, v]) => (
          <div
            key={k}
            style={{ width: `${(v / total) * 100}%`, background: colourFor(k) }}
            title={`${k}: ${v}`}
          />
        ))}
      </div>
      {showLegend && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
          {entries.map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: colourFor(k) }} />
              {v} {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
