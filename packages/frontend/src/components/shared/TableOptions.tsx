import { Settings2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/components/ui'

export type Density = 'comfortable' | 'compact'

interface TableOptionsProps {
  /** The columns a user may hide. */
  columns: { key: string; label: string }[]
  hidden: readonly string[]
  onHiddenChange: (hidden: string[]) => void
  density: Density
  onDensityChange: (density: Density) => void
}

/** Row density and which optional columns to show, remembered on this device. */
export function TableOptions({ columns, hidden, onHiddenChange, density, onDensityChange }: TableOptionsProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink coarse:h-11 coarse:px-3"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        Table options
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Table options" className="absolute bottom-full right-0 z-30 mb-2 w-64 animate-pop-in rounded-card border border-line bg-surface p-3 shadow-elevated">
          <fieldset>
            <legend className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">Row height</legend>
            <div className="flex gap-1 rounded-control bg-surface-sunken p-1">
              {(['comfortable', 'compact'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={density === d}
                  onClick={() => onDensityChange(d)}
                  className={cn(
                    'focus-ring h-8 flex-1 rounded-control text-sm font-medium capitalize transition-colors coarse:h-11',
                    density === d ? 'bg-surface text-ink shadow-soft' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </fieldset>
          {columns.length > 0 && (
            <fieldset className="mt-3">
              <legend className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">Columns</legend>
              <ul className="space-y-0.5">
                {columns.map((column) => {
                  const shown = !hidden.includes(column.key)
                  return (
                    <li key={column.key}>
                      <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-control px-2 text-sm text-ink hover:bg-surface-sunken coarse:min-h-11">
                        <input
                          type="checkbox"
                          checked={shown}
                          onChange={() => onHiddenChange(shown ? [...hidden, column.key] : hidden.filter((k) => k !== column.key))}
                          className="h-4 w-4 rounded border-line-strong accent-[rgb(var(--c-brand))]"
                        />
                        {column.label}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          )}
        </div>
      )}
    </div>
  )
}
