import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ArchiveBannerProps {
  scope: "client" | "project";
  archivedAt?: string | null;
  reason?: string | null;
  onRestore?: () => void;
  restoreDisabled?: boolean;
  restoreLabel?: string;
  className?: string;
}

function formatDate(d?: string | null): string | null {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

/**
 * Pinned banner shown at the top of every read-only archive surface.
 */
export function ArchiveBanner({
  scope,
  archivedAt,
  reason,
  onRestore,
  restoreDisabled,
  restoreLabel,
  className,
}: ArchiveBannerProps) {
  const when = formatDate(archivedAt);
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm",
        className,
      )}
    >
      <Archive className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-foreground">
          This {scope} is archived — read-only.
        </p>
        <p className="text-muted-foreground text-[13px] mt-0.5">
          {when ? `Archived ${when}. ` : ""}
          {reason ? `Reason: ${reason}` : "No reason recorded."}
        </p>
      </div>
      {onRestore && (
        <Button
          size="sm"
          variant="outline"
          onClick={onRestore}
          disabled={restoreDisabled}
        >
          {restoreLabel ?? `Restore ${scope}`}
        </Button>
      )}
    </div>
  );
}

export default ArchiveBanner;
