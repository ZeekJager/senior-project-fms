import { AlertCircle, Check, ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn'
import { Spinner } from './Spinner'

export interface ComboboxOption<T> {
  value: T
  key: string
  /** What the field shows once chosen, and what screen readers read. */
  label: string
  /** Second line in the list (e.g. "Isuzu FSR · Addis Ababa"). */
  detail?: ReactNode
  /** A trailing badge in the list (e.g. "Flagged", "3 in stock"). */
  aside?: ReactNode
  /** Options with the same group are listed under that heading, in order. */
  group?: string
}

interface ComboboxProps<T> {
  label: string
  value: ComboboxOption<T> | null
  onChange: (option: ComboboxOption<T> | null) => void
  /** The text typed; the caller filters or fetches options from it. */
  query: string
  onQueryChange: (query: string) => void
  options: readonly ComboboxOption<T>[]
  loading?: boolean
  error?: string | null
  hint?: ReactNode
  emptyText?: string
  /** Keep the label for screen readers only (compact rows). */
  hideLabel?: boolean
  className?: string
}

/**
 * A searchable select (WAI-ARIA combobox with a listbox popup): type to
 * search, arrows to move, Enter to choose, Escape to close (only the list,
 * not a drawer around it). Floating-label look, like TextField.
 */
export function Combobox<T>({ label, value, onChange, query, onQueryChange, options, loading, error, hint, emptyText = 'No matches', hideLabel, className }: ComboboxProps<T>) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const shown = open ? query : (value?.label ?? query)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => setActive(0), [options])

  function choose(option: ComboboxOption<T>) {
    onChange(option)
    onQueryChange('')
    setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else setActive((i) => Math.min(options.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      if (options[active]) choose(options[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  let lastGroup: string | undefined
  return (
    <div ref={root} className={cn('relative', className)}>
      <div className="relative">
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${id}-opt-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-message`}
          autoComplete="off"
          placeholder={hideLabel ? label : ' '}
          value={shown}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onQueryChange(e.target.value)
            if (value) onChange(null)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'peer block w-full rounded-control border bg-surface pr-16 text-sm text-ink shadow-soft placeholder:text-ink-subtle',
            'transition-[border-color,box-shadow] duration-150 ease-smooth hover:border-ink-subtle/50 focus:outline-none focus:ring-4',
            hideLabel ? 'h-10 pl-3' : 'h-14 pb-1.5 pl-4 pt-[22px] placeholder:text-transparent',
            error ? 'border-danger/70 focus:border-danger focus:ring-danger/15' : 'border-line-strong focus:border-brand focus:ring-brand/15',
          )}
        />
        <label
          htmlFor={id}
          className={
            hideLabel
              ? 'sr-only'
              : cn(
                  'pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 select-none text-sm text-ink-subtle transition-all duration-150 ease-smooth',
                  'peer-focus:top-[15px] peer-focus:text-xs peer-focus:font-medium peer-focus:text-brand-ink',
                  'peer-[:not(:placeholder-shown)]:top-[15px] peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:font-medium',
                )
          }
        >
          {label}
        </label>
        <span className="absolute inset-y-0 right-3 flex items-center gap-1 text-ink-subtle">
          {loading && <Spinner className="h-4 w-4" />}
          {value && (
            <button
              type="button"
              aria-label={`Clear ${label}`}
              onClick={() => {
                onChange(null)
                onQueryChange('')
                input.current?.focus()
              }}
              className="focus-ring rounded-md p-1 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
        </span>
      </div>

      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 animate-pop-in overflow-auto rounded-card border border-line bg-surface p-1.5 shadow-elevated"
        >
          {options.length === 0 && <li className="px-3 py-2.5 text-sm text-ink-subtle">{loading ? 'Searching…' : emptyText}</li>}
          {options.map((option, index) => {
            const heading = option.group && option.group !== lastGroup ? option.group : null
            lastGroup = option.group
            return [
              heading && (
                <li key={`g-${heading}`} role="presentation" className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">
                  {heading}
                </li>
              ),
              <li
                key={option.key}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={value?.key === option.key}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-sm text-ink', index === active && 'bg-surface-sunken')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.detail && <span className="block truncate text-xs text-ink-subtle">{option.detail}</span>}
                </span>
                {option.aside}
                {value?.key === option.key && <Check className="h-4 w-4 text-brand-ink" aria-hidden="true" />}
              </li>,
            ]
          })}
        </ul>
      )}

      <p id={`${id}-message`} aria-live="polite" className={cn('flex min-h-5 items-start gap-1.5 px-1 text-xs', hideLabel ? 'mt-1' : 'mt-1.5', error ? 'text-danger' : 'text-ink-subtle')}>
        {error ? (
          <>
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {error}
          </>
        ) : (
          hint
        )}
      </p>
    </div>
  )
}
