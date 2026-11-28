import 'leaflet/dist/leaflet.css'
import '@/components/FleetMap/FleetMap.css'
import './Navigate.css'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Compass,
  CornerUpLeft,
  CornerUpRight,
  ExternalLink,
  Flag,
  LocateFixed,
  MapPinOff,
  RotateCcw,
  RotateCw,
  WifiOff,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AttributionControl, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { Link, useSearchParams } from 'react-router-dom'
import { ADDIS_ABABA, TILE_ATTRIBUTION, TILE_URL, useInViewport } from '@/components/FleetMap'
import { Skeleton, cn } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useTodayTrips } from './api'
import {
  OFF_ROUTE_M,
  REROUTE_EVERY_MS,
  compass,
  distanceText,
  durationText,
  googleMapsUrl,
  metres,
  progress,
  type NavigationStep,
  type NoRoadReason,
  type Point,
  type TripNavigation,
} from './navigation'
import { Panel } from './parts'

// Live navigation to the trip's stops and destination (FMS-166, docs/driver-navigation.md): the map follows the
// phone's GPS, the road comes from the server's routing engine, and the phone works out between two answers how far
// is left and which turn is next. Asked again every 30 s on the move, and at once when the driver leaves the road.

type GpsProblem = 'denied' | 'unavailable' | null

/** The phone's position while the screen is open, as precise as it gives it. */
function useLivePosition(): { here: Point | null; problem: GpsProblem; accuracyM: number | null } {
  const [here, setHere] = useState<Point | null>(null)
  const [accuracyM, setAccuracy] = useState<number | null>(null)
  const [problem, setProblem] = useState<GpsProblem>(null)
  useEffect(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
    if (typeof geo?.watchPosition !== 'function') {
      setProblem('unavailable')
      return
    }
    const id = geo.watchPosition(
      (pos) => {
        setProblem(null)
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setAccuracy(pos.coords.accuracy)
      },
      (err) => setProblem(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    )
    return () => geo.clearWatch(id)
  }, [])
  return { here, problem, accuracyM }
}

/** GET /trips/{id}/navigation from where the driver was when asked; the last answer stays on screen while asking again. */
function useNavigation(tripId: string | null, from: Point | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['driver', 'navigation', tripId, from ? `${from.lat.toFixed(5)},${from.lng.toFixed(5)}` : null],
    queryFn: () => api.request<TripNavigation>(`/trips/${tripId}/navigation${from ? `?from=${from.lat.toFixed(6)},${from.lng.toFixed(6)}` : ''}`),
    enabled: tripId !== null && enabled,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  })
}

/** How long the screen waits for the phone's first fix before asking for the road from the vehicle's last position. */
const NO_FIX_WAIT_MS = 6_000

const NO_ROAD: Record<NoRoadReason, string> = {
  no_origin: 'Waiting for your position to draw the road.',
  no_waypoints: 'Every stop is done and the trip has no destination on the map.',
  routing_not_configured: 'Road directions are not set up on this server. Head the way the arrow points.',
  routing_unavailable: 'Road directions are not reachable right now. Head the way the arrow points; it tries again.',
  no_road: 'No road was found from here. Head the way the arrow points.',
}

/**
 * /driver/navigate (FMS-166): the trip under way, or `?trip=`, on a full-screen map: the next turn on top, the time
 * and distance left and the arrival below, the road drawn to the next stops and the destination.
 */
export function DriverNavigate() {
  const [params] = useSearchParams()
  const today = useTodayTrips()
  const trips = today.data ?? []
  const trip = trips.find((t) => t.id === params.get('trip')) ?? trips.find((t) => t.status === 'en_route') ?? trips[0] ?? null
  const { here, problem, accuracyM } = useLivePosition()

  // Where the road was last asked from, and when: asked again on the move every 30 s, and at once off the road.
  const [asked, setAsked] = useState<{ at: number; from: Point } | null>(null)
  // With no fix after a few seconds (or none possible), the road is asked from the vehicle's last stored position.
  const [noFix, setNoFix] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setNoFix(true), NO_FIX_WAIT_MS)
    return () => clearTimeout(t)
  }, [])
  const nav = useNavigation(trip?.id ?? null, asked?.from ?? null, asked !== null || noFix || problem !== null)
  const data = nav.data ?? null
  const road = data?.road ?? null
  const where = useMemo(() => (road && here ? progress(road, here) : null), [road, here])

  useEffect(() => {
    if (!here) return
    const now = Date.now()
    if (!asked) return setAsked({ at: now, from: here })
    const moved = metres(asked.from, here)
    if ((where?.offRoute && now - asked.at > 10_000) || (now - asked.at > REROUTE_EVERY_MS && moved > 30)) setAsked({ at: now, from: here })
  }, [here, asked, where?.offRoute])

  if (today.isPending) return <Skeleton className="h-[70vh] w-full rounded-card" />
  if (!trip) {
    return (
      <Panel icon={<Flag />} title="No trip to navigate" tone="neutral">
        Navigation opens for the trip you are driving today.
      </Panel>
    )
  }

  const left = road ? (where ? where.leftM : road.distance_km * 1000) : null
  const secondsLeft = road && left !== null ? (road.duration_seconds * left) / Math.max(1, road.distance_km * 1000) : null
  const arrival = secondsLeft !== null ? new Date(Date.now() + secondsLeft * 1000) : null
  const nextWaypoint = data?.waypoints[0] ?? null
  const maps = data ? googleMapsUrl(data.waypoints) : null
  const offline = nav.isError || nav.fetchStatus === 'paused'

  return (
    <div className="-mx-4 -mt-5 flex h-[calc(100dvh-8rem)] min-h-[28rem] flex-col">
      <TurnBanner step={where?.next ?? road?.steps.find((s) => s.type !== 'depart') ?? null} toM={where?.toNextM ?? null} straight={!road ? data?.straight_line ?? null : null} />

      <div className="relative flex-1">
        <NavigationMap data={data} here={here} accuracyM={accuracyM} />
        <div className="pointer-events-none absolute inset-x-3 top-3 z-[1000] space-y-2">
          {/* While the trip is under way the driver portal's own banner says the location is blocked (FMS-57). */}
          {problem && !(problem === 'denied' && trip.status === 'en_route') && (
            <Notice icon={<MapPinOff />} tone="danger">
              {problem === 'denied' ? 'Location is blocked: allow it for this app in the browser settings to follow the map.' : 'No GPS fix yet. Step outside or wait a moment.'}
            </Notice>
          )}
          {offline && data && (
            <Notice icon={<WifiOff />} tone="neutral">
              No signal: the last road stays on screen and your position still moves.
            </Notice>
          )}
          {where?.offRoute && (
            <Notice icon={<RotateCcw />} tone="warning">
              Off the road by {distanceText(where.offM)}: finding a new road…
            </Notice>
          )}
          {data && !road && data.no_road && (
            <Notice icon={<Compass />} tone="neutral">
              {NO_ROAD[data.no_road]}
            </Notice>
          )}
        </div>
      </div>

      <section aria-label="Trip progress" className="border-t border-line bg-surface px-4 pb-4 pt-3 shadow-[0_-8px_24px_rgba(17,20,45,0.08)]">
        {nav.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : nav.isError && !data ? (
          <p className="flex items-center gap-2 text-base text-danger">
            <AlertCircle className="h-5 w-5" aria-hidden="true" /> The road could not be loaded. Check your signal.
          </p>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{nextWaypoint?.kind === 'stop' ? `Next stop · ${nextWaypoint.sequence_number}` : 'Destination'}</p>
                <h1 className="truncate text-xl font-semibold text-ink">{nextWaypoint?.name ?? data?.destination?.name ?? trip.destination ?? 'Destination'}</h1>
                {data?.destination && nextWaypoint?.kind === 'stop' && <p className="truncate text-sm text-ink-muted">Then {data.destination.name}</p>}
              </div>
              {arrival && (
                <p className="shrink-0 text-right">
                  <span className="block text-xs font-semibold uppercase tracking-wider text-ink-subtle">Arrive</span>
                  <span className="block text-2xl font-semibold tabular-nums text-success">{arrival.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                </p>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <Figure label="Time left">{secondsLeft !== null ? durationText(secondsLeft) : '—'}</Figure>
              <Figure label="Distance left">
                {left !== null ? distanceText(left) : data?.straight_line ? `${distanceText(data.straight_line.distance_km * 1000)} ${compass(data.straight_line.bearing_deg)}` : '—'}
              </Figure>
            </dl>
            <div className="mt-3 flex gap-2">
              <Link to="/driver" className="focus-ring flex h-12 items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 text-base font-semibold text-ink hover:bg-surface-muted">
                <ArrowLeft className="h-5 w-5" aria-hidden="true" /> My day
              </Link>
              {maps && (
                <a href={maps} target="_blank" rel="noreferrer" className="focus-ring flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand px-4 text-base font-semibold text-white shadow-soft hover:bg-brand-strong">
                  <ExternalLink className="h-5 w-5" aria-hidden="true" /> Open in Google Maps
                </a>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-sunken px-3 py-2">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-ink">{children}</dd>
    </div>
  )
}

function Notice({ icon, tone, children }: { icon: ReactNode; tone: 'danger' | 'warning' | 'neutral'; children: ReactNode }) {
  return (
    <p
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm shadow-soft [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger',
        tone === 'warning' && 'border-warning/30 bg-warning-soft text-ink',
        tone === 'neutral' && 'border-line bg-surface text-ink',
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  )
}

/** The arrow for a turn. */
function TurnIcon({ step }: { step: NavigationStep | null }) {
  const cls = 'h-9 w-9'
  if (!step) return <ArrowUp className={cls} aria-hidden="true" />
  if (step.type === 'arrive') return <Flag className={cls} aria-hidden="true" />
  if (step.type === 'roundabout' || step.type === 'rotary') return <RotateCw className={cls} aria-hidden="true" />
  switch (step.modifier) {
    case 'left':
    case 'sharp left':
      return <CornerUpLeft className={cls} aria-hidden="true" />
    case 'right':
    case 'sharp right':
      return <CornerUpRight className={cls} aria-hidden="true" />
    case 'slight left':
      return <ArrowUpLeft className={cls} aria-hidden="true" />
    case 'slight right':
      return <ArrowUpRight className={cls} aria-hidden="true" />
    case 'uturn':
      return <RotateCcw className={cls} aria-hidden="true" />
    default:
      return <ArrowUp className={cls} aria-hidden="true" />
  }
}

/** The next turn, large, on the brand colour: the distance to it, then what to do. Without a road, the compass line. */
function TurnBanner({ step, toM, straight }: { step: NavigationStep | null; toM: number | null; straight: TripNavigation['straight_line'] }) {
  return (
    <section aria-label="Next turn" aria-live="polite" className="flex min-h-20 items-center gap-4 bg-brand px-4 py-3 text-white">
      {straight ? (
        <>
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15" style={{ transform: `rotate(${straight.bearing_deg}deg)` }}>
            <ArrowUp className="h-9 w-9" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-2xl font-bold tabular-nums">{distanceText(straight.distance_km * 1000)}</span>
            <span className="block truncate text-base text-white/85">Head {compass(straight.bearing_deg)}, as the crow flies</span>
          </span>
        </>
      ) : (
        <>
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15">
            <TurnIcon step={step} />
          </span>
          <span className="min-w-0">
            <span className="block text-2xl font-bold tabular-nums">{toM !== null ? distanceText(toM) : step ? distanceText(step.distance_m) : '…'}</span>
            <span className="block truncate text-base text-white/90">{step?.instruction ?? 'Finding the road…'}</span>
          </span>
        </>
      )}
    </section>
  )
}

/** Keeps the map on the driver while following; a drag stops following until Recentre. */
function Follow({ here, follow, onDrag }: { here: Point | null; follow: boolean; onDrag: () => void }) {
  const map = useMap()
  useMapEvents({ dragstart: onDrag })
  useEffect(() => {
    if (follow && here) map.setView([here.lat, here.lng], Math.max(map.getZoom(), 15), { animate: true })
  }, [follow, here, map])
  return null
}

/** Shows the whole trip once, before a position arrives. */
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || points.length === 0) return
    done.current = true
    if (points.length === 1) map.setView(points[0], 14)
    else map.fitBounds(points, { padding: [32, 32] })
  }, [map, points])
  return null
}

function NavigationMap({ data, here, accuracyM }: { data: TripNavigation | null; here: Point | null; accuracyM: number | null }) {
  const box = useRef<HTMLDivElement>(null)
  const visible = useInViewport(box)
  const [follow, setFollow] = useState(true)
  const line = useMemo(() => (data?.road?.geometry.coordinates ?? []).map(([lng, lat]) => [lat, lng] as [number, number]), [data])
  const points = useMemo(() => [...line, ...(data?.waypoints ?? []).map((w) => [w.lat, w.lng] as [number, number])], [line, data])
  return (
    <div ref={box} role="region" aria-label="Navigation map" className="fleet-map nav-map absolute inset-0 isolate bg-surface-sunken">
      {visible && (
        <MapContainer center={here ? [here.lat, here.lng] : ADDIS_ABABA} zoom={here ? 15 : 7} zoomControl={false} attributionControl={false} className="absolute inset-0 h-full w-full">
          <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} className="fleet-map-tiles" />
          <AttributionControl position="bottomright" prefix={false} />
          {!here && <FitOnce points={points} />}
          <Follow here={here} follow={follow} onDrag={() => setFollow(false)} />
          {line.length > 1 && (
            <>
              <Polyline positions={line} pathOptions={{ className: 'nav-road-casing', weight: 10 }} interactive={false} />
              <Polyline positions={line} pathOptions={{ className: 'nav-road', weight: 6 }} interactive={false} />
            </>
          )}
          {!data?.road && here && data?.waypoints[0] && (
            <Polyline positions={[[here.lat, here.lng], [data.waypoints[0].lat, data.waypoints[0].lng]]} pathOptions={{ className: 'nav-straight', weight: 3 }} interactive={false} />
          )}
          {data?.waypoints.map((w) => (
            <CircleMarker key={w.stop_id ?? 'destination'} center={[w.lat, w.lng]} radius={w.kind === 'destination' ? 11 : 8} pathOptions={{ className: w.kind === 'destination' ? 'nav-destination' : 'nav-stop', weight: 3 }}>
              <Tooltip permanent direction="top" offset={[0, -10]} className="nav-label">
                {w.kind === 'destination' ? `Destination: ${w.name}` : `${w.sequence_number}. ${w.name}`}
              </Tooltip>
            </CircleMarker>
          ))}
          {here && accuracyM !== null && accuracyM > 20 && (
            <CircleMarker center={[here.lat, here.lng]} radius={Math.min(40, accuracyM / 4)} pathOptions={{ className: 'nav-accuracy', weight: 0 }} interactive={false} />
          )}
          {here && <CircleMarker center={[here.lat, here.lng]} radius={9} pathOptions={{ className: 'nav-me', weight: 4 }} interactive={false} />}
        </MapContainer>
      )}
      {!follow && here && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="focus-ring absolute bottom-4 right-4 z-[1000] flex h-12 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-base font-semibold text-ink shadow-soft"
        >
          <LocateFixed className="h-5 w-5 text-brand-ink" aria-hidden="true" /> Recentre
        </button>
      )}
      {here === null && !data && (
        <div className="absolute inset-0 grid place-items-center text-sm text-ink-subtle">
          <span>Finding your position…</span>
        </div>
      )}
      <span className="sr-only">{data?.road ? `The road is ${distanceText(data.road.distance_km * 1000)}, off-route beyond ${OFF_ROUTE_M} m.` : ''}</span>
    </div>
  )
}
