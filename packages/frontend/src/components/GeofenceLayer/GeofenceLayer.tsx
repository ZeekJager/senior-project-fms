import './GeofenceLayer.css'
import { Polygon, Tooltip } from 'react-leaflet'
import { KIND_LABELS, ringOf, type Geofence } from '@/features/geofences'

// Geofences on a map (FMS-90): a keep-in fence (a yard) is a quiet outline in the brand colour, a keep-out zone a
// light danger fill, so a dispatcher tells them apart without the legend. Drawn under the vehicle markers.

export interface GeofenceLayerProps {
  geofences: readonly Pick<Geofence, 'geofence_id' | 'name' | 'kind' | 'polygon'>[]
  /** The one picked in a list beside the map: drawn bolder. */
  selectedId?: string | null
  /** Clicking a fence picks it; without this the fences do not take clicks (the live map). */
  onSelect?: (geofenceId: string) => void
}

export function GeofenceLayer({ geofences, selectedId = null, onSelect }: GeofenceLayerProps) {
  return (
    <>
      {geofences.map((g) => (
        <Polygon
          key={g.geofence_id}
          positions={ringOf(g.polygon)}
          interactive={Boolean(onSelect)}
          eventHandlers={onSelect ? { click: () => onSelect(g.geofence_id) } : undefined}
          pathOptions={{
            className: `geofence-shape geofence-shape--${g.kind}${g.geofence_id === selectedId ? ' geofence-shape--selected' : ''}`,
            weight: g.geofence_id === selectedId ? 3 : 2,
          }}
        >
          <Tooltip sticky direction="top" className="geofence-tooltip">
            <span className="font-semibold">{g.name}</span> · {KIND_LABELS[g.kind]}
          </Tooltip>
        </Polygon>
      ))}
    </>
  )
}
