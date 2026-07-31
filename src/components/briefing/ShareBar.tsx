import * as React from "react";
import { cn } from "@/lib/utils";

interface ShareBarProps {
  /** Share as a fraction 0..1 of the total. */
  share: number;
  width?: number;
  className?: string;
}

/** Tiny horizontal bar showing share-of-total — replaces fake sparkline in client list. */
export function ShareBar({ share, width = 60, className }: ShareBarProps) {
  const pct = Math.max(0, Math.min(1, share || 0));
  return (
    <div
      className={cn("inline-block h-[3px] rounded-full bg-hairline overflow-hidden", className)}
      style={{ width }}
      role="img"
      aria-label={`Share ${(pct * 100).toFixed(1)}%`}
    >
      <div className="h-full rounded-full bg-signal" style={{ width: `${pct * 100}%` }} />
    </div>
  );
}
