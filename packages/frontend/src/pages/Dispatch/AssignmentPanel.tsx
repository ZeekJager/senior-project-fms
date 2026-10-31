import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, Clock, Navigation, Truck, UserRound, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, Card, cn } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useTrip } from './api'
import { formatDay, formatTime, formatWindow, reasonText, tripEnds, tripTitle, VEHICLE_TYPE_LABELS } from './format'
import type { AssignmentWarning, BoardDriver, BoardVehicle, OpenWork, Trip } from './types'

interface AssignmentPanelProps {
  trip: Trip
  driver: BoardDriver | null
  vehicle: BoardVehicle | null
  busy: boolean
  /** The last refusal from POST /assign, shown here until the selection changes. */
  error: unknown
  /** Warnings from the last successful assignment. */
  warnings: AssignmentWarning[] | null
  onAssign: () => void
  /** Given when the user may move the trip's times (trip:write, FMS-139). */
  onChangeTimes?: () => void
}

/**
 * The assignment panel: the trip, the chosen driver and vehicle, and the
 * API's answer. Refusals (BR-1, BR-2, BR-3, eligibility) stay here, inline,
 * with what they are about: never a toast that disappears (FMS-33).
 */
export function AssignmentPanel({ trip, driver, vehicle, busy, error, warnings, onAssign, onChangeTimes }: AssignmentPanelProps) {
  const sameAsNow = trip.status === 'assigned' && driver?.driver_id === trip.driver_id && vehicle?.vehicle_id === trip.vehicle_id
  const licenceGap = driver && vehicle && !driver.vehicle_types.includes(vehicle.vehicle_type)
  return (
    <Card className="p-5" role="region" aria-label="Assignment panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{trip.status === 'assigned' ? 'Re-assign trip' : 'Assign trip'}</p>
          <h2 className="mt-1 truncate text-base font-semibold text-ink">{tripTitle(trip)}</h2>
          {trip.route_name && tripEnds(trip) && <p className="truncate text-sm text-ink-muted">{tripEnds(trip)}</p>}
        </div>
        <TripWindow trip={trip} onChangeTimes={onChangeTimes} />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Slot icon={<UserRound />} label="Driver" value={driver?.full_name} hint={driver ? (driver.license_categories.length ? `Licence ${driver.license_categories.join(', ')}` : 'No licence class on file') : 'Choose from the list'} />
        <Slot
          icon={<Truck />}
          label="Vehicle"
          value={vehicle?.registration_number}
          hint={vehicle ? `${VEHICLE_TYPE_LABELS[vehicle.vehicle_type] ?? vehicle.vehicle_type} · ${vehicle.make} ${vehicle.model}` : 'Choose from the list'}
        />
      </div>

      <div className="mt-4 space-y-2" role="alert">
        {error != null && <Refusal error={error} vehicle={vehicle} />}
      </div>
      <div className="space-y-2">
        {error == null && vehicle?.open_work && <WorkOrder work={vehicle.open_work} />}
        {error == null && licenceGap && (
          <Note tone="warning" icon={<AlertTriangle />}>
            {driver.full_name}’s licence ({driver.license_categories.join(', ') || 'none'}) does not cover a {(VEHICLE_TYPE_LABELS[vehicle.vehicle_type] ?? vehicle.vehicle_type).toLowerCase()}.
          </Note>
        )}
        {error == null && driver?.state === 'absent' && (
          <Note tone="warning" icon={<AlertTriangle />}>
            {driver.full_name} is marked {driver.attendance === 'on_leave' ? 'on leave' : (driver.attendance ?? 'absent')} today. You can still assign them.
          </Note>
        )}
        {warnings && (
          <Note tone="success" icon={<CheckCircle2 />} title="Assigned">
            {warnings.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i}>{warningText(w, driver)}</li>
                ))}
              </ul>
            )}
          </Note>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={onAssign} loading={busy} disabled={!driver || !vehicle || sameAsNow}>
          {trip.status === 'assigned' ? 'Re-assign' : 'Assign'}
        </Button>
      </div>
    </Card>
  )
}

/** The trip's window, and the way to move it. */
function TripWindow({ trip, onChangeTimes, label = 'Change times' }: { trip: Trip; onChangeTimes?: () => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1 text-xs font-medium text-ink">
        <CalendarClock className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" />
        {formatWindow(trip.scheduled_start, trip.scheduled_end)}
      </p>
      {onChangeTimes && (
        <Button variant="secondary" size="sm" leadingIcon={<Clock className="h-4 w-4" />} onClick={onChangeTimes}>
          {label}
        </Button>
      )}
    </div>
  )
}

interface UnderWayPanelProps {
  trip: Trip
  driverName: string | undefined
  plate: string | undefined
  onChangeTimes?: () => void
}

/** A trip under way: who is on it and since when. Only its end can move (FMS-139). */
export function UnderWayPanel({ trip, driverName, plate, onChangeTimes }: UnderWayPanelProps) {
  return (
    <Card className="p-5" role="region" aria-label="Trip under way">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            Under way
          </p>
          <h2 className="mt-1 truncate text-base font-semibold text-ink">{tripTitle(trip)}</h2>
          {trip.route_name && tripEnds(trip) && <p className="truncate text-sm text-ink-muted">{tripEnds(trip)}</p>}
        </div>
        <TripWindow trip={trip} onChangeTimes={onChangeTimes} label="Change end" />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Slot icon={<UserRound />} label="Driver" value={driverName} hint={trip.actual_start ? `Started ${formatDay(trip.actual_start)} at ${formatTime(trip.actual_start)}` : 'Started'} />
        <Slot icon={<Truck />} label="Vehicle" value={plate} hint="On this trip until it ends" />
      </div>
      <p className="mt-4 text-sm text-ink-muted">Running late or finishing early? Move its end: the driver’s app shows it at once, and their next trip can move with it.</p>
    </Card>
  )
}

function warningText(w: AssignmentWarning, driver: BoardDriver | null): string {
  if (w.warning === 'DRIVER_ATTENDANCE') return `${driver?.full_name ?? 'The driver'} is marked ${w.attendance === 'on_leave' ? 'on leave' : w.attendance} that day.`
  return `The ${w.field === 'driver_id' ? 'driver' : 'vehicle'} is still on a trip expected to end ${formatDay(w.expected_end)} at ${formatTime(w.expected_end)}.`
}

function Slot({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string | undefined; hint: string }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-control border px-3 py-2.5', value ? 'border-line bg-surface' : 'border-dashed border-line-strong bg-surface-muted')}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-ink-subtle [&_svg]:h-4 [&_svg]:w-4" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-ink-subtle">{label}</span>
        <span className={cn('block truncate text-sm font-medium', value ? 'text-ink' : 'text-ink-muted')}>{value ?? 'Not chosen'}</span>
        <span className="block truncate text-xs text-ink-muted">{hint}</span>
      </span>
    </div>
  )
}

export function Note({ tone, icon, title, children }: { tone: 'danger' | 'warning' | 'success'; icon: ReactNode; title?: string; children?: ReactNode }) {
  const tones = {
    danger: 'border-danger/25 bg-danger-soft text-danger',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    success: 'border-success/25 bg-success-soft text-success',
  }
  return (
    <div className={cn('flex animate-fade-in items-start gap-2.5 rounded-control border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0', tones[tone])}>
      {icon}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  )
}

function WorkOrder({ work }: { work: OpenWork }) {
  return (
    <Note tone="danger" icon={<Wrench />} title="Open maintenance work">
      <p className="text-ink">{work.description}</p>
      <p className="mt-0.5 text-xs">
        {work.priority} priority · {work.status.replace('_', ' ')} · opened {formatDay(work.opened_at)} · work order <span className="font-mono">{work.id.slice(0, 8)}</span>
      </p>
    </Note>
  )
}

/** The trip a conflict names: route, ends and time, read with trip:read. */
export function ConflictingTrip({ id }: { id: string }) {
  const trip = useTrip(id)
  if (!trip.data) return <p className="mt-1 text-xs">Trip <span className="font-mono">{id.slice(0, 8)}</span></p>
  return (
    <p className="mt-1 text-ink">
      <span className="font-medium">{tripTitle(trip.data)}</span>
      {trip.data.route_name && tripEnds(trip.data) ? `, ${tripEnds(trip.data)}` : ''} · {formatWindow(trip.data.scheduled_start, trip.data.scheduled_end)}
    </p>
  )
}

const MESSAGES: Record<string, string> = {
  CONFLICT_DRIVER_OVERLAP: 'The driver is already on another trip at that time.',
  CONFLICT_VEHICLE_OVERLAP: 'The vehicle is already on another trip at that time.',
  CONFLICT_VEHICLE_FLAGGED: 'The vehicle is flagged for maintenance and cannot be dispatched.',
  CONFLICT_DRIVER_NOT_ELIGIBLE: 'The driver cannot drive this trip.',
  CONFLICT_DEPOT_MISMATCH: 'That driver or vehicle belongs to another depot.',
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone changed this trip a moment ago. The list has been refreshed: check it and assign again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This trip can no longer be assigned: it may have started or been cancelled.',
  VALIDATION_FAILED: 'That driver or vehicle is no longer in your depots.',
}

function Refusal({ error, vehicle }: { error: unknown; vehicle: BoardVehicle | null }) {
  if (!(error instanceof ApiError)) {
    return (
      <Note tone="danger" icon={<AlertCircle />}>
        Could not reach the server. Try again.
      </Note>
    )
  }
  const conflict = error.details.find((d) => d.record_id)?.record_id
  return (
    <Note tone="danger" icon={<AlertCircle />} title={MESSAGES[error.code] ?? `The trip could not be assigned (${error.code}).`}>
      {(error.code === 'CONFLICT_DRIVER_OVERLAP' || error.code === 'CONFLICT_VEHICLE_OVERLAP') && conflict && <ConflictingTrip id={conflict} />}
      {error.code === 'CONFLICT_VEHICLE_FLAGGED' && vehicle?.open_work && (
        <p className="mt-1 text-ink">
          {vehicle.open_work.description} <span className="text-xs">(work order <span className="font-mono">{vehicle.open_work.id.slice(0, 8)}</span>)</span>
        </p>
      )}
      {error.code === 'CONFLICT_DRIVER_NOT_ELIGIBLE' && (
        <ul className="mt-1 list-disc pl-4 text-ink">
          {error.details.map((d, i) => (
            <li key={i}>{reasonText(d.reason ?? '')}</li>
          ))}
        </ul>
      )}
    </Note>
  )
}
