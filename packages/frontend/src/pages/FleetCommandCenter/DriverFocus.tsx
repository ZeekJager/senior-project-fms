import L from 'leaflet'
import { Crosshair, History, UserRoundX, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Polyline, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import { lastSeenLabel, type FleetMapVehicle } from '@/components/FleetMap'
import { EmptyState } from '@/components/shared'
import type { LatLng } from '@/components/TripMap'
import { Button, Skeleton } from '@/components/ui'
import { formatDay, formatTime } from '@/pages/Dispatch/format'
import { LiveBadge } from './FleetList'
import { routeLabel, type LiveState } from './liveFleet'
import type { VehicleLocation } from './types'

// One driver in focus on the live map (FMS-140, docs/live-map.md): the layers drawn on the map, and the
// panel that takes the list's place beside it.

/** Closer than this, a focus on one vehicle frames it at this zoom. */
const FOCUS_ZOOM = 15

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

interface FocusLayersProps {
  /** Changes when the focus moves to another driver: the view is framed again. */
  focusKey: string
  vehicle: FleetMapVehicle | null
  planned: readonly LatLng[]
  track: readonly LatLng[]
}

/**
 * Inside the map: the trip's planned route (dashed) and the track today (solid). The view is framed on
 * them when the focus begins and again when the route and the track arrive; after that it follows the
 * vehicle, panning when it nears the edge, so the dispatcher can still zoom in or out.
 */
export function FocusLayers({ focusKey, vehicle, planned, track }: FocusLayersProps) {
  const map = useMap()
  const frame = `${focusKey}|${vehicle !== null}|${planned.length > 1}|${track.length > 1}`
  const points = useRef<LatLng[]>([])
  points.current = [...planned, ...track, ...(vehicle ? [[vehicle.lat, vehicle.lng] as LatLng] : [])]
  useEffect(() => {
    const all = points.current
    if (all.length === 0) return
    const animate = !reducedMotion()
    if (all.length === 1) map.setView(all[0], Math.max(map.getZoom(), FOCUS_ZOOM), { animate })
    else map.fitBounds(L.latLngBounds(all), { padding: [48, 48], maxZoom: FOCUS_ZOOM, animate })
  }, [map, frame])

  // Follow: only when the vehicle moves within the same focus (the framing above already shows it).
  const lat = vehicle?.lat
  const lng = vehicle?.lng
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (lat === undefined || lng === undefined) return
    const previous = last.current
    last.current = `${focusKey}:${lat},${lng}`
    if (!previous?.startsWith(`${focusKey}:`)) return
    const at = L.latLng(lat, lng)
    if (!map.getBounds().pad(-0.2).contains(at)) map.panTo(at, { animate: !reducedMotion() })
  }, [map, focusKey, lat, lng])

  return (
    <>
      {planned.length > 1 && <Polyline positions={[...planned]} pathOptions={{ className: 'fleet-focus-planned', weight: 2 }} interactive={false} />}
      {track.length > 1 && <Polyline positions={[...track]} pathOptions={{ className: 'fleet-focus-track', weight: 4 }} interactive={false} />}
    </>
  )
}

interface FocusPanelProps {
  /** The vehicle the driver is on a trip in; null while loading, or when they are on none. */
  vehicle: VehicleLocation | null
  state: LiveState | null
  now: number
  /** The live snapshot is still loading. */
  loading: boolean
  /** Without a vehicle: the driver as GET /drivers/{id} found them, or not. */
  driver: { status: 'pending' | 'found' | 'missing'; name: string | null }
  planned: boolean
  track: boolean
  /** Today's track could not be read: the live position still shows. */
  trackFailed: boolean
  onClear: () => void
}

/** Beside the map while one driver is in focus: who, in what, on which trip, and how recently heard from. */
export function FocusPanel({ vehicle, state, now, loading, driver, planned, track, trackFailed, onClear }: FocusPanelProps) {
  const trip = vehicle?.trip ?? null
  const name = trip?.driver?.full_name ?? driver.name
  return (
    <section aria-label="Driver in focus" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-3 pt-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
          Following
        </p>
        <Button variant="secondary" size="sm" leadingIcon={<X className="h-4 w-4" />} onClick={onClear} title="Show the whole fleet (Esc)">
          Whole fleet
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {loading || (!vehicle && driver.status === 'pending') ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading the driver">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-[160px] w-full" />
          </div>
        ) : vehicle && trip ? (
          <>
            <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{name ?? 'Driver not named'}</h2>
            <p className="mt-0.5 truncate text-sm text-ink-muted">{routeLabel(trip) ?? 'Trip under way'}</p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
              <Row label="Vehicle">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="plate text-ink">{vehicle.registration_number}</span>
                  {state && <LiveBadge state={state} />}
                </span>
              </Row>
              {trip.route_name && (trip.origin || trip.destination) && (
                <Row label="From, to">
                  {trip.origin ?? 'Not set'} → {trip.destination ?? 'Not set'}
                </Row>
              )}
              <Row label="Started">{trip.started_at ? `${formatDay(trip.started_at)}, ${formatTime(trip.started_at)}` : '—'}</Row>
              <Row label="Due to end">{trip.scheduled_end ? `${formatDay(trip.scheduled_end)}, ${formatTime(trip.scheduled_end)}` : '—'}</Row>
              <Row label="Speed">
                <span className="tabular">{vehicle.position ? `${vehicle.position.speed_kmh} km/h` : '—'}</span>
              </Row>
              <Row label="Last ping">
                <span className={state === 'offline' ? 'tabular font-semibold text-danger' : 'tabular'}>
                  {vehicle.position ? lastSeenLabel(vehicle.position.recorded_at, now) : 'Not reported yet'}
                </span>
              </Row>
            </dl>

            <ul aria-label="Lines on the map" className="mt-5 space-y-1.5 border-t border-line pt-4 text-xs text-ink-muted">
              <li className="flex items-center gap-2">
                <span className="fleet-focus-key" aria-hidden />
                {track ? 'Driven today (GPS)' : trackFailed ? 'Today’s track could not be loaded' : 'No track today yet'}
              </li>
              <li className="flex items-center gap-2">
                <span className="fleet-focus-key fleet-focus-key--planned" aria-hidden />
                {planned ? 'Planned route' : 'The route has no points to draw'}
              </li>
            </ul>

            <Link
              to={`/vehicles/${vehicle.vehicle_id}`}
              className="focus-ring mt-5 inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-brand-ink hover:underline"
            >
              <History className="h-4 w-4" aria-hidden="true" />
              {vehicle.registration_number}’s history
            </Link>
          </>
        ) : driver.status === 'found' ? (
          <EmptyState
            icon={<Crosshair />}
            heading={`${name ?? 'This driver'} is not on a trip`}
            description="Their vehicle shows here, followed, as soon as they start one."
            className="py-10"
          />
        ) : (
          <EmptyState
            icon={<UserRoundX />}
            heading="Driver not found"
            description="No driver with this link in your depots. They may work at another depot, or the link is wrong."
            className="py-10"
          />
        )}
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="min-w-0 font-medium text-ink">{children}</dd>
    </>
  )
}
