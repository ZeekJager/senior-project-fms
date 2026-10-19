import { AlertCircle, AlertTriangle, Archive, CheckCircle2, Clock, Wrench, XCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { StatusBadge } from '@/components/shared'
import { Button, cn, Drawer, Skeleton, TextAreaField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useChangeVehicleStatus, useVehicleStatus } from './api'
import {
  AVAILABILITY_REASONS,
  SETTABLE_STATUSES,
  STATUS_MEANING,
  type Availability,
  type StatusChangeWarning,
  type Vehicle,
  type VehicleAssignment,
  type VehicleStatus,
  type VehicleStatusView,
} from './types'

interface VehicleStatusDrawerProps {
  /** Null: closed. */
  vehicle: Vehicle | null
  onClose: () => void
  /** vehicle:write: the panel offers a status change. */
  canWrite: boolean
  /** Given when the user may decommission this vehicle: shown in the footer, apart from Save. */
  onDecommission?: () => void
}

const MESSAGES: Record<string, string> = {
  CONFLICT_VEHICLE_IN_USE: 'This vehicle is on a trip under way. End the trip first, then change its status.',
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this vehicle a moment ago. The panel now shows their change; check it and try again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'A retired vehicle cannot change status.',
  NOT_FOUND: 'This vehicle no longer exists or is outside your depots.',
}

const REASON_MIN = 3
const REASON_MAX = 500

/** Times as dispatch reads them: Addis Ababa, day and month, 24-hour clock. */
const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const formatWhen = (iso: string) => when.format(new Date(iso))
const shortId = (id: string) => id.slice(0, 8)

/**
 * Vehicle status and availability (FMS-76): whether it can be dispatched now
 * and why not, its trip under way or next, its maintenance, and the last
 * status change. With vehicle:write, a status change with its reason; trips
 * already assigned to it come back as warnings to re-assign.
 */
export function VehicleStatusDrawer({ vehicle, onClose, canWrite, onDecommission }: VehicleStatusDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const status = useVehicleStatus(vehicle?.id ?? null)
  const change = useChangeVehicleStatus()
  const [target, setTarget] = useState<VehicleStatus | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [affected, setAffected] = useState<StatusChangeWarning[]>([])

  useEffect(() => {
    setTarget(null)
    setReason('')
    setReasonError(null)
    setFormError(null)
    setAffected([])
  }, [vehicle?.id])

  const view = status.data
  const editable = canWrite && view !== undefined && view.status !== 'retired'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!vehicle || !view || !target) return
    const trimmed = reason.trim()
    if (trimmed.length < REASON_MIN) {
      setReasonError('Say why, in a few words: it is kept with the change.')
      return
    }
    setFormError(null)
    try {
      const result = await change.mutateAsync({ id: vehicle.id, version: view.version, status: target, reason: trimmed })
      setAffected(result.warnings)
      setTarget(null)
      setReason('')
      toast({
        title: `${view.registration_number} is now ${STATUS_MEANING[result.status.status].label.toLowerCase()}`,
        description:
          result.warnings.length > 0
            ? `${result.warnings.length} assigned trip${result.warnings.length === 1 ? '' : 's'} need${result.warnings.length === 1 ? 's' : ''} another vehicle.`
            : 'The change and its reason are recorded.',
        tone: result.warnings.length > 0 ? 'info' : 'success',
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_CONCURRENT_MODIFICATION') void status.refetch()
      setFormError(err instanceof ApiError ? (MESSAGES[err.code] ?? `The status could not be changed (${err.code}).`) : 'Could not reach the server. Try again.')
    }
  }

  return (
    <Drawer
      open={vehicle !== null}
      onClose={onClose}
      title={vehicle ? `${vehicle.registration_number} status` : 'Status'}
      description="Whether it can be dispatched now, and why not."
      footer={
        // Wraps on a phone: Decommission takes its own row, under the main actions.
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {onDecommission && view?.status !== 'retired' && (
            <Button
              variant="ghost"
              leadingIcon={<Archive className="h-4 w-4" />}
              className="order-last w-full !text-danger hover:!bg-danger-soft hover:!text-danger sm:order-none sm:mr-auto sm:w-auto"
              onClick={onDecommission}
            >
              Decommission vehicle
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {editable && (
            <Button type="submit" form={formId} loading={change.isPending} disabled={target === null}>
              Change status
            </Button>
          )}
        </div>
      }
    >
      {status.isError ? (
        <Callout tone="danger" icon={<AlertCircle />}>
          {status.error instanceof ApiError && status.error.code === 'NOT_FOUND' ? MESSAGES.NOT_FOUND : 'The status could not be loaded. Close the panel and try again.'}
        </Callout>
      ) : !view ? (
        <StatusSkeleton />
      ) : (
        <div className="space-y-6">
          <AvailabilitySummary view={view} />

          {affected.length > 0 && (
            <Callout tone="warning" icon={<AlertTriangle />} title="Assigned trips need another vehicle">
              <ul className="mt-1 space-y-0.5">
                {affected.map((w) => (
                  <li key={w.trip_id}>
                    Trip <span className="font-mono text-xs">{shortId(w.trip_id)}</span>, starting {formatWhen(w.start)}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          <Section title="Trips">
            <dl className="divide-y divide-line rounded-control border border-line">
              <AssignmentRow label="Now" assignment={view.current_assignment} empty="Not on a trip" />
              <AssignmentRow label="Next" assignment={view.next_assignment} empty="Nothing assigned" />
            </dl>
          </Section>

          <Section title="Maintenance">
            <div className="flex items-start gap-3 rounded-control border border-line px-3.5 py-3">
              <Wrench className={cn('mt-0.5 h-4 w-4 shrink-0', view.maintenance.flagged ? 'text-warning' : 'text-ink-subtle')} aria-hidden="true" />
              <p className="text-sm text-ink">
                {view.maintenance.flagged ? (
                  <>
                    Flagged: work is open
                    {view.maintenance.open_record_id && (
                      <>
                        {' '}
                        (work order <span className="font-mono text-xs">{shortId(view.maintenance.open_record_id)}</span>)
                      </>
                    )}
                    .
                  </>
                ) : (
                  'No open work.'
                )}
                <span className="mt-0.5 block text-xs text-ink-muted">Work in progress puts the vehicle in the workshop; when the last of it ends, the vehicle is back in service.</span>
              </p>
            </div>
          </Section>

          <Section title="Last change">
            <LastChange view={view} />
          </Section>

          {editable && (
            <form id={formId} onSubmit={onSubmit} noValidate>
              <Section title="Change status">
                <div role="alert" className="empty:hidden">
                  {formError && (
                    <Callout tone="danger" icon={<AlertCircle />}>
                      {formError}
                    </Callout>
                  )}
                </div>
                <fieldset>
                  <legend className="sr-only">New status</legend>
                  <div className="grid gap-2">
                    {SETTABLE_STATUSES.map((s) => (
                      <StatusOption key={s} status={s} current={view.status === s} checked={target === s} onChange={() => setTarget(s)} />
                    ))}
                  </div>
                </fieldset>
                <TextAreaField
                  label="Reason"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value)
                    setReasonError(null)
                  }}
                  error={reasonError}
                  hint="Kept in the vehicle's status history and audit log."
                  maxLength={REASON_MAX}
                  rows={3}
                  className="pt-2"
                />
              </Section>
            </form>
          )}
        </div>
      )}
    </Drawer>
  )
}

const AVAILABILITY_LOOK: Record<Availability, { label: string; icon: ReactNode; classes: string }> = {
  available: { label: 'Available', icon: <CheckCircle2 />, classes: 'border-success/25 bg-success-soft text-success' },
  available_with_warning: { label: 'Available, with a warning', icon: <AlertTriangle />, classes: 'border-warning/30 bg-warning-soft text-warning' },
  unavailable: { label: 'Not available', icon: <XCircle />, classes: 'border-danger/25 bg-danger-soft text-danger' },
}

function AvailabilitySummary({ view }: { view: VehicleStatusView }) {
  const look = AVAILABILITY_LOOK[view.availability.availability]
  return (
    <div className={cn('rounded-card border p-4', look.classes)}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold [&_svg]:h-4 [&_svg]:w-4" aria-live="polite">
          {look.icon}
          {look.label} now
        </p>
        <StatusBadge status={view.status} />
      </div>
      {view.availability.reasons.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm text-ink">
          {view.availability.reasons.map((r, i) => (
            <li key={`${r.code}-${r.trip_id ?? i}`} className="flex items-start gap-2">
              <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', r.severity === 'block' ? 'bg-danger' : 'bg-warning')} aria-hidden="true" />
              <span>
                {AVAILABILITY_REASONS[r.code] ?? r.code}
                {r.trip_id && (
                  <span className="text-ink-muted">
                    {' '}
                    · trip <span className="font-mono text-xs">{shortId(r.trip_id)}</span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AssignmentRow({ label, assignment, empty }: { label: string; assignment: VehicleAssignment | null; empty: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3.5 py-2.5 text-sm">
      <dt className="w-12 shrink-0 text-ink-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-ink">
        {assignment ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <StatusBadge status={assignment.status} />
            <span>
              {formatWhen(assignment.start)} – {formatWhen(assignment.end)}
            </span>
            <span className="font-mono text-xs text-ink-muted">{shortId(assignment.trip_id)}</span>
          </span>
        ) : (
          <span className="text-ink-muted">{empty}</span>
        )}
      </dd>
    </div>
  )
}

function LastChange({ view }: { view: VehicleStatusView }) {
  const last = view.last_status_change
  if (!last) return <p className="text-sm text-ink-muted">No status change recorded yet.</p>
  return (
    <div className="rounded-control border border-line px-3.5 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2 text-ink">
        <StatusBadge status={last.from_status} />
        <span className="text-ink-subtle">
          <span aria-hidden="true">→</span>
          <span className="sr-only">to</span>
        </span>
        <StatusBadge status={last.to_status} />
      </p>
      {last.reason && <p className="mt-2 text-ink">“{last.reason}”</p>}
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-muted">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
        {formatWhen(last.changed_at)} · {last.source === 'maintenance' ? 'by maintenance work' : 'set by hand'}
      </p>
    </div>
  )
}

function StatusOption({ status, current, checked, onChange }: { status: VehicleStatus; current: boolean; checked: boolean; onChange: () => void }) {
  const meaning = STATUS_MEANING[status]
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-control border px-3.5 py-3 transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface',
        current ? 'border-line bg-surface-sunken' : checked ? 'cursor-pointer border-brand bg-brand-soft' : 'cursor-pointer border-line hover:border-line-strong hover:bg-surface-muted',
      )}
    >
      <input type="radio" name="vehicle-status" className="mt-0.5 h-4 w-4 accent-[rgb(var(--c-brand))]" checked={checked} disabled={current} onChange={onChange} />
      <span className="min-w-0">
        <span className={cn('flex items-center gap-2 text-sm font-medium', current ? 'text-ink-muted' : 'text-ink')}>
          {meaning.label}
          {current && <span className="text-xs font-normal">· current</span>}
        </span>
        <span className="block text-xs text-ink-muted">{meaning.description}</span>
      </span>
    </label>
  )
}

function Callout({ tone, icon, title, children }: { tone: 'danger' | 'warning'; icon: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex animate-fade-in items-start gap-2.5 rounded-control border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0',
        tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : 'border-warning/30 bg-warning-soft text-warning',
      )}
    >
      {icon}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {children}
    </section>
  )
}

function StatusSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-24 w-full rounded-card" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  )
}
