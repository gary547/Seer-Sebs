import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

interface DeltaChipProps {
  /** Signed numeric delta. Sign is used for direction; magnitude formatted via `format`. */
  value: number | null | undefined;
  /** Optional pre-formatted label (e.g. "+12.4%"). When provided, value is only used for sign. */
  label?: string;
  /** "higher-is-good" (default) flips colours when value < 0. Use "neutral" to suppress colour. */
  tone?: "higher-is-good" | "lower-is-good" | "neutral";
  size?: "sm" | "md";
  className?: string;
  /** Suppress arrow icon. */
  bare?: boolean;
}

export function DeltaChip({ value, label, tone = "higher-is-good", size = "sm", className, bare }: DeltaChipProps) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const direction: "up" | "down" | "flat" = v > 0.0001 ? "up" : v < -0.0001 ? "down" : "flat";

  const isGood =
    tone === "neutral"
      ? null
      : tone === "higher-is-good"
        ? direction === "up"
        : direction === "down";

  const colour =
    direction === "flat" || tone === "neutral"
      ? "text-ink-muted bg-secondary"
      : isGood
        ? "text-pos bg-pos-soft"
        : "text-neg bg-neg-soft";

  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  const display = label ?? `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md font-mono font-medium tabular-nums",
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
        colour,
        className,
      )}
      data-tabular
    >
      {!bare && <Icon className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5", "-ml-0.5")} />}
      {display}
    </span>
  );
}
