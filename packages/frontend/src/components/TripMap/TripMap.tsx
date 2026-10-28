import 'leaflet/dist/leaflet.css'
import '../FleetMap/FleetMap.css'
import './TripMap.css'
import { Route } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AttributionControl, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import { ADDIS_ABABA, TILE_ATTRIBUTION, TILE_URL, useInViewport } from '@/components/FleetMap'
import { cn } from '@/components/ui'
import { tripMapBounds, type LatLng } from './bounds'

// A trip on a map (FMS-136): the route it was planned on, dashed from origin to destination, and the
// GPS track it drove, solid. Tiles load only once the map is on screen, like the fleet map (FMS-44).

export interface TripMapProps {
  /** The route's two ends; either may be unknown. */
  planned: { origin: LatLng | null; destination: LatLng | null }
  /** The GPS points it reported, oldest first. */
  track: readonly LatLng[]
  /** The accessible name of the map region. */
  label: string
  className?: string
}

export function TripMap({ planned, track, label, className }: TripMapProps) {
  const box = useRef<HTMLDivElement>(null)
  const visible = useInViewport(box)
  const [opened, setOpened] = useState(false)
  if (visible && !opened) setOpened(true)
  const bounds = tripMapBounds(planned, track)
  const plannedLine: LatLng[] | null = planned.origin && planned.destination ? [planned.origin, planned.destination] : null
  // Where it set off and where it got to: the track's ends, else the route's.
  const start = track[0] ?? planned.origin
  const end = track.at(-1) ?? planned.destination

  return (
    <div ref={box} role="region" aria-label={label} className={cn('fleet-map trip-map relative isolate min-h-64 overflow-hidden rounded-card border border-line bg-surface-sunken', className)}>
      {opened && bounds ? (
        <MapContainer center={ADDIS_ABABA} zoom={7} zoomSnap={0.25} zoomDelta={0.5} zoomControl={false} attributionControl={false} className="absolute inset-0 h-full w-full">
          {visible && <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} className="fleet-map-tiles" />}
          <ZoomControl position="topright" />
          <AttributionControl position="bottomright" prefix='<a href="https://leafletjs.com">Leaflet</a>' />
          <FitTo bounds={bounds} />
          {plannedLine && <Polyline positions={plannedLine} pathOptions={{ className: 'trip-map-planned', weight: 2 }} interactive={false} />}
          {track.length > 1 && <Polyline positions={[...track]} pathOptions={{ className: 'trip-map-track', weight: 4 }} interactive={false} />}
          {start && (
            <CircleMarker center={start} radius={6} pathOptions={{ className: 'trip-map-start', weight: 2 }}>
              <Tooltip direction="top" offset={[0, -6]}>Start</Tooltip>
            </CircleMarker>
          )}
          {end && (
            <CircleMarker center={end} radius={6} pathOptions={{ className: 'trip-map-end', weight: 2 }}>
              <Tooltip direction="top" offset={[0, -6]}>{track.length > 0 ? 'Last position' : 'Destination'}</Tooltip>
            </CircleMarker>
          )}
        </MapContainer>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-subtle">
          <Route className="h-6 w-6" aria-hidden="true" />
          {!bounds && <p>No route or GPS track to show for this trip.</p>}
        </div>
      )}
      {bounds && (
        <ul aria-label="Map legend" className="absolute bottom-3 left-3 z-[1000] flex flex-col gap-1.5 rounded-control border border-line bg-surface px-3 py-2 text-xs text-ink-muted shadow-soft">
          {track.length > 1 && (
            <li className="flex items-center gap-2">
              <span className="trip-map-key trip-map-key--track" aria-hidden />
              Driven (GPS)
            </li>
          )}
          {plannedLine && (
            <li className="flex items-center gap-2">
              <span className="trip-map-key trip-map-key--planned" aria-hidden />
              Planned route
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Frames the trip once, when its points are known (quarter-step zoom, see MapContainer, so the frame is tight), and follows the box's size. */
function FitTo({ bounds }: { bounds: [LatLng, LatLng] }) {
  const map = useMap()
  const key = bounds.flat().join(',')
  useEffect(() => {
    // Room at the bottom for the legend, which sits over the map's lower-left corner.
    map.fitBounds(bounds, { paddingTopLeft: [32, 32], paddingBottomRight: [32, 88], maxZoom: 14 })
  }, [map, key])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  return null
}
