import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Card, cn, FilterSelect, IconButton, Skeleton } from "@/components/ui";
import { usePreference } from "@/lib/preferences";
import { ErrorState } from "./ErrorBoundary";
import { TableOptions, type Density } from "./TableOptions";

type Breakpoint = "sm" | "md" | "lg" | "xl" | "2xl";

// Written out in full: Tailwind only generates classes it can find as text.
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
  "2xl": "hidden 2xl:table-cell",
};

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Width in the fixed layout, as a Tailwind class (e.g. "w-[22%]"); the rest share what is left. */
  width?: string;
  align?: "left" | "right";
  /** Hide the column on narrower screens, so phones keep the columns that matter. */
  hideBelow?: Breakpoint;
  /** The API sort key, if the column can be sorted. */
  sortKey?: string;
  /** Placeholder shape while loading; defaults to a line of text. */
  skeleton?: ReactNode;
  /** A user may hide this column from "Table options" (the table needs a `tableId`). */
  optional?: boolean;
  /** The column's name in "Table options", when `header` is not plain text. */
  label?: string;
}

/** Numbered pages with a total (most lists, api-contract §18). */
export interface PagePagination {
  kind?: "pages";
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizes?: readonly number[];
}

/**
 * Cursor pages: previous and next, no total (the audit log, FMS-28). The
 * caller keeps the cursors; `useCursorPages` does it.
 */
export interface CursorPagination {
  kind: "cursor";
  /** 1-based position, for the range shown ("51–100"). */
  pageIndex: number;
  pageSize: number;
  hasNext: boolean;
  onNext: () => void;
  onPrevious: () => void;
}

export type Pagination = PagePagination | CursorPagination;

export interface SortState {
  key: string;
  order: "asc" | "desc";
  onChange: (key: string) => void;
  /** A second sort, applied after the first (Shift+click on another header sets it). */
  then?: { key: string; order: "asc" | "desc" };
  onThen?: (key: string) => void;
}

/** Which rows are ticked, by `rowKey`. The caller owns the set. */
export interface RowSelection {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[] | undefined;
  rowKey: (row: T) => string;
  /** Describes the table to screen readers (visually hidden). */
  caption: string;
  /** First load, or new filters: skeleton rows the same height as real ones, so nothing shifts. */
  isLoading: boolean;
  /** Shows `emptyState` instead of rows. Defaults to "loaded and no rows". */
  isEmpty?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyState?: ReactNode;
  pagination?: Pagination;
  sort?: SortState;
  /** Search and filters, shown in a bar on top of the same panel as the rows. */
  toolbar?: ReactNode;
  /** Rows shown while loading; defaults to the page size (capped at 10). */
  skeletonRows?: number;
  /**
   * `regular`: 56px rows. `stacked3`: 92px on phones for a three-line first cell. `stacked`: 72px on phones, 56px from `sm` up, for
   * tables whose first cell stacks a third line (a badge) on phones. Real and
   * placeholder rows always share it, so nothing moves when data arrives.
   */
  rowHeight?: RowHeight;
  /** Gives the table a remembered row height and column chooser. A short stable name, e.g. "vehicles". */
  tableId?: string;
  /**
   * A click on a row (outside its own buttons and links) opens it. The keyboard
   * does the same: J and K move through the rows, Enter opens the one marked.
   */
  onRowClick?: (row: T) => void;
  /** The row's name, spoken when J or K lands on it ("AA 3-20212"). */
  rowLabel?: (row: T) => string;
  /** A class for a row that needs attention, such as a tint. */
  rowClassName?: (row: T) => string | undefined;
  /** Adds a checkbox column. */
  selection?: RowSelection;
}

export type RowHeight = "regular" | "stacked" | "stacked3";

/** On the 8px grid. Written out in full: Tailwind only generates classes it can find as text. Compact is 44px; touch screens keep 56px. */
const ROW_HEIGHT: Record<Density, Record<RowHeight, string>> = {
  comfortable: {
    regular: "h-14",
    stacked: "h-[72px] sm:h-14",
    stacked3: "h-[92px] sm:h-14",
  },
  compact: {
    regular: "h-11 coarse:h-14",
    stacked: "h-[72px] sm:h-11 sm:coarse:h-14",
    stacked3: "h-[92px] sm:h-11 sm:coarse:h-14",
  },
};

const NO_HIDDEN: string[] = [];
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="button"], [role="checkbox"]';

/**
 * Development only: a row taller than its skeleton means content outgrew the
 * row height, and the page jumps when data arrives. Warns with the caption.
 */
function useRowHeightCheck(
  caption: string,
  isLoading: boolean,
  rowCount: number,
) {
  const body = useRef<HTMLTableSectionElement>(null);
  const skeletonHeight = useRef(0);
  useLayoutEffect(() => {
    if (!import.meta.env.DEV || !body.current) return;
    const first = body.current.rows[0];
    if (!first) return;
    const height = first.getBoundingClientRect().height;
    if (isLoading) {
      skeletonHeight.current = height;
      return;
    }
    const tallest = Math.max(
      ...Array.from(body.current.rows, (r) => r.getBoundingClientRect().height),
    );
    if (skeletonHeight.current > 0 && tallest > skeletonHeight.current + 0.5) {
      console.warn(
        `DataTable "${caption}": rows are up to ${Math.round(tallest)}px, taller than the ${Math.round(skeletonHeight.current)}px loading rows, so the page jumps when data arrives. Shorten the cell content or set rowHeight="stacked".`,
      );
    }
  }, [caption, isLoading, rowCount]);
  return body;
}

/** What a screen reader hears when the table changes: loading, the rows shown, or none. */
function statusText(
  caption: string,
  isLoading: boolean,
  error: unknown,
  empty: boolean,
  shown: number,
  pagination?: Pagination,
): string {
  if (isLoading) return `Loading ${caption.toLowerCase()}…`;
  if (error) return "";
  if (empty) return `${caption}: nothing to show.`;
  if (!pagination)
    return `${caption}: ${shown} ${shown === 1 ? "row" : "rows"}.`;
  if (pagination.kind === "cursor") {
    const first = (pagination.pageIndex - 1) * pagination.pageSize + 1;
    return `${caption}: ${first}–${first + shown - 1}${pagination.hasNext ? ", more after" : ""}.`;
  }
  const first = (pagination.page - 1) * pagination.pageSize + 1;
  return `${caption}: ${first}–${first + shown - 1} of ${pagination.totalItems}.`;
}

/** The column's name for the chooser: its `label`, else its header when that is plain text. */
function columnLabel<T>(column: Column<T>): string {
  return (
    column.label ??
    (typeof column.header === "string" ? column.header : column.key)
  );
}

/**
 * The shared table (FMS-67): fixed layout so wide lists never scroll
 * sideways on a desktop, skeleton rows during loads, an empty state, an
 * error state with retry, sorting by column and page controls. Optionally:
 * a remembered row height and column chooser, row selection, a clickable row
 * with J/K/Enter from the keyboard, and a second sort.
 */
export function DataTable<T>({
  columns,
  data,
  rowKey,
  caption,
  isLoading,
  isEmpty,
  error,
  onRetry,
  emptyState,
  pagination,
  sort,
  toolbar,
  skeletonRows,
  rowHeight = "regular",
  tableId,
  onRowClick,
  rowLabel,
  rowClassName,
  selection,
}: DataTableProps<T>) {
  const rows = data ?? [];
  const [density, setDensity] = usePreference<Density>(
    "fms-density",
    "comfortable",
  );
  const [hiddenKeys, setHiddenKeys] = usePreference<string[]>(
    `fms-table-${tableId ?? "none"}-hidden`,
    NO_HIDDEN,
  );
  const visible = columns.filter(
    (c) => !(tableId && c.optional && hiddenKeys.includes(c.key)),
  );
  const ROW = ROW_HEIGHT[density][rowHeight];
  const empty = isEmpty ?? (!isLoading && !error && rows.length === 0);
  const placeholderCount =
    skeletonRows ?? Math.min(pagination?.pageSize ?? 8, 10);
  const showBody = !error && !(empty && !isLoading);
  const body = useRowHeightCheck(caption, isLoading, rows.length);

  // The row the keyboard is on (J and K), cleared whenever the rows change.
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => setActive(null), [data]);
  useEffect(() => {
    if (!onRowClick || rows.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="listbox"], [role="menu"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next =
          active === null
            ? e.key === "j"
              ? 0
              : rows.length - 1
            : Math.min(
                rows.length - 1,
                Math.max(0, active + (e.key === "j" ? 1 : -1)),
              );
        setActive(next);
        body.current?.rows[next]?.scrollIntoView?.({ block: "nearest" });
      } else if (
        e.key === "Enter" &&
        active !== null &&
        (target === document.body || !target)
      ) {
        e.preventDefault();
        onRowClick(rows[active]);
      } else if (e.key === "Escape" && active !== null) {
        setActive(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, body, onRowClick, rows]);

  const ids = rows.map(rowKey);
  const allSelected =
    selection !== undefined &&
    ids.length > 0 &&
    ids.every((id) => selection.selected.has(id));
  const someSelected =
    selection !== undefined && ids.some((id) => selection.selected.has(id));
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const id of ids) {
      if (allSelected) next.delete(id);
      else next.add(id);
    }
    selection.onChange(next);
  };
  const toggleOne = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  const hideable = columns.filter((c) => c.optional);
  const options = tableId ? (
    <TableOptions
      columns={hideable.map((c) => ({ key: c.key, label: columnLabel(c) }))}
      hidden={hiddenKeys}
      onHiddenChange={setHiddenKeys}
      density={density}
      onDensityChange={setDensity}
    />
  ) : null;
  const showFooter = !error && !(empty && !isLoading);

  return (
    <Card className="overflow-hidden">
      {toolbar && <div className="border-b border-line p-3">{toolbar}</div>}
      {/* Always present, so changes are announced (a live region added with its text is not).
          No status role: the page's toast region keeps that, and tests find it by role. */}
      <p
        aria-live="polite"
        aria-atomic="true"
        data-testid="table-status"
        className="sr-only"
      >
        {statusText(caption, isLoading, error, empty, rows.length, pagination)}
      </p>
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {active !== null && rows[active]
          ? `Row ${active + 1} of ${rows.length}${rowLabel ? `: ${rowLabel(rows[active])}` : ""}. Press Enter to open.`
          : ""}
      </p>
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed border-collapse text-left"
          aria-busy={isLoading || undefined}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              {selection && (
                <th
                  scope="col"
                  className="h-10 w-10 px-3 coarse:h-12 coarse:w-12"
                >
                  <label className="-m-2 flex h-10 w-10 cursor-pointer items-center justify-center coarse:-m-3 coarse:h-11 coarse:w-11">
                    <input
                      type="checkbox"
                      aria-label="Select every row on this page"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && someSelected;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-line-strong accent-[rgb(var(--c-brand))] coarse:h-5 coarse:w-5"
                    />
                  </label>
                </th>
              )}
              {visible.map((column) => (
                <HeaderCell key={column.key} column={column} sort={sort} />
              ))}
            </tr>
          </thead>
          {showBody && (
            <tbody ref={body} className="divide-y divide-line">
              {isLoading
                ? Array.from({ length: placeholderCount }, (_, i) => (
                    <tr
                      key={`skeleton-${i}`}
                      className={ROW}
                      data-testid="skeleton-row"
                    >
                      {selection && <td className="w-10 px-3" />}
                      {visible.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            "px-3",
                            column.hideBelow && HIDE_BELOW[column.hideBelow],
                            column.width,
                          )}
                        >
                          {column.skeleton ?? (
                            <Skeleton
                              className={cn(
                                "h-3.5",
                                i % 3 === 0
                                  ? "w-3/4"
                                  : i % 3 === 1
                                    ? "w-1/2"
                                    : "w-2/3",
                              )}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((row, index) => {
                    const id = rowKey(row);
                    const selected = selection?.selected.has(id) ?? false;
                    return (
                      <tr
                        key={id}
                        data-active={active === index || undefined}
                        aria-selected={selection ? selected : undefined}
                        onClick={
                          onRowClick
                            ? (e) => {
                                if (
                                  (e.target as HTMLElement).closest(INTERACTIVE)
                                )
                                  return;
                                onRowClick(row);
                              }
                            : undefined
                        }
                        className={cn(
                          ROW,
                          "group transition-colors duration-150 hover:bg-surface-muted",
                          onRowClick && "cursor-pointer",
                          selected ? "bg-brand-soft/50" : rowClassName?.(row),
                          active === index &&
                            "bg-brand-soft/60 ring-2 ring-inset ring-focus",
                        )}
                      >
                        {selection && (
                          <td className="w-10 px-3 coarse:w-12">
                            <label className="-m-2 flex h-10 w-10 cursor-pointer items-center justify-center coarse:-m-3 coarse:h-11 coarse:w-11">
                              <input
                                type="checkbox"
                                aria-label={`Select ${rowLabel ? rowLabel(row) : `row ${index + 1}`}`}
                                checked={selected}
                                onChange={() => toggleOne(id)}
                                className="h-4 w-4 rounded border-line-strong accent-[rgb(var(--c-brand))] coarse:h-5 coarse:w-5"
                              />
                            </label>
                          </td>
                        )}
                        {visible.map((column) => (
                          <td
                            key={column.key}
                            className={cn(
                              "px-3 text-sm text-ink",
                              column.align === "right" && "text-right",
                              column.hideBelow && HIDE_BELOW[column.hideBelow],
                            )}
                          >
                            {column.cell(row)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
            </tbody>
          )}
        </table>
      </div>
      {error ? (
        <ErrorState
          error={error}
          onRetry={onRetry}
          heading="We couldn't load this list"
        />
      ) : null}
      {!error && empty && !isLoading ? emptyState : null}
      {showFooter &&
        pagination &&
        (pagination.kind === "cursor" ? (
          <CursorControls
            pagination={pagination}
            shown={rows.length}
            extra={options}
          />
        ) : (
          <PageControls pagination={pagination} extra={options} />
        ))}
      {showFooter && !pagination && options && (
        <div className="flex justify-end border-t border-line px-4 py-2">
          {options}
        </div>
      )}
    </Card>
  );
}

function HeaderCell<T>({
  column,
  sort,
}: {
  column: Column<T>;
  sort?: SortState;
}) {
  const sorted = sort && column.sortKey === sort.key ? sort.order : null;
  const second =
    sort?.then && column.sortKey === sort.then.key ? sort.then.order : null;
  const classes = cn(
    "h-10 coarse:h-12 px-3 text-xs font-semibold text-ink-muted",
    column.align === "right" && "text-right",
    column.hideBelow && HIDE_BELOW[column.hideBelow],
    column.width,
  );
  if (!column.sortKey || !sort) {
    return (
      <th scope="col" className={classes}>
        {column.header}
      </th>
    );
  }
  const Icon =
    sorted === "asc" || second === "asc"
      ? ArrowUp
      : sorted === "desc" || second === "desc"
        ? ArrowDown
        : ChevronsUpDown;
  return (
    <th
      scope="col"
      className={classes}
      aria-sort={
        sorted === "asc"
          ? "ascending"
          : sorted === "desc"
            ? "descending"
            : "none"
      }
    >
      <button
        type="button"
        onClick={(e) =>
          e.shiftKey && sort.onThen
            ? sort.onThen(column.sortKey!)
            : sort.onChange(column.sortKey!)
        }
        title={
          sort.onThen
            ? "Sort by this column. Shift+click adds it as a second sort."
            : undefined
        }
        className="focus-ring -mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors coarse:min-h-11 hover:text-ink"
      >
        {column.header}
        <Icon
          className={cn("h-3.5 w-3.5", !sorted && !second && "opacity-50")}
          aria-hidden="true"
        />
        {second && (
          <>
            <span
              aria-hidden="true"
              className="tabular rounded bg-surface-sunken px-1 text-2xs font-semibold text-ink-muted"
            >
              2
            </span>
            <span className="sr-only">
              , second sort, {second === "asc" ? "ascending" : "descending"}
            </span>
          </>
        )}
      </button>
    </th>
  );
}

function CursorControls({
  pagination,
  shown,
  extra,
}: {
  pagination: CursorPagination;
  shown: number;
  extra?: ReactNode;
}) {
  const { pageIndex, pageSize, hasNext, onNext, onPrevious } = pagination;
  const first = shown === 0 ? 0 : (pageIndex - 1) * pageSize + 1;
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3"
    >
      <p className="tabular text-sm text-ink-muted">
        <span className="font-medium text-ink">{first.toLocaleString()}</span>–
        <span className="font-medium text-ink">
          {(first + shown - (shown ? 1 : 0)).toLocaleString()}
        </span>
        {hasNext && <span className="text-ink-subtle"> · more after</span>}
      </p>
      <div className="flex items-center gap-2">
        {extra}
        <span className="tabular hidden px-2 text-sm text-ink-muted sm:inline">
          Page {pageIndex}
        </span>
        <IconButton
          variant="secondary"
          label="Previous page"
          icon={<ChevronLeft />}
          disabled={pageIndex <= 1}
          onClick={onPrevious}
        />
        <IconButton
          variant="secondary"
          label="Next page"
          icon={<ChevronRight />}
          disabled={!hasNext}
          onClick={onNext}
        />
      </div>
    </nav>
  );
}

function PageControls({
  pagination,
  extra,
}: {
  pagination: PagePagination;
  extra?: ReactNode;
}) {
  const {
    page,
    pageSize,
    totalItems,
    onPageChange,
    onPageSizeChange,
    pageSizes = [25, 50, 100],
  } = pagination;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const first = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);
  // One page is only a count: no arrows and no "Page 1 of 1".
  const single = totalPages <= 1;
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3"
    >
      <p className="tabular text-sm text-ink-muted">
        <span className="font-medium text-ink">{first.toLocaleString()}</span>–
        <span className="font-medium text-ink">{last.toLocaleString()}</span> of{" "}
        <span className="font-medium text-ink">
          {totalItems.toLocaleString()}
        </span>
      </p>
      <div className="flex items-center gap-2">
        {extra}
        {onPageSizeChange && (
          <FilterSelect
            label="Rows"
            value={String(pageSize)}
            emptyValue={String(pageSize)}
            menuPlacement="top"
            options={pageSizes.map((n) => ({
              value: String(n),
              label: String(n),
            }))}
            onChange={(v) => onPageSizeChange(Number(v))}
          />
        )}
        {!single && (
          <>
            <span className="tabular hidden px-2 text-sm text-ink-muted sm:inline">
              Page {page} of {totalPages}
            </span>
            <IconButton
              variant="secondary"
              label="Previous page"
              icon={<ChevronLeft />}
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            />
            <IconButton
              variant="secondary"
              label="Next page"
              icon={<ChevronRight />}
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            />
          </>
        )}
      </div>
    </nav>
  );
}
