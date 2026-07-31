import { HelpCircle } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { METRIC_GLOSSARY, type MetricKey } from "@/lib/metricGlossary";
import { cn } from "@/lib/utils";

interface MetricHelpProps {
  metric: MetricKey;
  /** What to render as the trigger. Defaults to a small (?) icon next to the label. */
  children?: React.ReactNode;
  /** Optional override for the displayed label (defaults to glossary label). */
  label?: React.ReactNode;
  /** Layout helper for table headers. */
  align?: "left" | "right" | "center";
  className?: string;
}

/**
 * Inline label + (?) help affordance backed by the central metric glossary.
 *
 * Usage:
 *   <MetricHelp metric="UR" />            // renders "URL Rating (UR) (?)"
 *   <MetricHelp metric="TP" label="TP" /> // custom label, same definition
 */
export function MetricHelp({
  metric,
  children,
  label,
  align = "left",
  className,
}: MetricHelpProps) {
  const entry = METRIC_GLOSSARY[metric];
  const displayLabel = label ?? entry.label;

  const alignment =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "justify-start";

  return (
    <span className={cn("inline-flex items-center gap-1", alignment, className)}>
      {children ?? <span>{displayLabel}</span>}
      <HoverCard openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`What is ${entry.label}?`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
            onClick={(e) => e.stopPropagation()}
          >
            <HelpCircle className="h-3 w-3" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="center"
          className="w-72 space-y-2 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="font-semibold text-sm leading-tight">{entry.label}</p>
          <p className="text-muted-foreground leading-snug">{entry.short}</p>
          {entry.detail && (
            <p className="text-muted-foreground leading-snug">{entry.detail}</p>
          )}
          {entry.source && (
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Source: {entry.source}
            </p>
          )}
        </HoverCardContent>
      </HoverCard>
    </span>
  );
}

export default MetricHelp;
