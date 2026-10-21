import 'leaflet/dist/leaflet.css'
import './FleetMap.css'
import L from 'leaflet'
import { MapPin } from 'lucide-react'
import { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react'
import { AttributionControl, MapContainer, Marker, TileLayer, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import { cn } from '@/components/ui'
import { lastSeenLabel, markerState, STATE_LABELS, trackStops, type FleetMapVehicle, type MarkerState } from './markerState'
import { useInViewport, useNow } from './hooks'

// The fleet map (FMS-44): OpenStreetMap tiles and one marker per vehicle, coloured by what its last
// ping says. It only draws what it is given: the parent (the Fleet Command Center, FMS-45) owns the
// socket and passes `vehicles` as a prop. Tiles load only while the map is on screen.

/** Addis Ababa, where the map opens before any vehicle has reported. */
export const ADDIS_ABABA: L.LatLngTuple = [9.0108, 38.7613]
export const DEFAULT_ZOOM = 12

// OpenStreetMap's tiles need no key, but their usage policy is for light use: a production deployment
// with many dispatchers points these at its own tile server or a provider (docs/shared-ui.md).
const TILE_URL: string = import.meta.env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION: string =
  import.meta.env.VITE_MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

/** How often markers are re-checked against the clock, so one turns grey when its pings stop. */
const CLOCK_TICK_MS = 10_000

export interface FleetMapProps {
  vehicles: readonly FleetMapVehicle[]
  /** Called with the vehicle's id when its marker is clicked, or activated with Enter or Space. */
  onVehicleClick?: (vehicleId: string) => void
  /** Size the map here (it fills this box); a height is required. */
  className?: string
  /** The accessible name of the map region. */
  label?: string
}

/** The ref is the Leaflet map, once it exists, so the parent can pan to a vehicle (`flyTo`). */
export const FleetMap = forwardRef<L.Map, FleetMapProps>(function FleetMap({ vehicles, onVehicleClick, className, label = 'Fleet map' }, ref) {
  const box = useRef<HTMLDivElement>(null)
  const visible = useInViewport(box)
  // The map is created the first time it is on screen and kept after that, so scrolling away and
  // back keeps the view. Its tiles are removed while it is off screen, so nothing is fetched then.
  const [opened, setOpened] = useState(false)
  if (visible && !opened) setOpened(true)

  const now = useNow(CLOCK_TICK_MS)
  const stops = useRef<Map<string, number>>(new Map())
  stops.current = useMemo(() => trackStops(stops.current, vehicles), [vehicles])
  const states = vehicles.map((v) => markerState(v, now, stops.current.get(v.vehicleId) ?? null))

  return (
    <div
      ref={box}
      role="region"
      aria-label={label}
      className={cn('fleet-map relative isolate min-h-64 overflow-hidden rounded-card border border-line bg-surface-sunken', className)}
    >
      {opened ? (
        <MapContainer
          ref={ref}
          center={ADDIS_ABABA}
          zoom={DEFAULT_ZOOM}
          zoomControl={false}
          attributionControl={false}
          className="absolute inset-0 h-full w-full"
        >
          {visible && <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} className="fleet-map-tiles" />}
          <ZoomControl position="topright" />
          <AttributionControl position="bottomright" prefix='<a href="https://leafletjs.com">Leaflet</a>' />
          <FitOnFirstReport vehicles={vehicles} />
          <FollowSize />
          {vehicles.map((v, i) => (
            <VehicleMarker key={v.vehicleId} vehicle={v} state={states[i]} now={now} onVehicleClick={onVehicleClick} />
          ))}
        </MapContainer>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-ink-subtle" aria-hidden>
          <MapPin className="h-6 w-6" />
        </div>
      )}
      {vehicles.length === 0 && (
        <p className="pointer-events-none absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-control border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted shadow-soft">
          No vehicles reporting yet
        </p>
      )}
      <Legend states={states} />
    </div>
  )
})

const LEGEND: { key: string; label: string; states: MarkerState[] }[] = [
  { key: 'active', label: 'Moving or stopped', states: ['moving', 'stopped'] },
  { key: 'idling', label: 'Idling 5+ min', states: ['idling'] },
  { key: 'breakdown', label: 'Breakdown', states: ['breakdown'] },
  { key: 'offline', label: 'No ping 2+ min', states: ['offline'] },
]

function Legend({ states }: { states: MarkerState[] }) {
  return (
    <ul
      aria-label="Map legend"
      className="absolute bottom-3 left-3 z-[1000] flex flex-col gap-1.5 rounded-control border border-line bg-surface px-3 py-2.5 text-xs text-ink-muted shadow-soft"
    >
      {LEGEND.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2">
          <span className={cn('fleet-legend-dot', `fleet-legend-dot--${entry.key}`)} aria-hidden />
          <span className="flex-1">{entry.label}</span>
          <span className="tabular pl-3 font-semibold text-ink">{states.filter((s) => entry.states.includes(s)).length}</span>
        </li>
      ))}
    </ul>
  )
}

/** Fits the view to the vehicles the first time any are given; after that the dispatcher's own panning wins. */
function FitOnFirstReport({ vehicles }: { vehicles: readonly FleetMapVehicle[] }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || vehicles.length === 0) return
    done.current = true
    map.fitBounds(L.latLngBounds(vehicles.map((v) => [v.lat, v.lng] as L.LatLngTuple)), { padding: [48, 48], maxZoom: 15, animate: false })
  }, [map, vehicles])
  return null
}

/** Leaflet only notices window resizes; this re-measures when the map's own box changes (a sidebar opening). */
function FollowSize() {
  const map = useMap()
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  return null
}

const TRUCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/>' +
  '<path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>' +
  '<circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>'

function markerIcon(state: MarkerState, heading: number | null): L.DivIcon {
  const arrow = state === 'moving' && heading !== null ? `<span class="fleet-marker__arrow" style="transform: rotate(${heading}deg)"></span>` : ''
  return L.divIcon({
    className: 'fleet-marker-icon',
    html: `<span class="fleet-marker fleet-marker--${state}" data-state="${state}">${arrow}<span class="fleet-marker__dot">${TRUCK}</span></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  })
}

/** From the marker's centre to its tooltip: clears the 36px marker and the tooltip's arrow. */
const TOOLTIP_GAP_PX = 20
/**
 * The tooltip's height (the plate and three rows) plus a margin. Fixed rather than measured: react-leaflet
 * renders the content after Leaflet's `tooltipopen`, when the tooltip is still empty.
 */
const TOOLTIP_HEIGHT_PX = 108

/** Leaflet opens a tooltip on the side it was given; this opens it below a marker when above would cross the map's top edge. */
function placeTooltip(map: L.Map, e: L.TooltipEvent) {
  const y = map.latLngToContainerPoint((e.target as L.Marker).getLatLng()).y
  const below = y - TOOLTIP_GAP_PX - TOOLTIP_HEIGHT_PX < 0
  e.tooltip.options.direction = below ? 'bottom' : 'top'
  e.tooltip.options.offset = L.point(0, below ? TOOLTIP_GAP_PX : -TOOLTIP_GAP_PX)
  e.tooltip.update()
}

const speedLabel = (kmh: number | null) => (kmh === null ? 'Unknown' : `${kmh} km/h`)

interface VehicleMarkerProps {
  vehicle: FleetMapVehicle
  state: MarkerState
  now: number
  onVehicleClick?: (vehicleId: string) => void
}

const VehicleMarker = memo(function VehicleMarker({ vehicle, state, now, onVehicleClick }: VehicleMarkerProps) {
  const map = useMap()
  const marker = useRef<L.Marker>(null)
  // Rounded so a heading that wobbles by a degree does not rebuild the icon on every ping.
  const heading = typeof vehicle.heading === 'number' ? Math.round(vehicle.heading / 5) * 5 : null
  const icon = useMemo(() => markerIcon(state, heading), [state, heading])
  const name = vehicle.plateNumber ?? 'Vehicle'
  const seen = lastSeenLabel(vehicle.lastSeen, now)
  const description = `${name}: ${STATE_LABELS[state]}, ${speedLabel(vehicle.speedKmh)}, last seen ${seen.toLowerCase()}`

  const handlers = useMemo<L.LeafletEventHandlerFnMap>(
    () => ({
      click: () => onVehicleClick?.(vehicle.vehicleId),
      tooltipopen: (e) => placeTooltip(map, e as L.TooltipEvent),
      keydown: (e) => {
        const key = (e as L.LeafletKeyboardEvent).originalEvent
        if (key.key !== 'Enter' && key.key !== ' ') return
        key.preventDefault()
        onVehicleClick?.(vehicle.vehicleId)
      },
    }),
    [map, onVehicleClick, vehicle.vehicleId],
  )

  // The icon is a div with role="button" (Leaflet's keyboard support); this gives it a name. Leaflet
  // reuses the same div when the icon changes, so the label is kept up to date here.
  useEffect(() => {
    marker.current?.getElement()?.setAttribute('aria-label', description)
  }, [description, icon])

  return (
    <Marker ref={marker} position={[vehicle.lat, vehicle.lng]} icon={icon} eventHandlers={handlers} riseOnHover>
      <Tooltip direction="top" opacity={1} className="fleet-map-tooltip">
        <span className="plate block text-ink">{vehicle.plateNumber ?? 'Unknown vehicle'}</span>
        <span className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-ink-subtle">Status</span>
          <span className="font-medium text-ink">{STATE_LABELS[state]}</span>
          <span className="text-ink-subtle">Speed</span>
          <span className="tabular font-medium text-ink">{speedLabel(vehicle.speedKmh)}</span>
          <span className="text-ink-subtle">Last seen</span>
          <span className="tabular font-medium text-ink">{seen}</span>
        </span>
      </Tooltip>
    </Marker>
  )
})
