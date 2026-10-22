import { markerState, type FleetMapVehicle, type MarkerState } from '@/components/FleetMap'
import type { LocationUpdate, LiveTrip, VehicleLocation } from './types'

// The live fleet as the command center keeps it (FMS-45): the server's snapshot, moved on by the
// socket's positions. Pure functions, so the merge rules are tested without a socket or a map.

export type Fleet = ReadonlyMap<string, VehicleLocation>

const time = (iso: string) => Date.parse(iso)

/**
 * A fresh snapshot, keeping any position the socket brought that is newer than the snapshot's (the
 * snapshot may be a few seconds old: it is cached). Vehicles missing from it are gone: out of the
 * depot chosen, retired, or off their trip with no position.
 */
export function mergeSnapshot(previous: Fleet, snapshot: readonly VehicleLocation[]): Map<string, VehicleLocation> {
  const next = new Map<string, VehicleLocation>()
  for (const fresh of snapshot) {
    const known = previous.get(fresh.vehicle_id)?.position
    const newer = known && (!fresh.position || time(known.recorded_at) > time(fresh.position.recorded_at))
    next.set(fresh.vehicle_id, newer ? { ...fresh, position: known } : fresh)
  }
  return next
}

/**
 * The socket's positions, applied to the vehicles they are about. A position older than the one shown
 * is late and dropped. Returns the vehicles that need a fresh snapshot: unknown ones (a vehicle that
 * just started reporting) and ones whose trip changed (started, ended).
 */
export function applyPositions(fleet: Fleet, updates: readonly LocationUpdate[]): { fleet: Map<string, VehicleLocation>; changed: boolean; stale: string[] } {
  const next = new Map(fleet)
  const stale: string[] = []
  let changed = false
  for (const u of updates) {
    const vehicle = next.get(u.vehicle_id)
    if (!vehicle) {
      stale.push(u.vehicle_id)
      continue
    }
    if ((vehicle.trip?.trip_id ?? null) !== (u.trip_id ?? null)) stale.push(u.vehicle_id)
    const prev = vehicle.position
    if (prev && time(u.recorded_at) <= time(prev.recorded_at)) continue
    const stoppedSince = u.speed !== 0 ? null : prev?.speed_kmh === 0 ? (prev.stopped_since ?? prev.recorded_at) : u.recorded_at
    next.set(u.vehicle_id, {
      ...vehicle,
      position: {
        lat: u.lat,
        lng: u.lng,
        speed_kmh: u.speed,
        heading: u.heading,
        accuracy_m: null,
        ignition_on: prev?.ignition_on ?? null,
        recorded_at: u.recorded_at,
        stopped_since: stoppedSince,
      },
    })
    changed = true
  }
  return { fleet: next, changed, stale }
}

export const isSpeeding = (v: VehicleLocation) => v.flags.some((f) => f.flag_type === 'speeding')

/** "Bole - Adama", or the trip's own origin and destination when it has no route. */
export function routeLabel(trip: LiveTrip | null): string | null {
  if (!trip) return null
  if (trip.route_name) return trip.route_name
  if (trip.origin && trip.destination) return `${trip.origin} → ${trip.destination}`
  return trip.origin ?? trip.destination
}

/** A vehicle as the map draws it; null while it has no position. */
export function toMapVehicle(v: VehicleLocation): FleetMapVehicle | null {
  if (!v.position) return null
  const details: { label: string; value: string }[] = []
  if (v.trip) {
    details.push({ label: 'Driver', value: v.trip.driver?.full_name ?? 'Not assigned' })
    const route = routeLabel(v.trip)
    if (route) details.push({ label: 'Route', value: route })
  }
  return {
    vehicleId: v.vehicle_id,
    lat: v.position.lat,
    lng: v.position.lng,
    speedKmh: v.position.speed_kmh,
    heading: v.position.heading,
    lastSeen: v.position.recorded_at,
    stoppedSince: v.position.stopped_since,
    plateNumber: v.registration_number,
    speeding: isSpeeding(v),
    details,
  }
}

/** What the list says about a vehicle: the map's state, or that it has not reported yet. */
export type LiveState = MarkerState | 'no_signal'

export function liveState(v: VehicleLocation, now: number): LiveState {
  const mapped = toMapVehicle(v)
  if (!mapped) return 'no_signal'
  return markerState(mapped, now, mapped.stoppedSince ? time(mapped.stoppedSince) : null)
}

/** States a dispatcher should look at: the "Needs attention" view. */
const ATTENTION: ReadonlySet<LiveState> = new Set<LiveState>(['breakdown', 'speeding', 'offline', 'no_signal', 'idling'])

export const needsAttention = (state: LiveState) => ATTENTION.has(state)

/** By plate: the list keeps its order while states change under it. */
export const byPlate = (a: VehicleLocation, b: VehicleLocation) => a.registration_number.localeCompare(b.registration_number)
