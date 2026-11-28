// Driver navigation (FMS-166, docs/driver-navigation.md): what the phone works out between two answers from the
// server, from its own GPS. Where the driver is on the road, how far is left, the next turn, and whether they left the
// road. Pure, so it is unit-tested.

export type LngLat = [number, number]
export interface Point {
  lat: number
  lng: number
}

export interface NavigationStep {
  instruction: string
  type: string
  modifier: string | null
  road: string | null
  distance_m: number
  duration_s: number
  lat: number
  lng: number
}

export interface NavigationWaypoint {
  kind: 'stop' | 'destination'
  stop_id: string | null
  sequence_number: number | null
  name: string
  lat: number
  lng: number
}

export type NoRoadReason = 'no_origin' | 'no_waypoints' | 'routing_not_configured' | 'routing_unavailable' | 'no_road'

/** GET /trips/{id}/navigation. */
export interface TripNavigation {
  trip_id: string
  status: string
  origin: { lat: number; lng: number; source: 'phone' | 'vehicle' } | null
  waypoints: NavigationWaypoint[]
  destination: NavigationWaypoint | null
  road: {
    distance_km: number
    duration_seconds: number
    arrival_at: string
    geometry: { type: 'LineString'; coordinates: LngLat[] }
    steps: NavigationStep[]
  } | null
  no_road: NoRoadReason | null
  straight_line: { distance_km: number; bearing_deg: number } | null
  as_of: string
}

/** Off the road by more than this, the road is asked for again from where the driver is. */
export const OFF_ROUTE_M = 150
/** And at least this often while moving, so the time left follows the traffic of the day's driving. */
export const REROUTE_EVERY_MS = 30_000

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

/** Great-circle distance in metres. */
export function metres(a: Point, b: Point): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const toPoint = ([lng, lat]: LngLat): Point => ({ lat, lng })

/**
 * The closest place on the line to `p`: which segment (its first vertex), how far along it (0 to 1), and how far `p`
 * is from it, in metres. Flat-earth within a segment, which is metres long: plenty for a road on a phone.
 */
export function nearestOnLine(line: readonly LngLat[], p: Point): { index: number; t: number; offM: number } {
  let best = { index: 0, t: 0, offM: Number.POSITIVE_INFINITY }
  const kx = Math.cos(rad(p.lat)) * 111_320
  const ky = 110_540
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = [(line[i][0] - p.lng) * kx, (line[i][1] - p.lat) * ky]
    const [bx, by] = [(line[i + 1][0] - p.lng) * kx, (line[i + 1][1] - p.lat) * ky]
    const [dx, dy] = [bx - ax, by - ay]
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const off = Math.hypot(ax + t * dx, ay + t * dy)
    if (off < best.offM) best = { index: i, t, offM: off }
  }
  if (line.length === 1) best = { index: 0, t: 0, offM: metres(p, toPoint(line[0])) }
  return best
}

/** Metres along the line from its start to a place on it (a segment and how far along it). */
export function along(line: readonly LngLat[], at: { index: number; t: number }): number {
  let m = 0
  for (let i = 0; i < at.index; i++) m += metres(toPoint(line[i]), toPoint(line[i + 1]))
  if (at.index < line.length - 1) m += at.t * metres(toPoint(line[at.index]), toPoint(line[at.index + 1]))
  return m
}

/** The line's whole length, metres. */
export const lineLength = (line: readonly LngLat[]) => along(line, { index: Math.max(0, line.length - 1), t: 0 })

/** Where the driver stands on the road: metres done, metres left, off the road by, and the next turn. */
export interface Progress {
  doneM: number
  leftM: number
  offM: number
  offRoute: boolean
  /** The next step ahead of the driver (never the departure); null past the last. */
  next: NavigationStep | null
  /** Metres along the road to it. */
  toNextM: number | null
}

export function progress(road: NonNullable<TripNavigation['road']>, p: Point): Progress {
  const line = road.geometry.coordinates
  const here = nearestOnLine(line, p)
  const doneM = along(line, here)
  const total = lineLength(line)
  let next: NavigationStep | null = null
  let toNextM: number | null = null
  for (const step of road.steps) {
    if (step.type === 'depart') continue
    const at = along(line, nearestOnLine(line, step))
    // A turn just passed (within 15 m behind) is done; the first one ahead is next.
    if (at > doneM + 15) {
      next = step
      toNextM = at - doneM
      break
    }
  }
  return { doneM, leftM: Math.max(0, total - doneM), offM: here.offM, offRoute: here.offM > OFF_ROUTE_M, next, toNextM }
}

/** "350 m", "1.2 km", "24 km". */
export function distanceText(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  const km = m / 1000
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

/** "45 min", "2 h 10 min". */
export function durationText(s: number): string {
  const min = Math.max(1, Math.round(s / 60))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const
export const compass = (bearing: number) => COMPASS.at(Math.round((((bearing % 360) + 360) % 360) / 45) % 8)!

/** The trip in Google Maps, as a fallback: from here, through the stops left, to the destination. */
export function googleMapsUrl(waypoints: readonly NavigationWaypoint[]): string | null {
  const last = waypoints.at(-1)
  if (!last) return null
  const q = new URLSearchParams({ api: '1', destination: `${last.lat},${last.lng}`, travelmode: 'driving' })
  const via = waypoints.slice(0, -1)
  if (via.length) q.set('waypoints', via.map((w) => `${w.lat},${w.lng}`).join('|'))
  return `https://www.google.com/maps/dir/?${q}`
}
