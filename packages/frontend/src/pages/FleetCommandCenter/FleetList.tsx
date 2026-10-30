import { Crosshair, Gauge, HeartPulse, MapPinOff, Route as RouteIcon, Search, UserRound } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { lastSeenLabel } from '@/components/FleetMap'
import { EmptyState } from '@/components/shared'
import { Badge, cn, Skeleton, type BadgeTone } from '@/components/ui'
import { routeLabel, type LiveState } from './liveFleet'
import type { VehicleLocation } from './types'

// The command center's list beside the map (FMS-45, S-16): one card per vehicle with its trip, speed,
// state and how long since it last reported, counting up.

const STATE_BADGE: Record<LiveState, { tone: BadgeTone; label: string }> = {
  moving: { tone: 'success', label: 'Moving' },
  stopped: { tone: 'neutral', label: 'Stopped' },
  idling: { tone: 'warning', label: 'Idling' },
  speeding: { tone: 'danger', label: 'Speeding' },
  breakdown: { tone: 'danger', label: 'Breakdown' },
  offline: { tone: 'danger', label: 'Offline' },
  no_signal: { tone: 'neutral', label: 'No signal yet' },
}

export function LiveBadge({ state }: { state: LiveState }) {
  const { tone, label } = STATE_BADGE[state]
  const loud = state === 'speeding' || state === 'offline'
  return (
    <Badge tone={tone} dot={!loud} icon={state === 'speeding' ? <Gauge aria-hidden="true" /> : undefined} className={cn(loud && 'font-semibold uppercase tracking-wide')}>
      {label}
    </Badge>
  )
}

interface VehicleCardProps {
  vehicle: VehicleLocation
  state: LiveState
  /** "12 s ago", worked out by the list on its own clock. */
  seen: string
  selected: boolean
  onSelect: (vehicleId: string) => void
  /** Focus the map on the card's driver (FMS-140); offered when the vehicle is on a trip with one. */
  onFocusDriver?: (driverId: string) => void
  /** Its health score when at risk or to watch (FMS-89); nothing for a healthy or unscored vehicle. */
  health?: { score: number; band: 'at_risk' | 'watch' }
}

const VehicleCard = memo(function VehicleCard({ vehicle, state, seen, selected, onSelect, onFocusDriver, health }: VehicleCardProps) {
  const ref = useRef<HTMLButtonElement>(null)
  // Chosen on the map: bring the card into view in the list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const route = routeLabel(vehicle.trip)
  const offline = state === 'offline'
  const driver = vehicle.trip?.driver ?? null
  return (
    <div
      className={cn(
        'overflow-hidden rounded-control border transition-[background-color,border-color,box-shadow] duration-150 ease-smooth',
        selected ? 'border-brand/50 bg-brand-soft/60 shadow-soft' : 'border-line bg-surface hover:border-line-strong',
      )}
    >
      <button
        ref={ref}
        type="button"
        aria-pressed={selected}
        data-vehicle={vehicle.vehicle_id}
        onClick={() => onSelect(vehicle.vehicle_id)}
        className={cn('focus-ring group block w-full rounded-control px-3.5 py-3 text-left transition-colors duration-150', !selected && 'hover:bg-surface-muted')}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="plate truncate text-sm text-ink">{vehicle.registration_number}</span>
            {health && (
              <Badge tone={health.band === 'at_risk' ? 'danger' : 'warning'} className="shrink-0" icon={<HeartPulse aria-hidden="true" />}>
                <span className="sr-only">{health.band === 'at_risk' ? 'Health at risk: ' : 'Health to watch: '}</span>
                <span className="tabular">{health.score}</span>
              </Badge>
            )}
          </span>
          <LiveBadge state={state} />
        </span>
        {vehicle.trip ? (
          <>
            <span className="mt-1.5 flex items-center gap-1.5 text-sm text-ink">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
              <span className="truncate">{vehicle.trip.driver?.full_name ?? 'No driver'}</span>
            </span>
            {route && (
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted">
                <RouteIcon className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
                <span className="truncate">{route}</span>
              </span>
            )}
          </>
        ) : (
          <span className="mt-1.5 block text-xs text-ink-subtle">No trip under way</span>
        )}
        <span className="mt-2.5 flex items-center justify-between gap-3 border-t border-line pt-2 text-xs">
          <span className="tabular font-medium text-ink">{vehicle.position ? `${vehicle.position.speed_kmh} km/h` : '—'}</span>
          <span className={cn('tabular', offline ? 'font-semibold text-danger' : 'text-ink-subtle')}>
            {vehicle.position ? `Last seen ${seen === 'Just now' ? 'just now' : seen}` : 'Not reported yet'}
          </span>
        </span>
      </button>
      {driver && onFocusDriver && (
        <button
          type="button"
          onClick={() => onFocusDriver(driver.driver_id)}
          aria-label={`Focus the map on ${driver.full_name ?? 'this driver'}`}
          className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-control border-t border-line px-3.5 py-1.5 text-xs font-medium text-brand-ink transition-colors duration-150 hover:bg-surface-muted coarse:min-h-11"
        >
          <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
          Focus on driver
        </button>
      )}
    </div>
  )
})

interface FleetListProps {
  vehicles: readonly VehicleLocation[]
  states: ReadonlyMap<string, LiveState>
  now: number
  selectedId: string | null
  onSelect: (vehicleId: string) => void
  onFocusDriver?: (driverId: string) => void
  /** Health scores of the vehicles at risk or to watch, by vehicle id (FMS-89). */
  health?: ReadonlyMap<string, { score: number; band: 'at_risk' | 'watch' }>
  isLoading: boolean
  search: string
  onSearch: (value: string) => void
  /** What the empty list says, for the view chosen. */
  empty: { heading: string; description: string }
}

export function FleetList({ vehicles, states, now, selectedId, onSelect, onFocusDriver, health, isLoading, search, onSearch, empty }: FleetListProps) {
  return (
    <>
      <div className="relative px-4 pb-3">
        <Search className="pointer-events-none absolute left-7 top-[18px] h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
        <input
          type="search"
          aria-label="Find a vehicle, driver or route"
          placeholder="Find a plate, driver or route"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="focus-ring h-9 w-full rounded-control border border-line-strong bg-surface-muted pl-10 pr-3 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand coarse:h-11"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3 py-3">
        {isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[104px] w-full" />
            ))}
          </div>
        ) : vehicles.length === 0 ? (
          <EmptyState icon={<MapPinOff />} heading={empty.heading} description={empty.description} headingLevel="h3" />
        ) : (
          <ul className="space-y-2" aria-label="Vehicles">
            {vehicles.map((v) => (
              <li key={v.vehicle_id}>
                <VehicleCard
                  vehicle={v}
                  state={states.get(v.vehicle_id) ?? 'no_signal'}
                  seen={v.position ? lastSeenLabel(v.position.recorded_at, now) : ''}
                  selected={v.vehicle_id === selectedId}
                  onSelect={onSelect}
                  onFocusDriver={onFocusDriver}
                  health={health?.get(v.vehicle_id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
