import { Bell, BellOff } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn, IconButton } from '@/components/ui'

/**
 * The top bar's notification slot (FMS-114). The inbox itself (S-17, the
 * alert engine) renders into this panel; until then it says there is
 * nothing to show. Escape, a click outside or the button closes it.
 */
export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    heading.current?.focus()
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
    <div ref={root} className={cn('relative', className)}>
      <IconButton ref={button} label="Notifications" icon={<Bell />} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)} />
      {open && (
        <section
          id={panelId}
          aria-labelledby={`${panelId}-title`}
          // Phones: the width of the screen under the top bar (anchored to the
          // bell it would run off the left edge). From sm: under the bell.
          className="fixed inset-x-4 top-[68px] z-50 animate-scale-in rounded-card border border-line bg-surface p-4 shadow-elevated sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[340px]"
        >
          <h2 id={`${panelId}-title`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
            Notifications
          </h2>
          <div className="flex flex-col items-center px-2 py-8 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-sunken text-ink-subtle">
              <BellOff className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-ink">You&apos;re all caught up</p>
            <p className="mt-1 text-xs text-ink-muted">Alerts about vehicles, licences and trips will appear here.</p>
          </div>
        </section>
      )}
    </div>
  )
}
