import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Canonical empty-state primitive for tables, lists, and panels.
 * Use whenever a query succeeds but returns zero rows.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center gap-3 rounded-xl border border-dashed border-hairline bg-surface/50 px-6 py-10",
        className,
      )}
    >
      {icon && <div className="text-ink-muted opacity-70">{icon}</div>}
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && (
          <p className="mt-1 text-[13px] text-ink-muted max-w-md mx-auto">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export default EmptyState;
