import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";

export type SortState = {
  columnId: string;
  direction: SortDirection;
} | null;

export type Column<TRow> = {
  /** Stable id; also used as the sort key returned to fetchPage. */
  id: string;
  header: ReactNode;
  /** Render the cell content for a given row (desktop grid). */
  cell: (row: TRow) => ReactNode;
  /** Whether the column header is clickable to toggle sort. */
  sortable?: boolean;
  /**
   * CSS column width fragment for the desktop grid template.
   * Tip: prefer `minmax(0, …)` so cells can actually truncate.
   */
  width?: string;
  /** "left" | "right" | "center". Defaults to left. */
  align?: "left" | "right" | "center";
  /** Optional className applied to the cell. */
  className?: string;
  /** Optional className applied to the header cell. */
  headerClassName?: string;
  /**
   * Visibility priority on the desktop grid:
   * 1 = always visible, 2 = hidden below lg, 3 = hidden below xl.
   * On mobile the grid is replaced by a card, so this is ignored there.
   */
  priority?: 1 | 2 | 3;
};

export type FilterDef = {
  /** Stable filter id (e.g. "all", "keep"). Passed back into fetchPage / fetchCount. */
  value: string;
  label: string;
};

export type FetchPageArgs = {
  from: number;
  to: number;
  search: string;
  filter: string;
  sort: SortState;
};

export type FetchCountArgs = {
  search: string;
  filter: string;
};

export type BulkActionContext = {
  /** True if the user chose "Select all N matching" — apply by predicate, not by ids. */
  selectAllMatching: boolean;
  /** Selected row ids (only meaningful when selectAllMatching === false). */
  selectedIds: string[];
  /** The current filter + search that defines "all matching". */
  search: string;
  filter: string;
  /** Total count of rows matching the current filter+search. */
  totalMatching: number;
};

export type BulkAction = {
  id: string;
  label: ReactNode;
  /** Visual variant for the trigger button. */
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  /** Icon rendered to the left of the label. */
  icon?: ReactNode;
  /** Show a confirm dialog before running. */
  confirm?: {
    title: (n: number) => string;
    description?: ReactNode;
    confirmLabel?: string;
  };
  /** Run the action. Throw to surface an error toast. */
  run: (ctx: BulkActionContext) => Promise<void>;
  /** Toast on success. */
  successMessage?: (n: number) => string;
  /** Toast on error. */
  errorMessage?: string;
};

/** Mobile card row template. Receives the row + selection state. */
export type MobileRowRenderer<TRow> = (args: {
  row: TRow;
  selected: boolean;
  onToggleSelect: () => void;
}) => ReactNode;
