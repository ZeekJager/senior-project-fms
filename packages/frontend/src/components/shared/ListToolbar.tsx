import { Search, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, Spinner, ViewTabs, type ViewOption } from '@/components/ui'

interface ListToolbarProps<T extends string> {
  /** The views of the list ("which rows?") with their counts. */
  views?: {
    label: string
    value: T | null
    options: readonly ViewOption<T>[]
    onChange: (value: T) => void
  }
  search?: {
    /** Accessible name, e.g. "Search vehicles". */
    label: string
    placeholder: string
    value: string
    onChange: (value: string) => void
    /** Shows a spinner while a typed search is loading. */
    busy?: boolean
  }
  /** Other narrowing controls (depot, role…): the views and search cover the rest. */
  children?: ReactNode
  /** Given when filters are applied; shows "Clear" inside the search box (or beside the filters when there is no search). */
  onClear?: () => void
}

/**
 * The bar on top of every list, in one order: views, then search and extra
 * filters. Two rows on a desktop, three short ones on a phone (a scrolling
 * row of views, search, then the filters side by side). Clear sits inside the
 * search box, so nothing moves when it appears.
 */
export function ListToolbar<T extends string>({ views, search, children, onClear }: ListToolbarProps<T>) {
  return (
    <div className="flex flex-col gap-2 sm:gap-3">
      {views && <ViewTabs label={views.label} value={views.value} options={views.options} onChange={views.onChange} />}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {search && (
          <div className="relative flex-1 sm:w-72 sm:flex-none">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label={search.label}
              aria-keyshortcuts="/"
              placeholder={search.placeholder}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              className={`focus-ring h-9 w-full rounded-control border border-line-strong bg-surface-muted pl-10 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand coarse:h-11 ${onClear ? 'pr-24' : 'pr-10'}`}
            />
            {search.busy && search.value && <Spinner className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle ${onClear ? 'right-[5.75rem]' : 'right-3.5'}`} />}
            {!search.value && !onClear && (
              <kbd
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line-strong px-1.5 text-2xs font-medium text-ink-subtle coarse:hidden"
              >
                /
              </kbd>
            )}
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                title="Clear the search and every filter"
                className="focus-ring absolute right-1.5 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink coarse:h-9"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Clear
              </button>
            )}
          </div>
        )}
        {children && <div className="grid grid-cols-2 gap-2 sm:contents [&>button]:col-span-2 sm:[&>button]:col-auto">{children}</div>}
        {!search && onClear && (
          <Button variant="ghost" leadingIcon={<X className="h-4 w-4" />} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}
