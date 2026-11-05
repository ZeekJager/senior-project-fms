import 'leaflet/dist/leaflet.css'
import '@/components/FleetMap/FleetMap.css'
import L from 'leaflet'
import { Fence } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AttributionControl, MapContainer, TileLayer, ZoomControl, useMap, useMapEvents } from 'react-leaflet'
import { ADDIS_ABABA, DEFAULT_ZOOM, TILE_ATTRIBUTION, TILE_URL, useInViewport } from '@/components/FleetMap'
import { cn } from '@/components/ui'

// The map of the Geofences screen and its editor (S-32, FMS-90): tiles only while on screen, like the fleet map.

export interface GeofenceMapProps {
  /** Points the view fits when `fitKey` changes: the fences shown, or the one being edited. */
  fit: readonly [number, number][]
  fitKey: string
  label: string
  className?: string
  /** A click on the map itself (not on a fence or a corner). */
  onMapClick?: (latLng: [number, number]) => void
  children?: ReactNode
  /** Over the map, top centre: a hint or an empty note. */
  note?: ReactNode
  /** Over the map, bottom left. */
  legend?: ReactNode
}

export function GeofenceMap({ fit, fitKey, label, className, onMapClick, children, note, legend }: GeofenceMapProps) {
  const box = useRef<HTMLDivElement>(null)
  const visible = useInViewport(box)
  const [opened, setOpened] = useState(false)
  if (visible && !opened) setOpened(true)

  return (
    <div ref={box} role="region" aria-label={label} className={cn('fleet-map relative isolate min-h-64 overflow-hidden rounded-card border border-line bg-surface-sunken', className)}>
      {opened ? (
        <MapContainer center={ADDIS_ABABA} zoom={DEFAULT_ZOOM} zoomControl={false} attributionControl={false} doubleClickZoom={!onMapClick} className="absolute inset-0 h-full w-full">
          {visible && <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} className="fleet-map-tiles" />}
          <ZoomControl position="topright" />
          <AttributionControl position="bottomright" prefix='<a href="https://leafletjs.com">Leaflet</a>' />
          <FitTo points={fit} fitKey={fitKey} />
          {onMapClick && <ClickToAdd onClick={onMapClick} />}
          {children}
        </MapContainer>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-ink-subtle" aria-hidden>
          <Fence className="h-6 w-6" />
        </div>
      )}
      {note && (
        <p className="pointer-events-none absolute left-1/2 top-3 z-[1000] max-w-[calc(100%-6rem)] -translate-x-1/2 rounded-control border border-line bg-surface px-3 py-1.5 text-center text-xs font-medium text-ink-muted shadow-soft">
          {note}
        </p>
      )}
      {legend && <div className="absolute bottom-3 left-3 z-[1000] rounded-control border border-line bg-surface px-3 py-2 text-xs text-ink-muted shadow-soft">{legend}</div>}
    </div>
  )
}

/** Fits the view to the points whenever `fitKey` changes; with none, keeps the view. Follows the box's size. */
function FitTo({ points, fitKey }: { points: readonly [number, number][]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 0) return
    map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => [lat, lng] as L.LatLngTuple)), { padding: [40, 40], maxZoom: 17, animate: false })
  }, [map, fitKey])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  return null
}

function ClickToAdd({ onClick }: { onClick: (latLng: [number, number]) => void }) {
  useMapEvents({ click: (e) => onClick([e.latlng.lat, e.latlng.lng]) })
  return null
}
