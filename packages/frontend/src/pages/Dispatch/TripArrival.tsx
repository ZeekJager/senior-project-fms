import { CheckCircle2, Clock, Flag, MapPin, SignalLow } from 'lucide-react'
import { useNow } from '@/components/FleetMap'
import { cn } from '@/components/ui'
import { etaClock, formatKm, isEtaStale, timeUntil } from '@/features/trip-eta'
import type { Trip, TripStop } from './types'

/** The clock the times are read against: "in 38 min" moves on without new data. */
const TICK_MS = 30_000

/**
 * When a trip under way reaches its stops and destination (FMS-86, docs/eta.md): from the vehicle's newest
 * position and the road ahead, worked out every 30 seconds while it reports. Stops reached say when.
 */
export function TripArrival({ trip }: { trip: Trip }) {
  const now = useNow(TICK_MS)
  const eta = trip.eta ?? null
  const stops = trip.stops ?? []
  const arrived = eta?.arrival_at && eta.remaining_km === 0
  const stale = eta !== null && isEtaStale(eta, now)

  return (
    <section aria-labelledby={`arrival-${trip.id}`} className="mt-4 rounded-control border border-line bg-surface-sunken/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`arrival-${trip.id}`} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Arrival
        </h3>
        {eta && <p className="text-xs text-ink-subtle">Worked out {etaClock(eta.updated_at)} from the vehicle’s position</p>}
      </div>

      {!eta ? (
        <p className="mt-2 text-sm text-ink-muted">No estimate yet. It appears once the vehicle reports its position and the road ahead is measured.</p>
      ) : eta.arrival_at ? (
        <p className="mt-2 text-sm text-ink">
          <span className="text-2xl font-semibold tracking-tight tabular">{etaClock(eta.arrival_at)}</span>{' '}
          <span className="text-ink-muted">
            {arrived
              ? `· arrived at ${trip.destination ?? 'the destination'}`
              : `at ${trip.destination ?? 'the destination'} · ${timeUntil(eta.arrival_at, now)}${eta.remaining_km !== null ? ` · ${formatKm(eta.remaining_km)} left` : ''}`}
          </span>
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">The route has no destination coordinates: only its stops are estimated.</p>
      )}

      {stale && eta?.position_at && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
          <SignalLow className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Last position at {etaClock(eta.position_at)}: the vehicle may have lost signal, so these times may be behind.
        </p>
      )}

      {stops.length > 0 && (
        <ol className="mt-3 space-y-1 border-t border-line pt-3" aria-label="Stops">
          {stops.map((s) => (
            <StopRow key={s.id} stop={s} showTimes={eta !== null} />
          ))}
          {trip.destination && (
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-ink">
                <Flag className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
                <span className="truncate">{trip.destination}</span>
              </span>
              <span className="tabular text-xs text-ink-muted">{eta?.arrival_at ? etaClock(eta.arrival_at) : '—'}</span>
            </li>
          )}
        </ol>
      )}
    </section>
  )
}

function StopRow({ stop, showTimes }: { stop: TripStop; showTimes: boolean }) {
  const reached = stop.actual_arrival !== null
  const when = reached ? `Reached ${etaClock(stop.actual_arrival!)}` : stop.eta ? etaClock(stop.eta) : null
  const why = stop.latitude === null ? 'No coordinates' : showTimes ? 'Passed' : '—'
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className={cn('flex min-w-0 items-center gap-2', reached ? 'text-ink-muted' : 'text-ink')}>
        {reached ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> : <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />}
        <span className="truncate">{stop.name}</span>
      </span>
      <span className={cn('tabular text-xs', reached ? 'text-success' : when ? 'font-medium text-ink' : 'text-ink-subtle')}>{when ?? why}</span>
    </li>
  )
}
