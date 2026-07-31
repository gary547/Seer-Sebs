import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/useDebounce";
import type {
  FetchCountArgs,
  FetchPageArgs,
  FilterDef,
  SortState,
} from "./types";

type Args<TRow> = {
  queryKey: readonly unknown[];
  fetchPage: (args: FetchPageArgs) => Promise<TRow[]>;
  /** Total count for the current filter + search. */
  fetchTotal: (args: FetchCountArgs) => Promise<number>;
  /** Optional per-filter counts (used for chip labels). Keyed by FilterDef.value. */
  fetchFilterCounts?: (args: { search: string }) => Promise<Record<string, number>>;
  filters?: FilterDef[];
  defaultFilter?: string;
  defaultSort?: SortState;
  pageSize: number;
  rowKey: (row: TRow) => string;
};

export function useServerTable<TRow>({
  queryKey,
  fetchPage,
  fetchTotal,
  fetchFilterCounts,
  filters,
  defaultFilter,
  defaultSort = null,
  pageSize,
  rowKey,
}: Args<TRow>) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [filter, setFilter] = useState<string>(defaultFilter ?? filters?.[0]?.value ?? "all");
  const [sort, setSort] = useState<SortState>(defaultSort);
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // Reset selection / paging when the predicate changes.
  const predicateKey = `${filter}|${debouncedSearch}|${sort?.columnId ?? ""}|${sort?.direction ?? ""}`;
  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }, [predicateKey]);

  const totalQuery = useQuery({
    queryKey: [...queryKey, "total", debouncedSearch, filter],
    queryFn: () => fetchTotal({ search: debouncedSearch.trim(), filter }),
  });

  const filterCountsQuery = useQuery({
    queryKey: [...queryKey, "filterCounts", debouncedSearch],
    queryFn: () =>
      fetchFilterCounts
        ? fetchFilterCounts({ search: debouncedSearch.trim() })
        : Promise.resolve({} as Record<string, number>),
    enabled: Boolean(fetchFilterCounts),
  });

  const total = totalQuery.data ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);

  const pageQuery = useQuery({
    queryKey: [...queryKey, "page", debouncedSearch, filter, sort, safePage],
    queryFn: () =>
      fetchPage({
        from: safePage * pageSize,
        to: safePage * pageSize + pageSize - 1,
        search: debouncedSearch.trim(),
        filter,
        sort,
      }),
  });

  const rows = useMemo(() => pageQuery.data ?? [], [pageQuery.data]);

  const allOnPageSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(rowKey(r)));

  const togglePageSelectAll = () => {
    if (allOnPageSelected) {
      const next = new Set(selectedIds);
      rows.forEach((r) => next.delete(rowKey(r)));
      setSelectedIds(next);
      setSelectAllMatching(false);
    } else {
      const next = new Set(selectedIds);
      rows.forEach((r) => next.add(rowKey(r)));
      setSelectedIds(next);
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectAllMatching(false);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  };

  const toggleSort = (columnId: string) => {
    setSort((prev) => {
      if (!prev || prev.columnId !== columnId) return { columnId, direction: "asc" };
      if (prev.direction === "asc") return { columnId, direction: "desc" };
      return null;
    });
  };

  const fromIndex = total === 0 ? 0 : safePage * pageSize + 1;
  const toIndex = Math.min(total, safePage * pageSize + rows.length);

  return {
    // state
    search,
    setSearch,
    debouncedSearch,
    filter,
    setFilter,
    sort,
    toggleSort,
    page: safePage,
    setPage,
    pageCount,
    pageSize,
    total,
    rows,
    isLoading: pageQuery.isLoading || totalQuery.isLoading,
    error: (pageQuery.error || totalQuery.error) as Error | null,
    filterCounts: filterCountsQuery.data ?? {},
    // selection
    selectedIds,
    selectAllMatching,
    setSelectAllMatching,
    allOnPageSelected,
    togglePageSelectAll,
    toggleOne,
    clearSelection,
    // derived
    fromIndex,
    toIndex,
  };
}
