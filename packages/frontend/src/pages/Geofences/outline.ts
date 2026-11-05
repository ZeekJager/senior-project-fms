import type { GeofencePolygon } from '@/features/geofences'

// The outline being drawn in the editor (FMS-90): corners as Leaflet has them, [latitude, longitude], in order
// around the fence. Checked here as the server checks it, so the admin sees the problem while drawing.

export type Corner = [number, number]

export const MAX_CORNERS = 500
const MIN_AREA_M2 = 400
const EARTH_M = 6_371_000
const rad = (deg: number) => (deg * Math.PI) / 180

/** GeoJSON for the API: [longitude, latitude], closed, 6 decimals. */
export function toPolygon(corners: readonly Corner[]): GeofencePolygon {
  const ring = corners.map(([lat, lng]): [number, number] => [round6(lng), round6(lat)])
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] }
}

/** Square metres, on a flat projection about the outline's middle. */
export function areaOf(corners: readonly Corner[]): number {
  if (corners.length < 3) return 0
  const midLat = corners.reduce((sum, c) => sum + c[0], 0) / corners.length
  const xy = corners.map(([lat, lng]) => [rad(lng) * Math.cos(rad(midLat)) * EARTH_M, rad(lat) * EARTH_M])
  let twice = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]
    const [x2, y2] = xy[(i + 1) % xy.length]
    twice += x1 * y2 - x2 * y1
  }
  return Math.abs(twice) / 2
}

/** What stops the outline from being saved, in the admin's words, or null. */
export function outlineProblem(corners: readonly Corner[]): string | null {
  if (corners.length < 3) return `Click the map to place at least 3 corners${corners.length ? ` (${3 - corners.length} more)` : ''}.`
  if (corners.length > MAX_CORNERS) return `At most ${MAX_CORNERS} corners.`
  if (crosses(corners)) return 'The edges cross. Drag a corner so the outline goes around the area without crossing itself.'
  if (areaOf(corners) < MIN_AREA_M2) return 'Too small: draw it at least 20 m across.'
  return null
}

/** Whether two edges that are not neighbours meet. */
function crosses(pts: readonly Corner[]): boolean {
  const n = pts.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (j + 1) % n === i) continue
      if (meet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true
    }
  }
  return false
}

function meet(p1: Corner, p2: Corner, q1: Corner, q2: Corner): boolean {
  const d1 = side(q1, q2, p1)
  const d2 = side(q1, q2, p2)
  const d3 = side(p1, p2, q1)
  const d4 = side(p1, p2, q2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

const side = (a: Corner, b: Corner, c: Corner) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
