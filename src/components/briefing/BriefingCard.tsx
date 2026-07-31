import * as React from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { DeltaChip } from "./DeltaChip";
import { Sparkline } from "./Sparkline";

export type Confidence = "high" | "medium" | "low" | null;

interface BriefingCardProps {
  eyebrow: React.ReactNode;
  /** Hero metric — usually a number. Rendered in display serif. */
  value: React.ReactNode;
  /** Small unit suffix or prefix shown alongside the hero value. */
  unit?: string;
  /** Optional pre-formatted delta (e.g. "+12.4% vs prior 28d"). */
  delta?: { value: number; label?: string; sub?: string; tone?: "higher-is-good" | "lower-is-good" | "neutral" };
  /** Trend line — last N values. */
  trend?: number[];
  /** Custom visualisation node, rendered in place of the trend sparkline. Takes precedence over `trend`. */
  viz?: React.ReactNode;
  /** One-line editorial insight (italic serif). */
  insight?: React.ReactNode;
  /** Recommended next step. */
  action?: { label: string; to?: string; onClick?: () => void };
  confidence?: Confidence;
  className?: string;
  /** Use the dark obsidian variant — for hero strip on dashboard. */
  tone?: "light" | "obsidian";
}

const confDot: Record<Exclude<Confidence, null>, string> = {
  high: "bg-pos",
  medium: "bg-warn",
  low: "bg-neg",
};

export function BriefingCard({
  eyebrow,
  value,
  unit,
  delta,
  trend,
  viz,
  insight,
  action,
  confidence,
  className,
  tone = "light",
}: BriefingCardProps) {
  const dark = tone === "obsidian";
  return (
    <article
      className={cn(
        "group relative flex flex-col rounded-xl transition-shadow",
        dark
          ? "surface-obsidian-flat border border-obsidian-line p-5 shadow-obsidian"
          : "bg-surface border border-hairline p-5 shadow-card hover:shadow-raised",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className={cn("type-eyebrow", dark && "text-obsidian-ink-muted")}>{eyebrow}</div>
        {confidence && (
          <span className="flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", confDot[confidence])} aria-hidden />
            <span className={cn("text-[10px] uppercase tracking-[0.14em] font-semibold", dark ? "text-obsidian-ink-muted" : "text-ink-subtle")}>
              {confidence}
            </span>
          </span>
        )}
      </header>

      <div className="mt-3 flex flex-col gap-2">
        <div
          className={cn(
            "type-display tabular-nums leading-[1.05] whitespace-nowrap min-w-0",
            dark ? "text-obsidian-ink" : "text-ink text-gradient-signal",
            "text-[clamp(28px,3.4vw,40px)]",
          )}
          data-tabular
        >
          {value}
          {unit && (
            <span className={cn("ml-1 text-[16px] font-normal", dark ? "text-obsidian-ink-muted" : "text-ink-muted")} style={{ WebkitTextFillColor: "currentColor" }}>
              {unit}
            </span>
          )}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            {delta && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <DeltaChip value={delta.value} label={delta.label} tone={delta.tone ?? "higher-is-good"} />
                {delta.sub && (
                  <span className={cn("text-[11px]", dark ? "text-obsidian-ink-muted" : "text-ink-muted")}>
                    {delta.sub}
                  </span>
                )}
              </div>
            )}
          </div>
          {viz ? (
            <div className="shrink-0" aria-hidden>{viz}</div>
          ) : trend && trend.length > 1 ? (
            <div className={cn("shrink-0", dark ? "text-signal" : "text-signal")} aria-hidden>
              <Sparkline data={trend} width={84} height={32} fill="hsl(var(--signal) / 0.12)" />
            </div>
          ) : null}
        </div>
      </div>

      {insight && (
        <div
          className={cn(
            "type-insight mt-4 text-[14px] leading-snug",
            dark ? "text-obsidian-ink/90" : "text-ink/85",
          )}
        >
          {insight}
        </div>
      )}

      {action && (
        <>
          <div className={cn("mt-4 border-t", dark ? "border-obsidian-line" : "border-hairline")} />
          <div className="mt-3">
            {action.to ? (
              <Link
                to={action.to}
                className={cn(
                  "inline-flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.02em] transition-colors",
                  dark ? "text-signal hover:text-signal/80" : "text-signal-ink hover:text-signal",
                )}
              >
                {action.label}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : (
              <button
                onClick={action.onClick}
                className={cn(
                  "inline-flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.02em] transition-colors",
                  dark ? "text-signal hover:text-signal/80" : "text-signal-ink hover:text-signal",
                )}
              >
                {action.label}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}
