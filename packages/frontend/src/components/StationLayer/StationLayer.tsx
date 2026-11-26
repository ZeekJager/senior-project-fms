import './StationLayer.css'
import { CircleMarker, Tooltip } from 'react-leaflet'

// The charging network on a map (FMS-99, S-40; also the live map S-16): each station with a place, in use when an
// EV charges there now. Drawn under the vehicle markers; it takes no clicks, the tooltip says what it is.

export interface MapStation {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
  power_kw: number | null
  connector_type: string | null
  status: string
}

export interface StationLayerProps {
  stations: readonly MapStation[]
  /** How many EVs charge at each station now, by station id. */
  chargingAt?: ReadonlyMap<string, number>
}

/** "60 kW · CCS2", or what is known of it. */
export function stationSpec(s: Pick<MapStation, 'power_kw' | 'connector_type'>): string {
  return [s.power_kw !== null ? `${s.power_kw} kW` : null, s.connector_type].filter(Boolean).join(' · ')
}

export function StationLayer({ stations, chargingAt }: StationLayerProps) {
  return (
    <>
      {stations.map((s) => {
        if (s.latitude === null || s.longitude === null) return null
        const busy = chargingAt?.get(s.id) ?? 0
        const down = s.status !== 'available' && s.status !== 'active'
        const spec = stationSpec(s)
        return (
          <CircleMarker
            key={s.id}
            center={[s.latitude, s.longitude]}
            radius={busy > 0 ? 8 : 6}
            interactive
            pathOptions={{ className: `station-dot${busy > 0 ? ' station-dot--busy' : ''}${down ? ' station-dot--down' : ''}` }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <span className="font-semibold">{s.name}</span>
              {spec && <> · {spec}</>}
              <br />
              {down ? 'Out of service' : busy > 0 ? `${busy} charging now` : 'Free'}
            </Tooltip>
          </CircleMarker>
        )
      })}
    </>
  )
}
