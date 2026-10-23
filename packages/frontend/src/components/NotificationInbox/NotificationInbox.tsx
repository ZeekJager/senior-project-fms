import { Bell, BellOff, CheckCheck, ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorState } from '@/components/shared'
import { Button, cn, IconButton, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ago } from './ago'
import { useInbox, useMarkAllRead, useMarkRead, type InboxNotification } from './api'
import { notificationLink } from './links'

/** 99+ rather than a number that outgrows the badge. */
const badgeText = (n: number) => (n > 99 ? '99+' : String(n))

/**
 * The notification inbox in the top bar (S-17, FMS-49): a bell whose badge is the unread count, and under it a
 * panel of the last 30 days' notifications. The badge follows the server's `notifications.unread` event the
 * moment it arrives (FMS-48), with no refresh; "Mark all as read" clears it at once; choosing a notification
 * marks it read and opens the screen it is about, if the viewer may open that one. On a phone the panel takes the
 * width of the screen under the top bar. Escape, a click outside or the bell closes it.
 */
export function NotificationInbox({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const { session } = useAuth()
  const inbox = useInbox()
  const markRead = useMarkRead()
  const markAll = useMarkAllRead()

  const unread = inbox.data?.unread ?? 0
  const items = inbox.data?.items ?? []

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

  function choose(n: InboxNotification) {
    if (!n.read) markRead.mutate(n.id)
    const link = notificationLink(n, { permissions: session?.permissions ?? [] })
    setOpen(false)
    if (link) navigate(link)
  }

  return (
    <div ref={root} className={cn('relative', className)}>
      <IconButton
        ref={button}
        label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        icon={<Bell />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      />
      {unread > 0 && (
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface"
        >
          {badgeText(unread)}
        </span>
      )}
      {open && (
        <section
          id={panelId}
          aria-labelledby={`${panelId}-title`}
          // Phones: the width of the screen under the top bar (anchored to the bell it would run off the left
          // edge), at most the rest of the screen tall. From sm: under the bell.
          className="fixed inset-x-4 top-[68px] z-50 flex max-h-[calc(100dvh-84px)] animate-scale-in flex-col overflow-hidden rounded-card border border-line bg-surface shadow-elevated sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:max-h-[min(560px,calc(100dvh-72px))] sm:w-[380px]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`${panelId}-title`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
              Notifications
              {unread > 0 && <span className="ml-2 text-xs font-medium text-ink-muted">{unread} unread</span>}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<CheckCheck className="h-3.5 w-3.5" />}
              disabled={unread === 0}
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all as read
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={inbox.isPending}>
            {inbox.isPending ? (
              <ul aria-label="Loading notifications" className="divide-y divide-line">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-3">
                    <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : inbox.isError ? (
              <ErrorState error={inbox.error} heading="Could not load notifications" onRetry={() => void inbox.refetch()} className="px-4 py-8" />
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center px-2 py-8 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-card bg-surface-sunken text-ink-subtle">
                  <BellOff className="h-5 w-5" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-ink">You&apos;re all caught up</p>
                <p className="mt-1 text-xs text-ink-muted">Alerts about vehicles, licences and trips will appear here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((n) => (
                  <NotificationRow key={n.id} notification={n} linked={notificationLink(n, { permissions: session?.permissions ?? [] }) !== null} onChoose={choose} />
                ))}
              </ul>
            )}
          </div>

          <p className="border-t border-line px-4 py-2 text-xs text-ink-subtle">
            Last 30 days{inbox.data && inbox.data.total > items.length ? ` · the latest ${items.length} of ${inbox.data.total}` : ''}
          </p>
        </section>
      )}
      {/* Announces a change of the count to a screen reader without moving focus. */}
      <span className="sr-only" aria-live="polite">
        {unread > 0 ? `${unread} unread notifications` : ''}
      </span>
    </div>
  )
}

function NotificationRow({ notification: n, linked, onChoose }: { notification: InboxNotification; linked: boolean; onChoose: (n: InboxNotification) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onChoose(n)}
        className={cn(
          'focus-ring flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-muted coarse:min-h-[60px]',
          !n.read && 'bg-brand-soft/40',
        )}
      >
        <span aria-hidden="true" className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-brand')} />
        <span className="min-w-0 flex-1">
          <span className={cn('block break-words text-sm text-ink', n.read ? 'font-medium' : 'font-semibold')}>
            {n.title}
            {!n.read && <span className="sr-only"> (unread)</span>}
          </span>
          <span className="mt-0.5 line-clamp-2 block break-words text-xs text-ink-muted">{n.message}</span>
          <time dateTime={n.created_at} className="mt-1 block text-2xs text-ink-subtle">
            {ago(n.created_at)}
          </time>
        </span>
        {linked && <ChevronRight aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-ink-subtle" />}
      </button>
    </li>
  )
}
