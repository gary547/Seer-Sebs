import * as React from "react";
import { cn } from "@/lib/utils";

interface InsightQuoteProps {
  children: React.ReactNode;
  attribution?: React.ReactNode;
  size?: "md" | "lg";
  tone?: "light" | "obsidian";
  className?: string;
}

/**
 * Editorial pull-quote. Use sparingly — one per page max — for the headline insight.
 */
export function InsightQuote({ children, attribution, size = "md", tone = "light", className }: InsightQuoteProps) {
  const dark = tone === "obsidian";
  return (
    <blockquote
      className={cn(
        "relative pl-5",
        dark ? "border-l-2 border-signal/70" : "border-l-2 border-signal",
        className,
      )}
    >
      <p
        className={cn(
          "type-display font-light leading-[1.15]",
          size === "lg" ? "text-[34px]" : "text-[24px]",
          dark ? "text-obsidian-ink" : "text-ink",
        )}
      >
        {children}
      </p>
      {attribution && (
        <footer className={cn("mt-3 type-eyebrow", dark ? "text-obsidian-ink-muted" : "text-ink-muted")}>
          {attribution}
        </footer>
      )}
    </blockquote>
  );
}
