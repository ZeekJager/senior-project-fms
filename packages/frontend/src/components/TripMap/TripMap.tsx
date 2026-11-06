import 'leaflet/dist/leaflet.css'
import '../FleetMap/FleetMap.css'
import './TripMap.css'
import { Pause, Play, Route } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AttributionControl, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import { ADDIS_ABABA, TILE_ATTRIBUTION, TILE_URL, useInViewport } from '@/components/FleetMap'
import { cn } from '@/components/ui'
import { tripMapBounds, type LatLng } from './bounds'

// A trip on a map (FMS-136): the route it was planned on, dashed, along its road when measured (FMS-84) and
// straight from origin to destination otherwise, and the GPS track it drove, solid. Tiles load only once the map is on screen, like the fleet map (FMS-44).
// With the points' times the track can be replayed (FMS-95): Play or the slider move the vehicle along it, the road still ahead faint.

export interface TripMapProps {
  /** The route's two ends; either may be unknown. */
  planned: { origin: LatLng | null; destination: LatLng | null }
  /** The road the route follows (FMS-84), when measured: drawn instead of a straight line. */
  road?: readonly LatLng[] | null
  /** The GPS points it reported, oldest first. */
  track: readonly LatLng[]
  /** When each track point was recorded (ISO), in the same order: given, the track can be replayed. */
  times?: readonly string[]
  /** The accessible name of the map region. */
  label: string
  className?: string
}

export function TripMap({ planned, road, track, times, label, className }: TripMapProps) {
  const box = useRef<HTMLDivElement>(null)
  const visible = useInViewport(box)
  const [opened, setOpened] = useState(false)
  if (visible && !opened) setOpened(true)
  const onRoad = road && road.length > 1 ? road : null
  const bounds = tripMapBounds(planned, onRoad ? [...track, ...onRoad] : track)
  const plannedLine: LatLng[] | null = onRoad ? [...onRoad] : planned.origin && planned.destination ? [planned.origin, planned.destination] : null
  // Where it set off and where it got to: the track's ends, else the route's.
  const start = track[0] ?? planned.origin
  const end = track.at(-1) ?? planned.destination
  const replayable = times !== undefined && times.length === track.length && track.length > 1
  // The point the replay is at; null shows the whole track.
  const [at, setAt] = useState<number | null>(null)
  const replayAt = replayable && at !== null && at < track.length ? at : null
  const driven = replayAt !== null ? track.slice(0, replayAt + 1) : track

  return (
    <div ref={box} role="region" aria-label={label} className={cn('fleet-map trip-map relative isolate min-h-64 overflow-hidden rounded-card border border-line bg-surface-sunken', className)}>
      {opened && bounds ? (
        <MapContainer center={ADDIS_ABABA} zoom={7} zoomSnap={0.25} zoomDelta={0.5} zoomControl={false} attributionControl={false} className="absolute inset-0 h-full w-full">
          {visible && <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} className="fleet-map-tiles" />}
          <ZoomControl position="topright" />
          <AttributionControl position="bottomright" prefix='<a href="https://leafletjs.com">Leaflet</a>' />
          <FitTo bounds={bounds} />
          {plannedLine && <Polyline positions={plannedLine} pathOptions={{ className: 'trip-map-planned', weight: 2 }} interactive={false} />}
          {replayAt !== null && <Polyline positions={[...track]} pathOptions={{ className: 'trip-map-track trip-map-track--ahead', weight: 4 }} interactive={false} />}
          {driven.length > 1 && <Polyline positions={[...driven]} pathOptions={{ className: 'trip-map-track', weight: 4 }} interactive={false} />}
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
          {replayAt !== null && <CircleMarker center={track[replayAt]} radius={8} pathOptions={{ className: 'trip-map-replay', weight: 3 }} interactive={false} />}
        </MapContainer>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-subtle">
          <Route className="h-6 w-6" aria-hidden="true" />
          {!bounds && <p>No route or GPS track to show for this trip.</p>}
        </div>
      )}
      {replayable && <ReplayBar times={times} at={replayAt} onAt={setAt} />}
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
              {onRoad ? 'Planned route (road)' : 'Planned route'}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

const replayTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** A whole replay takes about 20 seconds however many points: at most 200 steps of 100 ms. */
export const REPLAY_TICK_MS = 100
const REPLAY_STEPS = 200

/** The replay's controls (FMS-95): Play or Pause, a slider over the points, and the time of the one shown. */
function ReplayBar({ times, at, onAt }: { times: readonly string[]; at: number | null; onAt: (at: number | null) => void }) {
  const [playing, setPlaying] = useState(false)
  const last = times.length - 1
  const shown = at ?? last
  const step = Math.max(1, Math.ceil(times.length / REPLAY_STEPS))

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(() => {
      const next = Math.min(last, (at ?? -1) + step)
      // At the end the whole track shows again.
      if (next >= last) {
        setPlaying(false)
        onAt(null)
      } else onAt(next)
    }, REPLAY_TICK_MS)
    return () => clearTimeout(timer)
  }, [playing, at, last, step, onAt])

  function toggle() {
    if (playing) return setPlaying(false)
    if (at === null) onAt(0)
    setPlaying(true)
  }

  const label = replayTime.format(new Date(times[shown]))
  return (
    <div className="absolute left-3 top-3 z-[1000] flex max-w-[calc(100%-4.5rem)] items-center gap-2 rounded-control border border-line bg-surface py-1.5 pl-1.5 pr-3 text-xs shadow-soft">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause replay' : 'Replay the track'}
        className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white hover:bg-brand-strong"
      >
        {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4 translate-x-px" aria-hidden="true" />}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        value={shown}
        onChange={(e) => {
          setPlaying(false)
          const value = Number(e.target.value)
          onAt(value >= last ? null : value)
        }}
        aria-label="Replay position"
        aria-valuetext={label}
        className="trip-map-scrubber h-8 w-28 min-w-0 flex-1 cursor-pointer sm:w-44"
      />
      <span className="shrink-0 tabular-nums text-ink">{label}</span>
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
