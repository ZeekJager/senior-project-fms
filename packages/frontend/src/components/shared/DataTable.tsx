import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Card, cn, FilterSelect, IconButton, Skeleton } from '@/components/ui'
import { ErrorState } from './ErrorBoundary'

type Breakpoint = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

// Written out in full: Tailwind only generates classes it can find as text.
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
  '2xl': 'hidden 2xl:table-cell',
}

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Width in the fixed layout, as a Tailwind class (e.g. "w-[22%]"); the rest share what is left. */
  width?: string
  align?: 'left' | 'right'
  /** Hide the column on narrower screens, so phones keep the columns that matter. */
  hideBelow?: Breakpoint
  /** The API sort key, if the column can be sorted. */
  sortKey?: string
  /** Placeholder shape while loading; defaults to a line of text. */
  skeleton?: ReactNode
}

/** Numbered pages with a total (most lists, api-contract §18). */
export interface PagePagination {
  kind?: 'pages'
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizes?: readonly number[]
}

/**
 * Cursor pages: previous and next, no total (the audit log, FMS-28). The
 * caller keeps the cursors; `useCursorPages` does it.
 */
export interface CursorPagination {
  kind: 'cursor'
  /** 1-based position, for the range shown ("51–100"). */
  pageIndex: number
  pageSize: number
  hasNext: boolean
  onNext: () => void
  onPrevious: () => void
}

export type Pagination = PagePagination | CursorPagination

export interface SortState {
  key: string
  order: 'asc' | 'desc'
  onChange: (key: string) => void
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[] | undefined
  rowKey: (row: T) => string
  /** Describes the table to screen readers (visually hidden). */
  caption: string
  /** First load, or new filters: skeleton rows the same height as real ones, so nothing shifts. */
  isLoading: boolean
  /** Shows `emptyState` instead of rows. Defaults to "loaded and no rows". */
  isEmpty?: boolean
  error?: unknown
  onRetry?: () => void
  emptyState?: ReactNode
  pagination?: Pagination
  sort?: SortState
  /** Search and filters, shown in a bar on top of the same panel as the rows. */
  toolbar?: ReactNode
  /** Rows shown while loading; defaults to the page size (capped at 10). */
  skeletonRows?: number
  /**
   * `regular`: 56px rows. `stacked`: 72px on phones, 56px from `sm` up, for
   * tables whose first cell stacks a third line (a badge) on phones. Real and
   * placeholder rows always share it, so nothing moves when data arrives.
   */
  rowHeight?: RowHeight
}

export type RowHeight = 'regular' | 'stacked'

/** On the 8px grid. Written out in full: Tailwind only generates classes it can find as text. */
const ROW_HEIGHT: Record<RowHeight, string> = {
  regular: 'h-14',
  stacked: 'h-[72px] sm:h-14',
}

/**
 * Development only: a row taller than its skeleton means content outgrew the
 * row height, and the page jumps when data arrives. Warns with the caption.
 */
function useRowHeightCheck(caption: string, isLoading: boolean, rowCount: number) {
  const body = useRef<HTMLTableSectionElement>(null)
  const skeletonHeight = useRef(0)
  useLayoutEffect(() => {
    if (!import.meta.env.DEV || !body.current) return
    const first = body.current.rows[0]
    if (!first) return
    const height = first.getBoundingClientRect().height
    if (isLoading) {
      skeletonHeight.current = height
      return
    }
    const tallest = Math.max(...Array.from(body.current.rows, (r) => r.getBoundingClientRect().height))
    if (skeletonHeight.current > 0 && tallest > skeletonHeight.current + 0.5) {
      console.warn(
        `DataTable "${caption}": rows are up to ${Math.round(tallest)}px, taller than the ${Math.round(skeletonHeight.current)}px loading rows, so the page jumps when data arrives. Shorten the cell content or set rowHeight="stacked".`,
      )
    }
  }, [caption, isLoading, rowCount])
  return body
}

/** What a screen reader hears when the table changes: loading, the rows shown, or none. */
function statusText(caption: string, isLoading: boolean, error: unknown, empty: boolean, shown: number, pagination?: Pagination): string {
  if (isLoading) return `Loading ${caption.toLowerCase()}…`
  if (error) return ''
  if (empty) return `${caption}: nothing to show.`
  if (!pagination) return `${caption}: ${shown} ${shown === 1 ? 'row' : 'rows'}.`
  if (pagination.kind === 'cursor') {
    const first = (pagination.pageIndex - 1) * pagination.pageSize + 1
    return `${caption}: ${first}–${first + shown - 1}${pagination.hasNext ? ', more after' : ''}.`
  }
  const first = (pagination.page - 1) * pagination.pageSize + 1
  return `${caption}: ${first}–${first + shown - 1} of ${pagination.totalItems}.`
}

/**
 * The shared table (FMS-67): fixed layout so wide lists never scroll
 * sideways on a desktop, skeleton rows during loads, an empty state, an
 * error state with retry, sorting by column and page controls.
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
  rowHeight = 'regular',
}: DataTableProps<T>) {
  const rows = data ?? []
  const ROW = ROW_HEIGHT[rowHeight]
  const empty = isEmpty ?? (!isLoading && !error && rows.length === 0)
  const placeholderCount = skeletonRows ?? Math.min(pagination?.pageSize ?? 8, 10)
  const showBody = !error && !(empty && !isLoading)
  const body = useRowHeightCheck(caption, isLoading, rows.length)

  return (
    <Card className="overflow-hidden">
      {toolbar && <div className="border-b border-line p-3">{toolbar}</div>}
      {/* Always present, so changes are announced (a live region added with its text is not).
          No status role: the page's toast region keeps that, and tests find it by role. */}
      <p aria-live="polite" aria-atomic="true" data-testid="table-status" className="sr-only">
        {statusText(caption, isLoading, error, empty, rows.length, pagination)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-left" aria-busy={isLoading || undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              {columns.map((column) => (
                <HeaderCell key={column.key} column={column} sort={sort} />
              ))}
            </tr>
          </thead>
          {showBody && (
            <tbody ref={body} className="divide-y divide-line">
              {isLoading
                ? Array.from({ length: placeholderCount }, (_, i) => (
                    <tr key={`skeleton-${i}`} className={ROW} data-testid="skeleton-row">
                      {columns.map((column) => (
                        <td key={column.key} className={cn('px-3', column.hideBelow && HIDE_BELOW[column.hideBelow], column.width)}>
                          {column.skeleton ?? <Skeleton className={cn('h-3.5', i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-1/2' : 'w-2/3')} />}
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((row) => (
                    <tr key={rowKey(row)} className={cn(ROW, 'group transition-colors duration-150 hover:bg-surface-muted')}>
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            'px-3 text-sm text-ink',
                            column.align === 'right' && 'text-right',
                            column.hideBelow && HIDE_BELOW[column.hideBelow],
                          )}
                        >
                          {column.cell(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          )}
        </table>
      </div>
      {error ? <ErrorState error={error} onRetry={onRetry} heading="We couldn't load this list" /> : null}
      {!error && empty && !isLoading ? emptyState : null}
      {pagination && !error && !(empty && !isLoading) && (pagination.kind === 'cursor' ? <CursorControls pagination={pagination} shown={rows.length} /> : <PageControls pagination={pagination} />)}
    </Card>
  )
}

function HeaderCell<T>({ column, sort }: { column: Column<T>; sort?: SortState }) {
  const sorted = sort && column.sortKey === sort.key ? sort.order : null
  const classes = cn(
    'h-10 coarse:h-12 px-3 text-xs font-semibold text-ink-muted',
    column.align === 'right' && 'text-right',
    column.hideBelow && HIDE_BELOW[column.hideBelow],
    column.width,
  )
  if (!column.sortKey || !sort) {
    return (
      <th scope="col" className={classes}>
        {column.header}
      </th>
    )
  }
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <th scope="col" className={classes} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
      <button
        type="button"
        onClick={() => sort.onChange(column.sortKey!)}
        className="focus-ring -mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors coarse:min-h-11 hover:text-ink"
      >
        {column.header}
        <Icon className={cn('h-3.5 w-3.5', !sorted && 'opacity-50')} aria-hidden="true" />
      </button>
    </th>
  )
}

function CursorControls({ pagination, shown }: { pagination: CursorPagination; shown: number }) {
  const { pageIndex, pageSize, hasNext, onNext, onPrevious } = pagination
  const first = shown === 0 ? 0 : (pageIndex - 1) * pageSize + 1
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <p className="tabular text-sm text-ink-muted">
        <span className="font-medium text-ink">{first.toLocaleString()}</span>–<span className="font-medium text-ink">{(first + shown - (shown ? 1 : 0)).toLocaleString()}</span>
        {hasNext && <span className="text-ink-subtle"> · more after</span>}
      </p>
      <div className="flex items-center gap-2">
        <span className="tabular hidden px-2 text-sm text-ink-muted sm:inline">Page {pageIndex}</span>
        <IconButton variant="secondary" label="Previous page" icon={<ChevronLeft />} disabled={pageIndex <= 1} onClick={onPrevious} />
        <IconButton variant="secondary" label="Next page" icon={<ChevronRight />} disabled={!hasNext} onClick={onNext} />
      </div>
    </nav>
  )
}

function PageControls({ pagination }: { pagination: PagePagination }) {
  const { page, pageSize, totalItems, onPageChange, onPageSizeChange, pageSizes = [25, 50, 100] } = pagination
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const first = totalItems === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, totalItems)
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <p className="tabular text-sm text-ink-muted">
        <span className="font-medium text-ink">{first.toLocaleString()}</span>–<span className="font-medium text-ink">{last.toLocaleString()}</span> of{' '}
        <span className="font-medium text-ink">{totalItems.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <FilterSelect
            label="Rows"
            value={String(pageSize)}
            emptyValue={String(pageSize)}
            menuPlacement="top"
            options={pageSizes.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => onPageSizeChange(Number(v))}
          />
        )}
        <span className="tabular hidden px-2 text-sm text-ink-muted sm:inline">
          Page {page} of {totalPages}
        </span>
        <IconButton variant="secondary" label="Previous page" icon={<ChevronLeft />} disabled={page <= 1} onClick={() => onPageChange(page - 1)} />
        <IconButton variant="secondary" label="Next page" icon={<ChevronRight />} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} />
      </div>
    </nav>
  )
}
