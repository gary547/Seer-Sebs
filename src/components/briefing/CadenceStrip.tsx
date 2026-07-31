import * as React from "react";
import { cn } from "@/lib/utils";

interface CadenceStripProps {
  /** Bucket values (e.g. 12 months or 12 weeks). Empty/undefined renders nothing. */
  data: number[];
  /** Optional bucket labels — index 0 = current bucket marker for week mode, etc. */
  labels?: string[];
  /** Highlight the bucket at this index (e.g. current month). */
  highlightIndex?: number;
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Tiny bar strip for displaying real bucketed time-series (e.g. monthly seasonality,
 * weekly roadmap cadence). Single signal accent, hairline baseline. Replaces
 * the fake `pseudoTrend` sparkline in dashboard briefing cards.
 */
export function CadenceStrip({
  data,
  labels,
  highlightIndex,
  width = 96,
  height = 32,
  className,
  ariaLabel = "Cadence",
}: CadenceStripProps) {
  if (!data || data.length === 0) {
    return <div className={cn("h-[32px] w-24", className)} aria-hidden />;
  }
  const max = Math.max(...data, 1);
  const gap = 2;
  const barW = Math.max(1, (width - gap * (data.length - 1)) / data.length);
  const baseline = height - 1;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={ariaLabel}
    >
      {/* hairline baseline */}
      <line x1={0} x2={width} y1={baseline} y2={baseline} stroke="hsl(var(--hairline))" strokeWidth={0.5} />
      {data.map((v, i) => {
        const h = v > 0 ? Math.max(1.5, (v / max) * (height - 3)) : 0;
        const x = i * (barW + gap);
        const y = baseline - h;
        const isHighlight = highlightIndex === i;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={0.75}
            fill={isHighlight ? "hsl(var(--signal))" : "hsl(var(--signal) / 0.55)"}
          >
            {labels?.[i] != null && <title>{labels[i]}: {v}</title>}
          </rect>
        );
      })}
    </svg>
  );
}
