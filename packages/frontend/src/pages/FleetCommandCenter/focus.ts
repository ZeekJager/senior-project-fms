import type { LatLng } from '@/components/TripMap'
import type { Route } from '@/pages/Routes/api'
import type { TrackPoint } from '@/pages/VehicleHistory/api'
import type { VehiclePosition, VehicleLocation } from './types'

// Focus on one driver (FMS-140): the live map shows only their vehicle, follows it, and draws the
// trip's planned route and the vehicle's track today. Pure functions, tested without a map.

/** The vehicle the driver is on a trip in, if they are on one in the fleet shown. */
export function focusedVehicle(vehicles: readonly VehicleLocation[], driverId: string): VehicleLocation | null {
  return vehicles.find((v) => v.trip?.driver?.driver_id === driverId) ?? null
}

/** The route as planned, origin through its stops to destination, as far as its points are known. */
export function plannedLine(route: Pick<Route, 'origin' | 'stops' | 'destination'> | undefined): LatLng[] {
  if (!route) return []
  const points: LatLng[] = []
  if (route.origin) points.push([route.origin.latitude, route.origin.longitude])
  for (const s of route.stops) if (s.latitude !== null && s.longitude !== null) points.push([s.latitude, s.longitude])
  if (route.destination) points.push([route.destination.latitude, route.destination.longitude])
  return points
}

/** Midnight today in Addis Ababa (UTC+3 all year), as an instant: where today's track starts. */
export function addisDayStart(now = new Date()): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(now)
  return new Date(`${day}T00:00:00+03:00`).toISOString()
}

/**
 * Today's track: the stored points read when the focus began, then each live position newer than the
 * last one, so the line grows as the vehicle moves without reading the history again.
 */
export function extendTrack(track: readonly TrackPoint[], position: VehiclePosition | null): readonly TrackPoint[] {
  const last = track.at(-1)
  if (!position || (last && Date.parse(position.recorded_at) <= Date.parse(last.recorded_at))) return track
  return [...track, { recorded_at: position.recorded_at, lat: position.lat, lng: position.lng, speed_kmh: position.speed_kmh, trip_id: null }]
}
