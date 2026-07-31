import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, X, ArrowUp, ArrowDown, Download, MoreVertical, SearchX } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

import { useServerTable } from "./useServerTable";
import { exportTableCsv } from "./exportCsv";
import type {
  BulkAction,
  BulkActionContext,
  Column,
  FetchCountArgs,
  FetchPageArgs,
  FilterDef,
  MobileRowRenderer,
  SortState,
} from "./types";

export type DataTableProps<TRow> = {
  queryKey: readonly unknown[];
  fetchPage: (args: FetchPageArgs) => Promise<TRow[]>;
  fetchTotal: (args: FetchCountArgs) => Promise<number>;
  fetchFilterCounts?: (args: { search: string }) => Promise<Record<string, number>>;
  columns: Column<TRow>[];
  rowKey: (row: TRow) => string;
  filters?: FilterDef[];
  defaultFilter?: string;
  defaultSort?: SortState;
  pageSize?: number;
  /** Desktop row height in px. */
  rowHeight?: number;
  /** Mobile (card) row height in px. */
  mobileRowHeight?: number;
  /** Maximum visible rows before scrolling. */
  maxVisibleRows?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** When set, search placeholder becomes "Search N <noun>". */
  searchNoun?: string;
  bulkActions?: BulkAction[];
  emptyState?: ReactNode;
  /** Optional CSV export. Filename is required to enable. */
  exportFilename?: string;
  rowToCsvValues?: (row: TRow) => unknown[];
  /** Optional toolbar slot rendered right of the search/filters. */
  toolbar?: ReactNode;
  /** Optional mobile row renderer. Defaults to a sensible card built from columns. */
  mobileRow?: MobileRowRenderer<TRow>;
  className?: string;
};

const PRIORITY_HIDE_CLASS: Record<2 | 3, string> = {
  2: "hidden lg:block",
  3: "hidden xl:block",
};

const priorityClass = (p?: 1 | 2 | 3) => (p && p > 1 ? PRIORITY_HIDE_CLASS[p as 2 | 3] : "");

export function DataTable<TRow>({
  queryKey,
  fetchPage,
  fetchTotal,
  fetchFilterCounts,
  columns,
  rowKey,
  filters,
  defaultFilter,
  defaultSort = null,
  pageSize = 200,
  rowHeight = 56,
  mobileRowHeight = 92,
  maxVisibleRows = 10,
  searchable = true,
  searchPlaceholder,
  searchNoun,
  bulkActions,
  emptyState,
  exportFilename,
  rowToCsvValues,
  toolbar,
  mobileRow,
  className,
}: DataTableProps<TRow>) {
  const isMobile = useIsMobile();
  const t = useServerTable<TRow>({
    queryKey,
    fetchPage,
    fetchTotal,
    fetchFilterCounts,
    filters,
    defaultFilter,
    defaultSort,
    pageSize,
    rowKey,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const effectiveRowHeight = isMobile ? mobileRowHeight : rowHeight;

  const virtualizer = useVirtualizer({
    count: t.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => effectiveRowHeight,
    overscan: 8,
  });

  // ⌘K / Ctrl+K / "/" focuses search
  useEffect(() => {
    if (!searchable) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !inEditable)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchable]);

  const hasSelectionUi = Boolean(bulkActions && bulkActions.length > 0);
  const showBulkBar = hasSelectionUi && (t.selectedIds.size > 0 || t.selectAllMatching);
  const effectiveSelectedCount = t.selectAllMatching ? t.total : t.selectedIds.size;
  const showSelectAllMatchingPrompt =
    hasSelectionUi && !t.selectAllMatching && t.allOnPageSelected && t.total > t.rows.length;

  const visibleColumns = columns; // priority hides via CSS, not by removing
  const gridTemplate = [
    hasSelectionUi ? "44px" : null,
    ...visibleColumns.map((c) => c.width ?? "minmax(0,1fr)"),
  ]
    .filter(Boolean)
    .join(" ");

  const alignClass = (align?: "left" | "right" | "center") =>
    align === "right" ? "text-right justify-end" : align === "center" ? "text-center justify-center" : "text-left";

  const handleExport = async () => {
    if (!exportFilename) return;
    try {
      await exportTableCsv({
        filename: exportFilename,
        total: t.total,
        search: t.debouncedSearch.trim(),
        filter: t.filter,
        sort: t.sort,
        columns,
        rowToValues: rowToCsvValues,
        fetchPage,
      });
    } catch {
      toast.error("Export failed");
    }
  };

  const filterChipCount = (value: string) => {
    const fromMap = t.filterCounts[value];
    if (typeof fromMap === "number") return fromMap;
    if (value === t.filter) return t.total;
    return undefined;
  };

  const placeholder =
    searchPlaceholder ??
    (searchNoun
      ? t.total > 0
        ? `Search ${t.total.toLocaleString()} ${searchNoun}`
        : `Search ${searchNoun}`
      : "Search…");

  const runBulk = async (action: BulkAction, ctx: BulkActionContext) => {
    try {
      await action.run(ctx);
      toast.success(
        action.successMessage
          ? action.successMessage(effectiveSelectedCount)
          : `Done (${effectiveSelectedCount.toLocaleString()})`,
      );
      t.clearSelection();
    } catch {
      toast.error(action.errorMessage ?? "Action failed");
    }
  };

  const renderBulkButtons = (ctx: BulkActionContext) =>
    (bulkActions ?? []).map((action) => {
      if (action.confirm) {
        return (
          <AlertDialog key={action.id}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant={action.variant ?? "outline"} className="min-h-[40px]">
                {action.icon}
                {action.label}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {action.confirm.title(effectiveSelectedCount)}
                </AlertDialogTitle>
                {action.confirm.description && (
                  <AlertDialogDescription>{action.confirm.description}</AlertDialogDescription>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => runBulk(action, ctx)}>
                  {action.confirm.confirmLabel ?? "Confirm"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      }
      return (
        <Button
          key={action.id}
          size="sm"
          variant={action.variant ?? "outline"}
          className="min-h-[40px]"
          onClick={() => runBulk(action, ctx)}
        >
          {action.icon}
          {action.label}
        </Button>
      );
    });

  const bulkCtx: BulkActionContext = {
    selectAllMatching: t.selectAllMatching,
    selectedIds: [...t.selectedIds],
    search: t.debouncedSearch.trim(),
    filter: t.filter,
    totalMatching: t.total,
  };

  // ---- Default mobile card renderer (used if `mobileRow` not provided) ----
  const defaultMobileRow: MobileRowRenderer<TRow> = ({ row, selected, onToggleSelect }) => {
    const primary = visibleColumns[0];
    const secondary = visibleColumns.slice(1, 3); // status + meta-ish
    const tertiary = visibleColumns.slice(3); // longer reason / detail
    return (
      <div className="flex gap-3 px-4 py-3 w-full">
        {hasSelectionUi && (
          <button
            type="button"
            onClick={onToggleSelect}
            disabled={t.selectAllMatching}
            className="flex h-11 w-11 -ml-2 items-center justify-center text-muted-foreground"
            aria-label={selected ? "Deselect row" : "Select row"}
          >
            <Checkbox checked={selected} disabled={t.selectAllMatching} />
          </button>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          {primary && (
            <div className="text-base font-semibold leading-tight truncate">{primary.cell(row)}</div>
          )}
          {secondary.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {secondary.map((c) => (
                <div key={c.id} className="min-w-0 flex items-center">
                  {c.cell(row)}
                </div>
              ))}
            </div>
          )}
          {tertiary.length > 0 && (
            <div className="text-xs text-muted-foreground/80 truncate">
              {tertiary.map((c) => (
                <span key={c.id} className="mr-3">
                  {c.cell(row)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const mobileRowFn = mobileRow ?? defaultMobileRow;

  return (
    <div className={cn("space-y-4", className)}>
      {/* Search + Toolbar */}
      {(searchable || toolbar || exportFilename) && (
        <div className="flex items-center gap-2 flex-wrap">
          {searchable && (
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                ref={searchInputRef}
                value={t.search}
                onChange={(e) => t.setSearch(e.target.value)}
                placeholder={placeholder}
                className="pl-9 pr-9 h-11 sm:h-10"
                aria-label="Search"
              />
              {t.search && (
                <button
                  type="button"
                  onClick={() => t.setSearch("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {toolbar}
            {exportFilename && !isMobile && (
              <Button size="sm" variant="outline" onClick={handleExport} disabled={t.total === 0}>
                <Download className="h-4 w-4 mr-1" />
                Export CSV
              </Button>
            )}
            {exportFilename && isMobile && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" aria-label="More" className="h-11 w-11">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExport} disabled={t.total === 0}>
                    <Download className="h-4 w-4 mr-2" />
                    Export CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {/* Filter chips — horizontally scrollable rail on mobile */}
      {filters && filters.length > 0 && (
        <div className="-mx-1 overflow-x-auto">
          <div className="flex items-center gap-2 px-1 pb-1 min-w-max sm:flex-wrap sm:min-w-0">
            {filters.map((f) => {
              const count = filterChipCount(f.value);
              return (
                <Button
                  key={f.value}
                  size="sm"
                  variant={t.filter === f.value ? "default" : "outline"}
                  onClick={() => t.setFilter(f.value)}
                  className="h-9 sm:h-8 rounded-full whitespace-nowrap"
                >
                  {f.label}
                  {typeof count === "number" && (
                    <span className="ml-1 opacity-80 tabular-nums">({count.toLocaleString()})</span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* Inline (desktop) bulk action toolbar */}
      {showBulkBar && bulkActions && !isMobile && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-muted border flex-wrap">
          <span className="text-sm font-medium">
            {effectiveSelectedCount.toLocaleString()} selected
            {t.selectAllMatching && " (all matching)"}
          </span>
          <button
            type="button"
            onClick={t.clearSelection}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Clear
          </button>
          <div className="ml-auto flex items-center gap-2 flex-wrap">{renderBulkButtons(bulkCtx)}</div>
        </div>
      )}

      {/* "Select all N matching" affordance */}
      {showSelectAllMatchingPrompt && (
        <div className="text-sm rounded-md bg-accent/40 border border-accent px-3 py-2">
          All {t.rows.length} on this page selected.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2 hover:text-primary"
            onClick={() => t.setSelectAllMatching(true)}
          >
            Select all {t.total.toLocaleString()} matching
            {t.debouncedSearch ? ` "${t.debouncedSearch}"` : ""}
          </button>
        </div>
      )}

      {/* Table / List */}
      <div className="rounded-md border overflow-hidden">
        {/* Desktop sticky header */}
        {!isMobile && (
          <div
            className="grid items-center gap-3 px-4 h-11 border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {hasSelectionUi && (
              <div className="flex items-center justify-center">
                <Checkbox
                  checked={t.allOnPageSelected}
                  onCheckedChange={t.togglePageSelectAll}
                  aria-label="Select all on page"
                />
              </div>
            )}
            {visibleColumns.map((c) => {
              const sortedActive = t.sort?.columnId === c.id;
              const Icon = sortedActive
                ? t.sort?.direction === "asc"
                  ? ArrowUp
                  : ArrowDown
                : null;
              return (
                <div
                  key={c.id}
                  className={cn("min-w-0 flex items-center", alignClass(c.align), priorityClass(c.priority), c.headerClassName)}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => t.toggleSort(c.id)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      <span className="truncate">{c.header}</span>
                      {Icon && <Icon className="h-3 w-3 shrink-0" />}
                    </button>
                  ) : (
                    <span className="truncate">{c.header}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Body */}
        {t.isLoading ? (
          <SkeletonRows
            rows={5}
            isMobile={isMobile}
            rowHeight={effectiveRowHeight}
            gridTemplate={gridTemplate}
            columns={visibleColumns}
            hasSelectionUi={hasSelectionUi}
          />
        ) : t.rows.length === 0 ? (
          <EmptyState
            search={t.debouncedSearch}
            filterActive={t.filter !== (filters?.[0]?.value ?? "all")}
            onClearFilters={() => {
              t.setFilter(filters?.[0]?.value ?? "all");
              t.setSearch("");
            }}
            custom={emptyState}
          />
        ) : (
          <div
            ref={scrollRef}
            className="overflow-auto"
            style={{ height: Math.min(t.rows.length, maxVisibleRows) * effectiveRowHeight + 4 }}
          >
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const row = t.rows[vi.index];
                const id = rowKey(row);
                const selected = hasSelectionUi && (t.selectedIds.has(id) || t.selectAllMatching);
                return (
                  <div
                    key={id}
                    data-state={selected ? "selected" : undefined}
                    className={cn(
                      "absolute top-0 left-0 w-full border-b text-sm data-[state=selected]:bg-muted/40",
                      isMobile ? "block" : "grid items-center gap-3 px-4",
                    )}
                    style={{
                      gridTemplateColumns: isMobile ? undefined : gridTemplate,
                      height: `${vi.size}px`,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {isMobile ? (
                      mobileRowFn({
                        row,
                        selected,
                        onToggleSelect: () => t.toggleOne(id),
                      })
                    ) : (
                      <>
                        {hasSelectionUi && (
                          <div className="flex items-center justify-center">
                            <Checkbox
                              checked={selected}
                              disabled={t.selectAllMatching}
                              onCheckedChange={() => t.toggleOne(id)}
                            />
                          </div>
                        )}
                        {visibleColumns.map((c) => (
                          <div
                            key={c.id}
                            className={cn(
                              "min-w-0 flex items-center",
                              alignClass(c.align),
                              priorityClass(c.priority),
                              c.className,
                            )}
                          >
                            <div className="min-w-0 w-full truncate">{c.cell(row)}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer: range + pagination — stacks on mobile */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          Showing {t.fromIndex.toLocaleString()}–{t.toIndex.toLocaleString()} of{" "}
          {t.total.toLocaleString()}
        </span>
        <div className="flex items-center justify-between sm:justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => t.setPage(Math.max(0, t.page - 1))}
            disabled={t.page === 0}
            className="min-h-[40px] min-w-[80px]"
          >
            Previous
          </Button>
          <span className="tabular-nums px-2">
            Page {t.page + 1} of {t.pageCount}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => t.setPage(Math.min(t.pageCount - 1, t.page + 1))}
            disabled={t.page >= t.pageCount - 1}
            className="min-h-[40px] min-w-[80px]"
          >
            Next
          </Button>
        </div>
      </div>

      {/* Mobile bottom-sheet bulk bar */}
      {showBulkBar && bulkActions && isMobile && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.18)]"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div className="px-4 pt-3 pb-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="font-medium">{effectiveSelectedCount.toLocaleString()}</span>{" "}
                selected
                {t.selectAllMatching && (
                  <span className="text-muted-foreground"> (all matching)</span>
                )}
              </div>
              <button
                type="button"
                onClick={t.clearSelection}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1">
              {renderBulkButtons(bulkCtx)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Skeleton + empty state ----------

function SkeletonRows<TRow>({
  rows,
  isMobile,
  rowHeight,
  gridTemplate,
  columns,
  hasSelectionUi,
}: {
  rows: number;
  isMobile: boolean;
  rowHeight: number;
  gridTemplate: string;
  columns: Column<TRow>[];
  hasSelectionUi: boolean;
}) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "border-b animate-pulse",
            isMobile ? "px-4 py-3" : "grid items-center gap-3 px-4",
          )}
          style={{ gridTemplateColumns: isMobile ? undefined : gridTemplate, height: rowHeight }}
        >
          {isMobile ? (
            <div className="flex gap-3">
              {hasSelectionUi && <div className="h-5 w-5 rounded bg-muted" />}
              <div className="flex-1 space-y-2">
                <div className="h-4 w-2/3 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted/70" />
              </div>
            </div>
          ) : (
            <>
              {hasSelectionUi && <div className="h-5 w-5 rounded bg-muted" />}
              {columns.map((c, idx) => (
                <div key={c.id} className={cn("h-4 rounded bg-muted", priorityClass(c.priority))}
                  style={{ width: idx === 0 ? "70%" : "50%" }} />
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  search,
  filterActive,
  onClearFilters,
  custom,
}: {
  search: string;
  filterActive: boolean;
  onClearFilters: () => void;
  custom?: ReactNode;
}) {
  if (custom) return <div className="p-10 text-center text-sm text-muted-foreground">{custom}</div>;
  const hasFilters = filterActive || Boolean(search);
  return (
    <div className="p-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-3">
      <SearchX className="h-8 w-8 opacity-60" />
      <div>
        {search ? <>No results for &ldquo;{search}&rdquo;.</> : "No data yet."}
      </div>
      {hasFilters && (
        <Button size="sm" variant="outline" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

export default DataTable;
