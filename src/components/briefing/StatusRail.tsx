import * as React from "react";
import { cn } from "@/lib/utils";

interface StatusRailProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: "pos" | "neg" | "warn" | "neutral" | "signal";
}

/**
 * 2px left rail used at the start of editorial table rows / list items
 * to convey row-level status without pill spam.
 */
export function StatusRail({ tone, className, ...rest }: StatusRailProps) {
  const colour =
    tone === "pos"
      ? "bg-pos"
      : tone === "neg"
        ? "bg-neg"
        : tone === "warn"
          ? "bg-warn"
          : tone === "signal"
            ? "bg-signal"
            : "bg-hairline-strong";
  return <span aria-hidden className={cn("inline-block h-full w-[2px] rounded-full", colour, className)} {...rest} />;
}
