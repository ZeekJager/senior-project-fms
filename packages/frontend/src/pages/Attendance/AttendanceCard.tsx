import { AlertTriangle, Check, CircleSlash, Palmtree, RotateCcw, UserCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, cn, Spinner } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { STATUS_LABELS, TOGGLE_STATUSES, type AttendanceStatus, type RosterEntry } from './api'

const TOGGLE: Record<(typeof TOGGLE_STATUSES)[number], { icon: ReactNode; on: string }> = {
  present: { icon: <UserCheck />, on: 'bg-emerald-700 text-white shadow-soft' },
  absent: { icon: <CircleSlash />, on: 'bg-red-700 text-white shadow-soft' },
  on_leave: { icon: <Palmtree />, on: 'bg-amber-500 text-amber-950 shadow-soft' },
}

const TINT: Record<AttendanceStatus, string> = {
  present: 'ring-emerald-500',
  absent: 'ring-red-500',
  on_leave: 'ring-amber-400',
  late: 'ring-sky-500',
  sick: 'ring-rose-400',
  other: 'ring-slate-400',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const ERRORS: Record<string, string> = {
  VALIDATION_FAILED: 'Only leave can be recorded ahead of the day.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This driver has been retired.',
}

interface AttendanceCardProps {
  entry: RosterEntry
  depotName?: string
  canWrite: boolean
  /** The roster is for a future day: only leave (and other) can be booked. */
  future: boolean
  onMark: (entry: RosterEntry, status: AttendanceStatus) => Promise<unknown>
}

/**
 * One driver in the roll call: who, their licence warning, and a three-way
 * toggle that saves on click (optimistically; reverted if the save fails).
 */
export function AttendanceCard({ entry, depotName, canWrite, future, onMark }: AttendanceCardProps) {
  const [pending, setPending] = useState<AttendanceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const shown = pending ?? entry.attendance?.status ?? null

  // The "saved" tick fades after 1.6 s; the timer is cleared if the card
  // unmounts first (day or depot changed), so it never updates a gone card.
  useEffect(() => {
    if (!justSaved) return
    const timer = window.setTimeout(() => setJustSaved(false), 1600)
    return () => window.clearTimeout(timer)
  }, [justSaved])

  async function choose(status: AttendanceStatus) {
    if (!canWrite || status === shown || pending) return
    setPending(status)
    setError(null)
    try {
      await onMark(entry, status)
      setJustSaved(true)
    } catch (err) {
      setError((err instanceof ApiError && ERRORS[err.code]) || 'Could not save. Try again.')
    } finally {
      setPending(null)
    }
  }

  const label = `${entry.full_name}: ${shown ? STATUS_LABELS[shown] : 'not marked'}`

  return (
    <article
      aria-label={label}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-card border border-line bg-surface p-4 shadow-card transition-colors duration-200 ease-smooth',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink', shown && `ring-2 ring-offset-2 ring-offset-surface ${TINT[shown]}`)}
          aria-hidden="true"
        >
          {initials(entry.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">{entry.full_name}</p>
          <p className="truncate text-xs text-ink-subtle">{depotName ?? entry.email}</p>
        </div>
        <span className="h-5" aria-live="polite">
          {pending ? (
            <Spinner className="h-4 w-4 text-ink-subtle" />
          ) : justSaved ? (
            <span className="inline-flex animate-fade-in items-center gap-1 text-xs font-medium text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Saved
            </span>
          ) : null}
        </span>
      </div>

      {entry.license_status === 'expired' && (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-danger">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Licence expired: cannot be dispatched
        </p>
      )}

      {canWrite ? (
        <div role="radiogroup" aria-label={`Attendance for ${entry.full_name}`} className="mt-4 grid grid-cols-3 gap-1 rounded-control bg-surface-sunken p-1">
          {TOGGLE_STATUSES.map((status) => {
            const on = shown === status
            const blocked = future && status !== 'on_leave'
            return (
              <button
                key={status}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={blocked || Boolean(pending)}
                title={blocked ? 'Only leave can be recorded ahead of the day' : undefined}
                onClick={() => void choose(status)}
                className={cn(
                  'focus-ring flex h-9 items-center justify-center gap-1.5 rounded-control text-xs font-semibold transition-all duration-200 ease-smooth [&_svg]:h-3.5 [&_svg]:w-3.5',
                  on ? TOGGLE[status].on : 'text-ink-muted hover:bg-surface hover:text-ink hover:shadow-soft',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {TOGGLE[status].icon}
                {STATUS_LABELS[status]}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="mt-4">
          {shown ? (
            <Badge tone={shown === 'present' ? 'success' : shown === 'absent' || shown === 'sick' ? 'danger' : shown === 'on_leave' ? 'warning' : 'info'} dot>
              {STATUS_LABELS[shown]}
            </Badge>
          ) : (
            <Badge>Not marked</Badge>
          )}
        </div>
      )}

      <div className="mt-3 min-h-4 text-xs text-ink-subtle" role={error ? 'alert' : undefined}>
        {error ? (
          <span className="inline-flex items-center gap-1.5 text-danger">
            {error}
            {pending === null && (
              <button type="button" className="focus-ring inline-flex items-center gap-1 rounded font-medium underline" onClick={() => setError(null)}>
                <RotateCcw className="h-3 w-3" aria-hidden="true" /> Dismiss
              </button>
            )}
          </span>
        ) : entry.attendance ? (
          <>
            {!TOGGLE_STATUSES.includes(entry.attendance.status as (typeof TOGGLE_STATUSES)[number]) && (
              <span className="font-medium text-ink-muted">{STATUS_LABELS[entry.attendance.status]} · </span>
            )}
            Marked by {entry.attendance.logged_by_name || 'someone'} at {time(entry.attendance.updated_at)}
          </>
        ) : (
          'Not marked yet'
        )}
      </div>
    </article>
  )
}
