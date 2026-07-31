import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { DataTable, type Column, type FilterDef } from "@/components/data-table";
import {
  deleteProjectKeywords,
  listProjectKeywords,
  updateProjectKeywordDetoxStatus,
  type ProjectKeywordDetoxStatus,
  type ProjectKeywordMutationTarget,
} from "@/integrations/gcp/project-data";

type KeywordRow = {
  id: string;
  keyword: string;
  detox_status: ProjectKeywordDetoxStatus;
  detox_reason: string | null;
  human_reviewed: boolean;
};

const PAGE_SIZE = 200;

const FILTERS: FilterDef[] = [
  { value: "all", label: "All" },
  { value: "keep", label: "Keep" },
  { value: "remove", label: "Removed" },
  { value: "pending", label: "Pending" },
  { value: "review", label: "Review" },
];

function mutationTarget(
  selectAllMatching: boolean,
  selectedIds: string[],
  filter: string,
  search: string,
): ProjectKeywordMutationTarget {
  return selectAllMatching
    ? {
        predicate: {
          detoxStatus: filter as ProjectKeywordDetoxStatus | "all",
          search,
        },
      }
    : { ids: selectedIds };
}

// Status pill shared between desktop + mobile renderers.
function StatusPill({
  row,
  onToggle,
}: {
  row: KeywordRow;
  onToggle: (next: "keep" | "remove") => void;
}) {
  const variant =
    row.detox_status === "keep"
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : row.detox_status === "remove"
      ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
      : "bg-muted text-muted-foreground hover:bg-muted/80";
  const next = row.detox_status === "keep" ? "remove" : "keep";
  const isPending = row.detox_status === "pending";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (isPending) return;
        onToggle(next);
      }}
      disabled={isPending}
      aria-label={isPending ? "Pending review" : `Mark as ${next}`}
      className={cn(
        "inline-flex items-center justify-center min-h-[32px] px-3 rounded-full text-xs font-medium capitalize transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant,
        isPending && "cursor-default",
      )}
    >
      {row.detox_status === "remove" ? "removed" : row.detox_status}
    </button>
  );
}

export default function KeywordDetoxResults({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["keywords_detox", projectId] });
    queryClient.invalidateQueries({ queryKey: ["keywords", projectId] });
    queryClient.invalidateQueries({ queryKey: ["keywords_exist", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project_sync_state", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project-data", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project_readiness", projectId] });
  };

  // Optimistic single-row update with undo.
  const patchRowInCache = (id: string, patch: Partial<KeywordRow>) => {
    queryClient.setQueriesData<KeywordRow[]>({ queryKey: ["keywords_detox", projectId, "page"] }, (prev) => {
      if (!prev) return prev;
      return prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
    });
  };

  const updateStatus = async (id: string, prev: KeywordRow, next: "keep" | "remove") => {
    const prevStatus = prev.detox_status;
    const prevReviewed = prev.human_reviewed;
    patchRowInCache(id, { detox_status: next, human_reviewed: true });

    try {
      await updateProjectKeywordDetoxStatus(projectId, next, { ids: [id] });
    } catch {
      patchRowInCache(id, { detox_status: prevStatus, human_reviewed: prevReviewed });
      toast.error("Failed to update keyword");
      return;
    }

    queryClient.invalidateQueries({ queryKey: ["keywords_detox", projectId, "filterCounts"] });
    queryClient.invalidateQueries({ queryKey: ["keywords_detox", projectId, "total"] });

    toast.success(`Marked "${prev.keyword}" as ${next}`, {
      action: {
        label: "Undo",
        onClick: async () => {
          patchRowInCache(id, { detox_status: prevStatus, human_reviewed: prevReviewed });
          try {
            await updateProjectKeywordDetoxStatus(projectId, prevStatus, {
              ids: [id],
            });
          } catch {
            patchRowInCache(id, { detox_status: next, human_reviewed: true });
            toast.error("Undo failed");
            return;
          }
          queryClient.invalidateQueries({ queryKey: ["keywords_detox", projectId, "filterCounts"] });
          queryClient.invalidateQueries({ queryKey: ["keywords_detox", projectId, "total"] });
        },
      },
    });
  };

  const columns: Column<KeywordRow>[] = [
    {
      id: "keyword",
      header: "Keyword",
      width: "minmax(0,2fr)",
      sortable: true,
      cell: (r) => (
        <span className="font-medium truncate" title={r.keyword}>
          {r.keyword}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "minmax(120px,140px)",
      cell: (r) => <StatusPill row={r} onToggle={(next) => updateStatus(r.id, r, next)} />,
    },
    {
      id: "reason",
      header: "Reason",
      width: "minmax(0,2fr)",
      priority: 2, // hidden below lg
      cell: (r) => (
        <span className="text-muted-foreground truncate block" title={r.detox_reason ?? ""}>
          {r.detox_reason ?? "—"}
        </span>
      ),
    },
    {
      id: "reviewed",
      header: "Reviewed",
      width: "100px",
      align: "center",
      priority: 3, // hidden below xl
      cell: (r) => <Checkbox checked={r.human_reviewed} disabled />,
    },
  ];

  return (
    <DataTable<KeywordRow>
      queryKey={["keywords_detox", projectId]}
      rowKey={(r) => r.id}
      columns={columns}
      filters={FILTERS}
      defaultFilter="all"
      pageSize={PAGE_SIZE}
      searchNoun="keywords"
      exportFilename={`keywords-${projectId}`}
      rowToCsvValues={(r) => [r.keyword, r.detox_status, r.detox_reason ?? "", r.human_reviewed]}
      mobileRow={({ row, selected, onToggleSelect }) => (
        <div className="flex gap-3 px-4 py-3 w-full items-start">
          <button
            type="button"
            onClick={onToggleSelect}
            className="flex h-11 w-11 -ml-2 items-center justify-center text-muted-foreground"
            aria-label={selected ? "Deselect row" : "Select row"}
          >
            <Checkbox checked={selected} />
          </button>
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <div className="text-base font-semibold leading-tight truncate">{row.keyword}</div>
            <div className="flex items-center gap-2">
              <StatusPill row={row} onToggle={(next) => updateStatus(row.id, row, next)} />
              {row.human_reviewed && (
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Reviewed
                </span>
              )}
            </div>
            {row.detox_reason && (
              <div className="text-xs text-muted-foreground line-clamp-2">{row.detox_reason}</div>
            )}
          </div>
        </div>
      )}
      fetchTotal={async ({ search, filter }) => {
        const result = await listProjectKeywords(projectId, {
          detoxStatus: filter as ProjectKeywordDetoxStatus | "all",
          limit: 1,
          search,
        });
        return result.total;
      }}
      fetchFilterCounts={async ({ search }) => {
        const result = await listProjectKeywords(projectId, {
          limit: 1,
          search,
        });
        return result.filterCounts;
      }}
      fetchPage={async ({ from, to, search, filter, sort }) => {
        const result = await listProjectKeywords(projectId, {
          detoxStatus: filter as ProjectKeywordDetoxStatus | "all",
          direction: sort?.direction ?? "asc",
          limit: to - from + 1,
          offset: from,
          search,
          sort: "keyword",
        });
        return result.items.map((keyword) => ({
          detox_reason: keyword.detoxReason,
          detox_status: keyword.detoxStatus,
          human_reviewed: keyword.humanReviewed,
          id: keyword.id,
          keyword: keyword.text,
        }));
      }}
      bulkActions={[
        {
          id: "mark-keep",
          label: "Mark Keep",
          variant: "outline",
          run: async (ctx) => {
            await updateProjectKeywordDetoxStatus(
              projectId,
              "keep",
              mutationTarget(
                ctx.selectAllMatching,
                ctx.selectedIds,
                ctx.filter,
                ctx.search,
              ),
            );
            invalidateAll();
          },
          successMessage: (n) => `Marked ${n.toLocaleString()} as keep`,
          errorMessage: "Failed to update keywords",
        },
        {
          id: "mark-remove",
          label: "Mark Remove",
          variant: "outline",
          run: async (ctx) => {
            await updateProjectKeywordDetoxStatus(
              projectId,
              "remove",
              mutationTarget(
                ctx.selectAllMatching,
                ctx.selectedIds,
                ctx.filter,
                ctx.search,
              ),
            );
            invalidateAll();
          },
          successMessage: (n) => `Marked ${n.toLocaleString()} as removed`,
          errorMessage: "Failed to update keywords",
        },
        {
          id: "delete",
          label: (
            <>
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </>
          ),
          variant: "destructive",
          confirm: {
            title: (n) => `Delete ${n.toLocaleString()} keywords?`,
            description:
              "This will permanently remove the selected keywords from this project.",
            confirmLabel: "Delete",
          },
          run: async (ctx) => {
            await deleteProjectKeywords(
              projectId,
              mutationTarget(
                ctx.selectAllMatching,
                ctx.selectedIds,
                ctx.filter,
                ctx.search,
              ),
            );
            invalidateAll();
          },
          successMessage: (n) => `Deleted ${n.toLocaleString()} keywords`,
          errorMessage: "Failed to delete keywords",
        },
      ]}
    />
  );
}
