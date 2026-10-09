import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, cn, FilterSelect, IconButton, Skeleton } from '@/components/ui'
import { ErrorState } from './ErrorBoundary'

type Breakpoint = 'sm' | 'md' | 'lg' | 'xl'

// Written out in full: Tailwind only generates classes it can find as text.
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
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

export interface Pagination {
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizes?: readonly number[]
}

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
  /** Rows shown while loading; defaults to the page size (capped at 10). */
  skeletonRows?: number
}

/** Every row is 64px, real or placeholder: the 8px grid, and no layout shift when data arrives. */
const ROW = 'h-16'

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
  skeletonRows,
}: DataTableProps<T>) {
  const rows = data ?? []
  const empty = isEmpty ?? (!isLoading && !error && rows.length === 0)
  const placeholderCount = skeletonRows ?? Math.min(pagination?.pageSize ?? 8, 10)
  const showBody = !error && !(empty && !isLoading)

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-left" aria-busy={isLoading || undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-muted/70">
              {columns.map((column) => (
                <HeaderCell key={column.key} column={column} sort={sort} />
              ))}
            </tr>
          </thead>
          {showBody && (
            <tbody className="divide-y divide-line">
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
                    <tr key={rowKey(row)} className={cn(ROW, 'group transition-colors duration-150 hover:bg-surface-muted/80')}>
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
      {pagination && !error && !(empty && !isLoading) && <PageControls pagination={pagination} />}
    </Card>
  )
}

function HeaderCell<T>({ column, sort }: { column: Column<T>; sort?: SortState }) {
  const sorted = sort && column.sortKey === sort.key ? sort.order : null
  const classes = cn(
    'h-11 px-3 text-xs font-medium uppercase tracking-wide text-ink-subtle',
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
        className="focus-ring -mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 uppercase tracking-wide transition-colors hover:text-ink"
      >
        {column.header}
        <Icon className={cn('h-3.5 w-3.5', !sorted && 'opacity-50')} aria-hidden="true" />
      </button>
    </th>
  )
}

function PageControls({ pagination }: { pagination: Pagination }) {
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
