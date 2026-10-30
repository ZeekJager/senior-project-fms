import { ArrowRight, CalendarClock, Truck, UserRound } from 'lucide-react'
import { StatusBadge } from '@/components/shared'
import { cn, Skeleton } from '@/components/ui'
import { formatWindow, tripEnds, tripTitle } from './format'
import type { Trip } from './types'

interface TripListProps {
  trips: Trip[]
  isLoading: boolean
  selectedId: string | null
  onSelect: (trip: Trip) => void
  /** Names for assigned and under-way trips, from the board (same depot). */
  driverName: (id: string) => string | undefined
  plate: (id: string) => string | undefined
}

/** The left panel: the depot's trips, one selectable card each. */
export function TripList({ trips, isLoading, selectedId, onSelect, driverName, plate }: TripListProps) {
  if (isLoading) {
    return (
      <ul className="space-y-2" aria-busy="true" aria-label="Trips loading">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i}>
            <Skeleton className="h-[88px] w-full rounded-control" />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="space-y-2" aria-label="Trips">
      {trips.map((trip) => {
        const selected = trip.id === selectedId
        const ends = tripEnds(trip)
        return (
          <li key={trip.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(trip)}
              className={cn(
                'group w-full rounded-control border px-4 py-3 text-left transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                selected ? 'border-brand bg-brand-soft shadow-soft' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-muted',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-semibold text-ink">{tripTitle(trip)}</p>
                <StatusBadge status={trip.status} />
              </div>
              {ends && trip.route_name && (
                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-ink-muted">
                  {ends.split(' → ')[0]}
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="sr-only">to</span>
                  {ends.split(' → ')[1]}
                </p>
              )}
              <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-ink">
                <CalendarClock className="h-3.5 w-3.5 text-ink-subtle" aria-hidden="true" />
                {formatWindow(trip.scheduled_start, trip.scheduled_end)}
              </p>
              {(trip.status === 'assigned' || trip.status === 'en_route') && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                  <span className="inline-flex items-center gap-1">
                    <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                    {(trip.driver_id && driverName(trip.driver_id)) ?? 'Driver'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Truck className="h-3.5 w-3.5" aria-hidden="true" />
                    {(trip.vehicle_id && plate(trip.vehicle_id)) ?? 'Vehicle'}
                  </span>
                </p>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
