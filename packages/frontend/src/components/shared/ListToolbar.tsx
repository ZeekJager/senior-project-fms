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
    more?: Parameters<typeof ViewTabs<T>>[0]['more']
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
  /** Given when filters are applied; shows "Clear". The slot is reserved, so the bar never jumps. */
  onClear?: () => void
}

/**
 * The bar on top of every list: views, search, extra filters and Clear, in one
 * place and one order, so a user learns the pattern once.
 */
export function ListToolbar<T extends string>({ views, search, children, onClear }: ListToolbarProps<T>) {
  return (
    <div className="flex flex-col gap-3">
      {views && <ViewTabs label={views.label} value={views.value} options={views.options} onChange={views.onChange} more={views.more} />}
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
              className="focus-ring h-9 w-full rounded-control border border-line-strong bg-surface-muted pl-10 pr-10 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand coarse:h-11"
            />
            {search.busy && search.value && <Spinner className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />}
            {!search.value && (
              <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line-strong px-1.5 text-2xs font-medium text-ink-subtle coarse:hidden">
                /
              </kbd>
            )}
          </div>
        )}
        {children}
        <div className="sm:w-20">
          {onClear && (
            <Button variant="ghost" leadingIcon={<X className="h-4 w-4" />} onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
