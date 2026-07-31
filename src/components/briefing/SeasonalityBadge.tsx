import * as React from "react";
import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * SeasonalityBadge — visually signals that a keyword aligns
 * revenue opportunity AND timing (capture window).
 *
 * Earning rules (decided by the caller — usually compute-forecasts):
 *  1) is_in_capture_window = true (8–16 weeks from peak)
 *  2) yearly_revenue_gain_rank1 ≥ project median (material upside)
 *  3) detox_status = 'keep'
 *
 * Two intensities: "solid" (act now — top quartile revenue) and
 * "outline" (watch — median-tier revenue). A muted "past" chip is shown
 * when the keyword's peak has already happened.
 */

export type SeasonalityIntensity = "solid" | "outline" | "past";

export interface SeasonalityBadgeProps {
  intensity: SeasonalityIntensity;
  weeksToPeak: number;
  /** Calendar peak month label, e.g. "Nov 2026". */
  peakMonthLabel?: string | null;
  /** Annual revenue uplift at rank 1 — used in the tooltip copy. */
  revenueAtRank1?: number | null;
  /** Where the peak signal came from. Affects tooltip wording. */
  peakSource?: "keyword_volume" | "project_window" | null;
  /** Compact — drop the "Capture · " prefix; shrink padding. */
  compact?: boolean;
  className?: string;
}

const formatGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);

export function SeasonalityBadge({
  intensity,
  weeksToPeak,
  peakMonthLabel,
  revenueAtRank1,
  peakSource,
  compact,
  className,
}: SeasonalityBadgeProps) {
  // ── Past peak — muted, no gradient
  if (intensity === "past") {
    const label = peakMonthLabel ? `Peak passed · plan for ${peakMonthLabel}` : "Peak passed";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-sunk px-2 py-0.5 text-[10px] font-medium text-ink-muted whitespace-nowrap",
          className,
        )}
        title={label}
      >
        {label}
      </span>
    );
  }

  const weeksLabel = `${Math.max(weeksToPeak, 0)}w to peak`;
  const prefix = compact ? "" : "Capture · ";

  const tooltipText = (
    <div className="max-w-[260px] space-y-1.5">
      <p className="text-[12px] font-semibold leading-snug">
        Capture window — {weeksLabel}
      </p>
      <p className="text-[11.5px] leading-relaxed opacity-90">
        {peakMonthLabel ? (
          <>Peak demand lands in {peakMonthLabel}. </>
        ) : null}
        SEO needs ≈12 weeks to take effect — start now to capture this year's
        spike
        {revenueAtRank1
          ? `. Estimated upside ${formatGBP(revenueAtRank1)} / yr at rank 1.`
          : "."}
      </p>
      {peakSource === "project_window" && (
        <p className="text-[10.5px] uppercase tracking-wider opacity-60">
          Peak inferred from project seasonality
        </p>
      )}
    </div>
  );

  // ── In window — gradient signal
  const isSolid = intensity === "solid";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "relative inline-flex items-center gap-1 rounded-full whitespace-nowrap font-semibold leading-none transition-shadow",
              compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]",
              "border",
              isSolid
                ? // Solid: filled gradient + white-ish ink (works in both themes)
                  "border-transparent text-[hsl(var(--obsidian-ink))] shadow-[0_2px_10px_-3px_hsl(182_80%_38%/0.55)]"
                : // Outline: gradient stroke effect via mask + signal-tinted ink
                  "border-signal/40 bg-signal-soft/40 text-signal-ink",
              className,
            )}
            style={
              isSolid
                ? {
                    backgroundImage:
                      "linear-gradient(135deg, hsl(182 80% 38%) 0%, hsl(9 78% 62%) 100%)",
                  }
                : undefined
            }
            aria-label={`Capture window, ${weeksLabel}${
              peakMonthLabel ? `, peak ${peakMonthLabel}` : ""
            }`}
          >
            <CalendarClock
              className={cn(
                "shrink-0",
                compact ? "h-2.5 w-2.5" : "h-3 w-3",
                isSolid ? "text-[hsl(44_99%_85%)]" : "text-signal",
              )}
              aria-hidden
            />
            <span>
              {prefix}
              {weeksLabel}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="bg-obsidian text-obsidian-ink border-obsidian-line">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ─── Helpers shared with the page + dashboard card ──────────────── */

/** Map weeks-to-peak + revenue band → badge intensity. */
export function deriveIntensity(args: {
  weeksToPeak: number;
  isInCaptureWindow: boolean;
  revenueAtRank1: number;
  projectTopQuartileRevenue: number;
}): SeasonalityIntensity | null {
  if (args.weeksToPeak < 0) return "past";
  if (!args.isInCaptureWindow) return null;
  return args.revenueAtRank1 >= args.projectTopQuartileRevenue ? "solid" : "outline";
}

/** Format a peak month code (1–12) + year hint into "Nov 2026". */
export function formatPeakMonth(peakMonth: string | null | undefined, year?: number): string | null {
  if (!peakMonth) return null;
  const m = parseInt(peakMonth, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const y = year ?? (() => {
    // If the peak month is earlier than this month, assume next year's peak.
    const now = new Date();
    return m >= now.getMonth() + 1 ? now.getFullYear() : now.getFullYear() + 1;
  })();
  return `${months[m - 1]} ${y}`;
}
