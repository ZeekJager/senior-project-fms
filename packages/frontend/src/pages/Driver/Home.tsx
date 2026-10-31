import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, Clock, LocateFixed, MapPin, MapPinOff, Navigation, ScanLine, Truck, WifiOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton, cn } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import type { GpsState } from '@/features/phoneGps/broadcaster'
import { usePhoneGps } from '@/features/phoneGps/PhoneGps'
import { ApiError } from '@/lib/api/errors'
import { useConnectivity } from '@/pwa/useConnectivity'
import { clockTime } from '@/pages/Attendance/api'
import { useMyAttendance, useTodayTrips, useTripCommand, useTripVehicle, type DriverTrip, type TripWarning } from './api'
import { readPostTrip, writePostTrip, type PostTrip } from './checklist'
import { Note, Panel } from './parts'

// Addis Ababa, 24-hour clock: what the driver's watch says.
const TZ = 'Africa/Addis_Ababa'
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const time = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '--:--')

/** The trip whose post-trip inspection is still to do, kept across reloads until done or put off. */
function usePostTrip(userId: string): [PostTrip | null, (postTrip: PostTrip | null) => void] {
  const [postTrip, setPostTrip] = useState<PostTrip | null>(() => readPostTrip(userId))
  const set = (next: PostTrip | null) => {
    setPostTrip(next)
    writePostTrip(next)
  }
  return [postTrip, set]
}

const REFUSALS: Record<string, string> = {
  CONFLICT_VEHICLE_FLAGGED: 'This vehicle is flagged for maintenance. Do not drive it: call dispatch.',
  CONFLICT_DRIVER_NOT_ELIGIBLE: 'You cannot drive this trip right now. Call dispatch.',
  CONFLICT_DEPOT_MISMATCH: 'This vehicle belongs to another depot. Call dispatch.',
  CONFLICT_INVALID_STATE_TRANSITION: 'Dispatch changed this trip. Your day has been refreshed.',
  CONFLICT_CONCURRENT_MODIFICATION: 'Dispatch changed this trip. Your day has been refreshed.',
}

const REASONS: Record<string, string> = {
  license_expired: 'your licence has expired',
  account_not_active: 'your account is not active',
  driver_retired: 'you are no longer listed as a driver',
  license_category_not_valid_for_vehicle: 'your licence does not cover this vehicle',
  license_category_missing: 'no licence class is on file',
}

function refusalText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'No connection. Try again when you have signal.'
  const reasons = err.code === 'CONFLICT_DRIVER_NOT_ELIGIBLE' ? err.details.map((d) => REASONS[d.reason ?? ''] ?? d.reason).filter(Boolean) : []
  if (reasons.length > 0) return `You cannot drive this trip: ${reasons.join(', ')}. Call dispatch.`
  return REFUSALS[err.code] ?? `The trip could not be updated (${err.code}).`
}

function warningText(w: TripWarning): string {
  if (w.warning === 'DRIVER_ATTENDANCE') return `You are marked ${w.attendance === 'on_leave' ? 'on leave' : w.attendance} today. Tell dispatch if that is wrong.`
  return `Your ${w.field === 'driver_id' ? 'previous trip' : "vehicle's previous trip"} is still open. End it when you can.`
}

/**
 * Driver Home (FMS-35, S-11): today's trip in large type, and one tap to
 * start or end it. Ending leads to the post-trip inspection (FMS-37). Today
 * only: no past trips. With no signal it shows the day as last saved on
 * this phone.
 */
export function DriverHome() {
  const { session, api, hasPermission } = useAuth()
  const online = useConnectivity(api)
  const today = useTodayTrips()
  const start = useTripCommand('start')
  const end = useTripCommand('end')
  const [warnings, setWarnings] = useState<TripWarning[]>([])
  const [postTrip, setPostTrip] = usePostTrip(session?.user.id ?? '')

  const trips = today.data ?? []
  const current = trips.find((t) => t.status === 'en_route') ?? trips[0] ?? null
  const later = trips.filter((t) => t !== current && t.status === 'assigned')
  const firstName = session?.user.full_name.split(' ')[0] ?? ''
  const showingSaved = today.isError || (!online && today.data !== undefined)
  const busy = start.isPending || end.isPending
  const error = start.error ?? end.error

  async function act(trip: DriverTrip) {
    setWarnings([])
    start.reset()
    end.reset()
    try {
      if (trip.status === 'assigned') {
        setWarnings((await start.mutateAsync(trip)).warnings)
      } else {
        await end.mutateAsync(trip)
        setPostTrip({ userId: session?.user.id ?? '', tripId: trip.id, vehicleId: trip.vehicle_id, routeName: trip.route_name })
      }
    } catch {
      // Shown under the button.
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm font-medium text-ink-muted">{dayFmt.format(new Date())}</p>
        <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink">My day</h1>
        {firstName && <p className="mt-0.5 text-base text-ink-muted">Hello, {firstName}.</p>}
      </header>

      {showingSaved && today.dataUpdatedAt > 0 && (
        <p className="flex items-center gap-2 rounded-control bg-surface-sunken px-3.5 py-2.5 text-sm text-ink-muted">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          Saved on this phone at {timeFmt.format(new Date(today.dataUpdatedAt))}. It updates when you have signal.
        </p>
      )}

      {hasPermission('attendance:check-in') && <CheckInStrip />}

      {postTrip && <PostTripPrompt tripId={postTrip.tripId} onLater={() => setPostTrip(null)} />}

      {today.isPending && today.fetchStatus === 'paused' ? (
        <Panel icon={<WifiOff />} title="No signal" tone="neutral">
          Your day shows here as soon as the phone reaches the server. After that it stays on this phone.
        </Panel>
      ) : today.isPending ? (
        <Skeleton className="h-80 w-full rounded-card" />
      ) : today.isError && today.data === undefined ? (
        <Panel icon={<AlertCircle />} title="Your day could not be loaded" tone="danger">
          Check your signal. It tries again every minute.
        </Panel>
      ) : current ? (
        <TripCard trip={current}>
          {current.status === 'assigned' && current.vehicle_id && (
            <Link
              to={`/driver/dvir?trip=${current.id}&type=pre_trip`}
              className="focus-ring flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface text-base font-semibold text-ink shadow-soft hover:bg-surface-muted"
            >
              <ClipboardCheck className="h-5 w-5 text-brand-ink" aria-hidden="true" />
              Pre-trip inspection
            </Link>
          )}
          <ActionButton trip={current} busy={busy} online={online} onPress={() => void act(current)} />
          <div role="alert" className="empty:hidden">
            {error != null && (
              <Note tone="danger" icon={<AlertCircle />}>
                {refusalText(error)}
              </Note>
            )}
          </div>
          {warnings.map((w, i) => (
            <Note key={i} tone="warning" icon={<AlertTriangle />}>
              {warningText(w)}
            </Note>
          ))}
        </TripCard>
      ) : (
        !postTrip && (
          <Panel icon={<CheckCircle2 />} title="No trip assigned for today" tone="neutral">
            Dispatch will assign your next trip. This screen updates on its own.
          </Panel>
        )
      )}

      {later.length > 0 && (
        <section aria-labelledby="later-today">
          <h2 id="later-today" className="mb-2 text-sm font-semibold uppercase tracking-wider text-ink-subtle">
            Later today
          </h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {later.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-base font-medium text-ink">{t.route_name ?? `${t.origin ?? ''} → ${t.destination ?? ''}`}</span>
                  <span className="block truncate text-sm text-ink-muted">
                    {t.origin ?? 'Origin'} → {t.destination ?? 'Destination'}
                  </span>
                </span>
                <span className="shrink-0 text-base font-semibold tabular-nums text-ink">{time(t.scheduled_start)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function TripCard({ trip, children }: { trip: DriverTrip; children: ReactNode }) {
  const vehicle = useTripVehicle(trip.vehicle_id)
  const underWay = trip.status === 'en_route'
  return (
    <article aria-label="Your trip" className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <div className={cn('px-5 pb-5 pt-4', underWay ? 'bg-success-soft' : 'bg-brand-soft')}>
        <p className={cn('flex items-center gap-2 text-sm font-semibold uppercase tracking-wider', underWay ? 'text-success' : 'text-brand-ink')}>
          <span className={cn('h-2 w-2 rounded-full', underWay ? 'animate-pulse bg-success' : 'bg-brand')} aria-hidden="true" />
          {underWay ? 'On the road' : 'Your next trip'}
        </p>
        <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-ink">
          {time(trip.scheduled_start)}
          <span className="px-2 text-ink-subtle">–</span>
          {time(trip.scheduled_end)}
        </p>
        {underWay && trip.actual_start && <p className="mt-1 text-sm text-ink-muted">Started at {time(trip.actual_start)}</p>}
        {underWay && <LocationLine />}
      </div>

      <div className="space-y-5 px-5 py-5">
        <div>
          <h2 className="text-xl font-semibold leading-snug text-ink">{trip.route_name ?? 'Trip'}</h2>
          <ol className="mt-3 space-y-3" aria-label="Route">
            <li className="flex items-start gap-3">
              <Navigation className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">From</span>
                <span className="block break-words text-lg font-medium text-ink">{trip.origin ?? 'Not set'}</span>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">To</span>
                <span className="block break-words text-lg font-medium text-ink">{trip.destination ?? 'Not set'}</span>
              </span>
            </li>
          </ol>
        </div>

        <div className="flex items-center gap-3 rounded-control border border-line px-4 py-3">
          <Truck className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">Vehicle</span>
            <span className="block truncate text-lg font-semibold tracking-wide text-ink">{vehicle.data?.registration_number ?? (trip.vehicle_id ? 'Ask dispatch' : 'Not assigned')}</span>
            {vehicle.data && <span className="block truncate text-sm text-ink-muted">{`${vehicle.data.make} ${vehicle.data.model}`}</span>}
          </span>
        </div>

        {trip.stops.length > 0 && (
          <details className="group rounded-control border border-line">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 py-3 text-base font-medium text-ink">
              {trip.stops.length} stop{trip.stops.length === 1 ? '' : 's'} on the way
              <span className="text-sm text-ink-subtle group-open:hidden">Show</span>
              <span className="hidden text-sm text-ink-subtle group-open:inline">Hide</span>
            </summary>
            <ol className="space-y-2 border-t border-line px-4 py-3">
              {[...trip.stops]
                .sort((a, b) => a.sequence_number - b.sequence_number)
                .map((s) => (
                  <li key={s.id} className="flex items-baseline gap-3 text-base text-ink">
                    <span className="w-5 shrink-0 text-right text-sm tabular-nums text-ink-subtle">{s.sequence_number}</span>
                    <span className="min-w-0 break-words">{s.name}</span>
                  </li>
                ))}
            </ol>
          </details>
        )}

        <div className="space-y-3">{children}</div>
      </div>
    </article>
  )
}

/** One large button: START TRIP, then END TRIP. Needs a connection: the server records the time. */
function ActionButton({ trip, busy, online, onPress }: { trip: DriverTrip; busy: boolean; online: boolean; onPress: () => void }) {
  const starting = trip.status === 'assigned'
  return (
    <div>
      <button
        type="button"
        onClick={onPress}
        disabled={busy || !online}
        aria-busy={busy}
        className={cn(
          'focus-ring flex h-16 w-full items-center justify-center rounded-2xl text-lg font-bold uppercase tracking-wider text-white shadow-soft transition active:scale-[0.99]',
          'disabled:cursor-not-allowed disabled:opacity-60',
          starting ? 'bg-success-solid hover:brightness-110' : 'bg-danger-solid hover:brightness-110',
        )}
      >
        {busy ? (starting ? 'Starting…' : 'Ending…') : starting ? 'Start trip' : 'End trip'}
      </button>
      {!online && <p className="mt-2 text-center text-sm text-ink-muted">Needs signal: the time is recorded by the server.</p>}
    </div>
  )
}

/** Whether the driver has checked in at the depot today (FMS-141), and the way to do it. */
function CheckInStrip() {
  const mine = useMyAttendance()
  const record = mine.data ?? null
  const text = record?.check_out_at
    ? `Checked out at ${clockTime(record.check_out_at)}`
    : record?.check_in_at
      ? `Checked in at ${clockTime(record.check_in_at)}${record.status === 'late' ? ' · late' : ''}`
      : 'Not checked in yet'
  return (
    <Link
      to="/driver/check-in"
      className="focus-ring flex min-h-14 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card hover:bg-surface-muted"
    >
      <ScanLine className="h-6 w-6 shrink-0 text-brand-ink" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-ink">{record?.check_in_at && !record.check_out_at ? 'Check out' : 'Check in'}</span>
        <span className="block truncate text-sm text-ink-muted">{mine.isPending ? 'Checking…' : text}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
    </Link>
  )
}

function PostTripPrompt({ tripId, onLater }: { tripId: string; onLater: () => void }) {
  return (
    <section aria-label="Post-trip inspection" className="rounded-card border border-brand/30 bg-brand-soft p-5">
      <div className="flex items-start gap-3">
        <ClipboardCheck className="mt-0.5 h-6 w-6 shrink-0 text-brand-ink" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">Trip ended. Inspect the vehicle</h2>
          <p className="mt-1 text-base text-ink-muted">Do the post-trip check before you leave it: tyres, lights, brakes and anything that went wrong on the road.</p>
        </div>
      </div>
      <Link
        to={`/driver/dvir?trip=${tripId}&type=post_trip`}
        className="focus-ring mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-brand text-lg font-semibold text-white shadow-soft hover:bg-brand-strong"
      >
        Start post-trip inspection
      </Link>
      <button type="button" onClick={onLater} className="focus-ring mt-2 flex h-12 w-full items-center justify-center rounded-2xl text-base font-medium text-ink-muted hover:bg-surface">
        Later
      </button>
    </section>
  )
}

const LOCATION_TEXT: Record<Exclude<GpsState, 'off'>, string> = {
  starting: 'Finding your position…',
  on: 'Sharing your location with dispatch',
  weak: 'GPS signal is weak: your position is not precise enough to share yet',
  denied: 'Location is blocked: dispatch cannot see your vehicle',
  unavailable: 'No location on this phone: dispatch cannot see your vehicle',
}

/** Whether the phone is the vehicle's GPS right now (FMS-57), and what waits to be sent. */
function LocationLine() {
  const { status } = usePhoneGps()
  if (status.state === 'off') return null
  const good = status.state === 'on'
  const bad = status.state === 'denied' || status.state === 'unavailable'
  return (
    <p aria-live="polite" className={cn('mt-3 flex items-center gap-2 text-sm font-medium', good ? 'text-success' : bad ? 'text-danger' : 'text-warning')}>
      {bad ? <MapPinOff className="h-4 w-4 shrink-0" aria-hidden="true" /> : <LocateFixed className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span>
        {LOCATION_TEXT[status.state]}
        {good && status.waiting > 1 && <span className="font-normal text-ink-muted">{` · ${status.waiting} positions wait for signal`}</span>}
      </span>
    </p>
  )
}
