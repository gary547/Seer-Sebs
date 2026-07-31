import { forwardRef, useImperativeHandle, useState, useEffect, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CollapsibleSectionHandle {
  /** Imperatively open the section (used by callers that want to scroll-to + expand). */
  open: () => void;
  /** Scroll the card into view (smooth) and open. */
  openAndScroll: () => void;
}

interface Props {
  /** Stable id used in the localStorage key. */
  id: string;
  /** Per-project key prefix so preferences don't bleed across projects. */
  storageKey?: string;
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Optional one-line summary chip rendered on the trigger row (visible whether open or closed). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /**
   * When true, children are only rendered after the section has been opened at least once.
   * They remain mounted after being re-collapsed within the same session.
   */
  lazyMount?: boolean;
  /** Fires whenever the open state changes. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Shared collapsible card wrapper for the Setup tab. Each section persists
 * its open/closed state per project under `seer-setup-sections-{projectId}`.
 *
 * Pure presentation — no formulas, no data mutation. Children render exactly
 * as before; this just hides them behind a chevron.
 */
const CollapsibleSection = forwardRef<CollapsibleSectionHandle, Props>(function CollapsibleSection(
  { id, storageKey, title, icon, badge, summary, defaultOpen = false, lazyMount = false, onOpenChange, children },
  ref
) {
  const fullKey = storageKey ? `${storageKey}:${id}` : null;

  const [open, setOpenState] = useState<boolean>(() => {
    if (!fullKey) return defaultOpen;
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw === null) return defaultOpen;
      return raw === "1";
    } catch {
      return defaultOpen;
    }
  });

  const [hasOpened, setHasOpened] = useState<boolean>(open);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (next) setHasOpened(true);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  useEffect(() => {
    if (!fullKey) return;
    try {
      localStorage.setItem(fullKey, open ? "1" : "0");
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [open, fullKey]);

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
    openAndScroll: () => {
      setOpen(true);
      // Defer until DOM updates so we scroll to the expanded card.
      requestAnimationFrame(() => {
        const el = document.getElementById(`setup-section-${id}`);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
  }));

  return (
    <Card id={`setup-section-${id}`} className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-full flex items-center justify-between gap-2 px-6 py-4 text-left",
              "hover:bg-muted/40 transition-colors"
            )}
            aria-expanded={open}
          >
            <div className="flex items-center gap-2 min-w-0">
              {icon}
              <span className="text-sm font-semibold text-foreground truncate">{title}</span>
              {badge}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {summary && (
                <span className="text-xs text-muted-foreground truncate max-w-[280px]">{summary}</span>
              )}
              {open ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-6 pb-6 pt-2 border-t border-border">
            {lazyMount && !hasOpened ? null : children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
});

export default CollapsibleSection;
