import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn'

export interface FilterOption<T extends string> {
  value: T
  label: string
  /** A small leading mark, such as a status dot. */
  adornment?: ReactNode
}

interface FilterSelectProps<T extends string> {
  /** What is being filtered, e.g. "Status". Shown before the value and used as the accessible name. */
  label: string
  value: T
  options: readonly FilterOption<T>[]
  onChange: (value: T) => void
  icon?: ReactNode
  /** The value meaning "no filter"; the button looks idle while it is chosen. */
  emptyValue?: T
  /** Open the list above the button (for controls at the bottom of the page). */
  menuPlacement?: 'bottom' | 'top'
  className?: string
}

/**
 * A compact select for filter bars: a pill button that opens an animated
 * listbox. Keyboard: Enter, Space or the arrows open it; arrows, Home and End
 * move; Enter or Space choose; Escape or Tab close.
 */
export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  icon,
  emptyValue,
  menuPlacement = 'bottom',
  className,
}: FilterSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const selected = options.find((o) => o.value === value) ?? options[0]
  const isSet = emptyValue === undefined ? true : value !== emptyValue

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function show() {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  function choose(index: number) {
    onChange(options[index].value)
    setOpen(false)
    button.current?.focus()
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      show()
    }
  }

  function onListKeyDown(event: KeyboardEvent) {
    const last = options.length - 1
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
    }
    if (moves[event.key]) {
      event.preventDefault()
      setActive(moves[event.key]())
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape') {
      // Only this menu closes, not a drawer around it.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${label}: ${selected.label}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onButtonKeyDown}
        className={cn(
          'focus-ring inline-flex h-10 items-center gap-2 rounded-control border px-3.5 text-sm shadow-soft transition-all duration-150 ease-smooth',
          isSet
            ? 'border-brand/30 bg-brand-soft text-brand-ink hover:border-brand/50'
            : 'border-line-strong bg-surface text-ink-muted hover:border-ink-subtle/50 hover:text-ink',
        )}
      >
        {icon && <span className="[&_svg]:h-4 [&_svg]:w-4">{icon}</span>}
        <span className="text-ink-subtle">{label}</span>
        <span className={cn('font-medium', isSet ? 'text-brand-ink' : 'text-ink')}>{selected.label}</span>
        <ChevronDown className={cn('h-4 w-4 transition-transform duration-200 ease-smooth', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={onListKeyDown}
          className={cn(
            'absolute z-30 max-h-72 min-w-[220px] animate-pop-in overflow-auto rounded-card border border-line bg-surface/95 p-1.5 shadow-elevated outline-none backdrop-blur-xl',
            menuPlacement === 'top' ? 'bottom-full right-0 mb-2' : 'left-0 top-full mt-2',
          )}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-sm text-ink transition-colors',
                index === active && 'bg-surface-sunken',
              )}
            >
              {option.adornment}
              <span className="flex-1">{option.label}</span>
              {option.value === value && <Check className="h-4 w-4 text-brand-ink" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
