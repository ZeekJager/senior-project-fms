import { AlertTriangle, Check, CircleSlash, Palmtree, PenLine, RotateCcw, ScanLine, UserCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, cn, Spinner } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { clockTime, METHOD_LABELS, STATUS_LABELS, TOGGLE_STATUSES, type AttendanceStatus, type CheckMethod, type RosterEntry } from './api'

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
  CONFLICT_ATTENDANCE_DUPLICATE: 'Already recorded. Refresh to see it.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This driver has been retired.',
}

interface AttendanceCardProps {
  entry: RosterEntry
  depotName?: string
  canWrite: boolean
  /** The roster is for a future day: only leave (and other) can be booked. */
  future: boolean
  onMark: (entry: RosterEntry, status: AttendanceStatus) => Promise<unknown>
  /** Today, for staff: record the driver's arrival or leaving by hand, now (FMS-141). */
  onRecordTime?: (entry: RosterEntry, kind: 'check_in_at' | 'check_out_at') => Promise<unknown>
}

/**
 * One driver in the roll call: who, their licence warning, and a three-way
 * toggle that saves on click (optimistically; reverted if the save fails).
 */
export function AttendanceCard({ entry, depotName, canWrite, future, onMark, onRecordTime }: AttendanceCardProps) {
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

  async function record(kind: 'check_in_at' | 'check_out_at') {
    if (!onRecordTime || pending) return
    setPending(kind === 'check_in_at' ? 'present' : (entry.attendance?.status ?? 'present'))
    setError(null)
    try {
      await onRecordTime(entry, kind)
      setJustSaved(true)
    } catch (err) {
      setError((err instanceof ApiError && ERRORS[err.code]) || 'Could not save. Try again.')
    } finally {
      setPending(null)
    }
  }

  const a = entry.attendance
  const showTimes = Boolean(a?.check_in_at) || Boolean(onRecordTime)
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
                  'focus-ring flex h-9 coarse:h-11 items-center justify-center gap-1.5 rounded-control text-xs font-semibold transition-all duration-200 ease-smooth [&_svg]:h-3.5 [&_svg]:w-3.5',
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

      {showTimes && (
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <CheckTime
            label="Check-in"
            at={a?.check_in_at ?? null}
            method={a?.check_in_method ?? null}
            action={onRecordTime && !a?.check_in_at ? { text: 'Record arrival', run: () => void record('check_in_at'), busy: Boolean(pending) } : undefined}
            name={entry.full_name}
          />
          <CheckTime
            label="Check-out"
            at={a?.check_out_at ?? null}
            method={a?.check_out_method ?? null}
            action={onRecordTime && a?.check_in_at && !a.check_out_at ? { text: 'Record leaving', run: () => void record('check_out_at'), busy: Boolean(pending) } : undefined}
            name={entry.full_name}
          />
        </dl>
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

const METHOD_ICONS: Record<CheckMethod, ReactNode> = { qr: <ScanLine />, manual: <PenLine /> }

/** A check-in or check-out: its time in Addis Ababa and how it was recorded, or a way to record it now. */
function CheckTime({
  label,
  at,
  method,
  action,
  name,
}: {
  label: string
  at: string | null
  method: CheckMethod | null
  action?: { text: string; run: () => void; busy: boolean }
  name: string
}) {
  return (
    <div className="min-w-0 rounded-control bg-surface-sunken px-2.5 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 flex min-h-5 items-center gap-1.5 text-sm">
        {at ? (
          <>
            <span className="tabular font-semibold text-ink">{clockTime(at)}</span>
            {method && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5" title={method === 'qr' ? 'Scanned at the depot' : 'Recorded by hand'}>
                {METHOD_ICONS[method]}
                {METHOD_LABELS[method]}
              </span>
            )}
          </>
        ) : action ? (
          <button
            type="button"
            disabled={action.busy}
            onClick={action.run}
            aria-label={`${action.text} for ${name}`}
            className="focus-ring -mx-1 rounded px-1 text-xs font-medium text-brand-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.text}
          </button>
        ) : (
          <span className="text-ink-subtle">Not yet</span>
        )}
      </dd>
    </div>
  )
}
