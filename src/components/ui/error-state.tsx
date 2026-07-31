import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  description?: ReactNode;
  retry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * Canonical error-state primitive. Use when a query rejects or an edge function
 * returns a non-2xx response. The `retry` callback is opt-in per call site —
 * no implicit behaviour.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  retry,
  retryLabel = "Try again",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center gap-3 rounded-xl border border-neg/30 bg-neg/5 px-6 py-8",
        className,
      )}
    >
      <AlertTriangle className="h-5 w-5 text-neg" aria-hidden="true" />
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && (
          <p className="mt-1 text-[13px] text-ink-muted max-w-md mx-auto">{description}</p>
        )}
      </div>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export default ErrorState;
