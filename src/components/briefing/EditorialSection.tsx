import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * EditorialSection — the rhythm primitive for the entire app.
 * Eyebrow + title + dek (left) and optional actions/filters (right),
 * separated by a hairline rule from its content.
 */
interface EditorialSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  dek?: React.ReactNode;
  actions?: React.ReactNode;
  /** Tone of the section header. */
  tone?: "default" | "obsidian";
  /** Hide the bottom hairline. */
  bare?: boolean;
}

export const EditorialSection = React.forwardRef<HTMLElement, EditorialSectionProps>(
  ({ className, eyebrow, title, dek, actions, tone = "default", bare, children, ...rest }, ref) => {
    const isDark = tone === "obsidian";
    return (
      <section
        ref={ref}
        className={cn(
          "w-full",
          isDark && "surface-obsidian rounded-xl shadow-obsidian px-6 py-6",
          className,
        )}
        {...rest}
      >
        {(eyebrow || title || dek || actions) && (
          <header
            className={cn(
              "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
              !bare && !isDark && "pb-4 border-b border-hairline",
              !bare && isDark && "pb-4 border-b border-obsidian-line",
            )}
          >
            <div className="min-w-0">
              {eyebrow && (
                <div className={cn("type-eyebrow", isDark && "text-obsidian-ink-muted")}>
                  {eyebrow}
                </div>
              )}
              {title && (
                <h2
                  className={cn(
                    "mt-1.5 text-[18px] font-heading font-semibold tracking-tight",
                    isDark ? "text-obsidian-ink" : "text-ink",
                  )}
                >
                  {title}
                </h2>
              )}
              {dek && (
                <p className={cn("mt-1 text-[13px]", isDark ? "text-obsidian-ink-muted" : "text-ink-muted")}>
                  {dek}
                </p>
              )}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
          </header>
        )}
        {children && <div className={cn(!bare && (eyebrow || title) && "pt-5")}>{children}</div>}
      </section>
    );
  },
);
EditorialSection.displayName = "EditorialSection";
