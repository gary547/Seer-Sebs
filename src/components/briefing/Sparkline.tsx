import * as React from "react";
import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Stroke colour CSS value. Defaults to currentColor so it inherits text colour. */
  stroke?: string;
  /** Soft fill area beneath the line. */
  fill?: string;
  className?: string;
  strokeWidth?: number;
}

/**
 * Tiny dependency-free sparkline. Draws a single polyline with optional area fill.
 * Designed for briefing cards & table rows — no axes, no chrome.
 */
export function Sparkline({
  data,
  width = 96,
  height = 28,
  stroke = "currentColor",
  fill,
  className,
  strokeWidth = 1.5,
}: SparklineProps) {
  if (!data || data.length < 2) {
    return <div className={cn("h-[28px] w-24", className)} aria-hidden />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = strokeWidth;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("overflow-visible", className)}
      role="img"
      aria-label="Trend"
    >
      {fill && <path d={areaPath} fill={fill} />}
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
