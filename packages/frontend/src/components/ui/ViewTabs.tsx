import { Fragment, useId } from 'react'
import { cn } from './cn'
import { Skeleton } from './Surface'

export interface ViewOption<T extends string> {
  value: T
  label: string
  /** How many rows the view holds; shown beside the name. */
  count?: number
  isLoading?: boolean
  /** A fuller description, for when the name alone could be read two ways. Shown on hover and read out by screen readers. */
  hint?: string
  /** Retired, inactive, deactivated: kept as views, but after a divider and in a quieter style. */
  archived?: boolean
}

interface ViewTabsProps<T extends string> {
  /** What the views are views of, e.g. "Vehicle views". Names the group for screen readers. */
  label: string
  /** The selected view, or null when the filters in the URL match none of them. */
  value: T | null
  options: readonly ViewOption<T>[]
  onChange: (value: T) => void
}

/**
 * One control for "which rows?": a row of named views with their counts. On a
 * phone it scrolls sideways instead of wrapping, so it costs one line.
 */
export function ViewTabs<T extends string>({ label, value, options, onChange }: ViewTabsProps<T>) {
  const id = useId()
  const firstArchived = options.findIndex((o) => o.archived)
  return (
    <div
      role="group"
      aria-label={label}
      className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] [&::-webkit-scrollbar]:hidden"
    >
      {options.map((option, index) => {
        const selected = value === option.value
        const hintId = option.hint ? `${id}-${option.value}` : undefined
        return (
          <Fragment key={option.value}>
            {index === firstArchived && firstArchived > 0 && <span role="separator" aria-orientation="vertical" className="mx-1 my-2 w-px shrink-0 bg-line" />}
            <button
              type="button"
              aria-pressed={selected}
              aria-describedby={hintId}
              title={option.hint}
              onClick={() => onChange(option.value)}
              className={cn(
                'focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-2.5 text-sm font-medium transition-colors duration-150 ease-smooth coarse:h-11 sm:gap-2 sm:px-3',
                selected
                  ? 'bg-brand-soft text-brand-ink'
                  : option.count === 0 || option.archived
                    ? 'text-ink-subtle hover:bg-surface-sunken hover:text-ink'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
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
            {hintId && (
              <span id={hintId} className="sr-only">
                {option.hint}
              </span>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
