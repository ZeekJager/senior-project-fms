/** [latitude, longitude]. */
export type LatLng = [number, number]

/**
 * The box a trip's map frames: every GPS point and the route's two ends, south-west then north-east.
 * Null when there is nothing to draw.
 */
export function tripMapBounds(planned: { origin: LatLng | null; destination: LatLng | null }, track: readonly LatLng[]): [LatLng, LatLng] | null {
  const points = [...track, ...(planned.origin ? [planned.origin] : []), ...(planned.destination ? [planned.destination] : [])]
  if (points.length === 0) return null
  const lats = points.map((p) => p[0])
  const lngs = points.map((p) => p[1])
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ]
}
