import { cn } from './cn'
import { FilterSelect, type FilterOption } from './FilterSelect'
import { Skeleton } from './Surface'

export interface ViewOption<T extends string> {
  value: T
  label: string
  /** How many rows the view holds; shown beside the name. */
  count?: number
  isLoading?: boolean
}

interface ViewTabsProps<T extends string> {
  /** What the views are views of, e.g. "Vehicle views". Names the group for screen readers. */
  label: string
  /** The selected view, or null when the filters in the URL match none of them. */
  value: T | null
  options: readonly ViewOption<T>[]
  onChange: (value: T) => void
  /** Rarely used views, kept in a menu so the bar stays at four choices. */
  more?: { label: string; value: T | ''; options: readonly FilterOption<T | ''>[]; onChange: (value: T | '') => void }
}

/**
 * One control for "which rows?": a short row of named views with their counts.
 * It replaces a stat card, a dropdown and a switch that all filtered the same thing.
 */
export function ViewTabs<T extends string>({ label, value, options, onChange, more }: ViewTabsProps<T>) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <div role="group" aria-label={label} className="flex min-w-0 flex-wrap gap-1 py-1">
        {options.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                'focus-ring inline-flex h-9 coarse:h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-2.5 text-sm font-medium sm:gap-2 sm:px-3 transition-colors duration-150 ease-smooth',
                selected ? 'bg-brand-soft text-brand-ink' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
              )}
            >
              {option.label}{' '}
              {option.isLoading ? (
                <Skeleton className="h-3.5 w-5" />
              ) : (
                option.count !== undefined && (
                  <span className={cn('tabular rounded-full px-1.5 text-xs font-semibold', selected ? 'bg-brand/15 text-brand-ink' : 'bg-surface-sunken text-ink-muted')}>
                    {option.count.toLocaleString()}
                  </span>
                )
              )}
            </button>
          )
        })}
      </div>
      {more && <FilterSelect label={more.label} value={more.value} emptyValue="" options={more.options} onChange={more.onChange} />}
    </div>
  )
}
