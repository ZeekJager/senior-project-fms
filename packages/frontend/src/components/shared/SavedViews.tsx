import { Bookmark, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, IconButton } from '@/components/ui'
import { usePreference } from '@/lib/preferences'

interface Saved {
  name: string
  /** The list's URL query, without the page: views, filters, search and sort. */
  query: string
}

const NONE: Saved[] = []

/** The query as a saved view keeps it: no page number. */
function viewQuery(params: URLSearchParams): string {
  const p = new URLSearchParams(params)
  p.delete('page')
  p.sort()
  return p.toString()
}

/**
 * "Saved views": remember the current views, filters, search and sort under a
 * name, and bring them back with one click. Kept on this device, per screen
 * (`screen` is a short name such as "vehicles").
 */
export function SavedViews({ screen }: { screen: string }) {
  const [params, setParams] = useSearchParams()
  const [saved, setSaved] = usePreference<Saved[]>(`fms-saved-views-${screen}`, NONE)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const current = viewQuery(params)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && current.length > 0 && !saved.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())

  return (
    <div ref={root} className="relative">
      <Button ref={button} variant="secondary" leadingIcon={<Bookmark className="h-4 w-4" />} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true" aria-controls={open ? id : undefined}>
        Saved views
      </Button>
      {open && (
        <div id={id} role="group" aria-label="Saved views" className="absolute left-0 z-40 mt-2 w-72 rounded-sheet border border-line bg-surface p-3 shadow-elevated">
          {saved.length === 0 ? (
            <p className="px-1 pb-2 text-sm text-ink-muted">Nothing saved yet. Set up the views, filters and sort you want, then save them here.</p>
          ) : (
            <ul className="mb-2 space-y-1">
              {saved.map((s) => (
                <li key={s.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-current={s.query === current ? 'true' : undefined}
                    onClick={() => {
                      setParams(new URLSearchParams(s.query), { replace: true })
                      setOpen(false)
                    }}
                    className="focus-ring min-w-0 flex-1 truncate rounded-control px-2 py-2 text-left text-sm text-ink hover:bg-surface-sunken aria-[current=true]:bg-brand-soft aria-[current=true]:text-brand-ink coarse:min-h-11"
                  >
                    {s.name}
                  </button>
                  <IconButton size="sm" label={`Delete saved view ${s.name}`} icon={<Trash2 />} onClick={() => setSaved(saved.filter((x) => x.name !== s.name))} />
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2 border-t border-line pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!canSave) return
              setSaved([...saved, { name: trimmed, query: current }])
              setName('')
            }}
          >
            <input
              aria-label="Name for the current view"
              placeholder={current ? 'Name this view' : 'Choose some filters first'}
              disabled={!current}
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              className="focus-ring h-9 min-w-0 flex-1 rounded-control border border-line-strong bg-surface-muted px-3 text-sm text-ink placeholder:text-ink-subtle disabled:opacity-60 coarse:h-11"
            />
            <Button type="submit" size="sm" disabled={!canSave}>
              Save
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
