// What a vehicle's marker shows, worked out from its last ping (FMS-44).
// Pure functions, so the thresholds are tested without a map.

/** One vehicle on the map: its last known position, as the parent (the Fleet Command Center, FMS-45) passes it. */
export interface FleetMapVehicle {
  vehicleId: string
  lat: number
  lng: number
  /** Whole km/h from the last ping; `null` when the ping carried no speed. */
  speedKmh: number | null
  /** ISO time of the last ping (`recorded_at` of `vehicle.location.updated`). */
  lastSeen: string
  plateNumber?: string
  /** Degrees clockwise from north; points the marker's arrow while moving. */
  heading?: number | null
  /** When the vehicle stopped, if the server knows (the idling rule, FMS-46). Otherwise the map counts from the first stopped ping it saw. */
  stoppedSince?: string | null
  /** A breakdown is reported for the vehicle (FMS-50). */
  breakdown?: boolean
  /** An open speeding flag (the telemetry rules, FMS-46): the marker pulses red. */
  speeding?: boolean
  /** More about the vehicle for its popup, such as the driver and the route (the Fleet Command Center, FMS-45). */
  details?: readonly { label: string; value: string }[]
}

export type MarkerState = 'moving' | 'stopped' | 'idling' | 'speeding' | 'breakdown' | 'offline'

/** No ping for longer than this: the position is stale and the marker turns grey. */
export const OFFLINE_AFTER_MS = 2 * 60_000
/** Stopped (0 km/h) for longer than this: idling, amber. */
export const IDLE_AFTER_MS = 5 * 60_000

export const STATE_LABELS: Record<MarkerState, string> = {
  moving: 'Moving',
  stopped: 'Stopped',
  idling: 'Idling',
  speeding: 'Speeding',
  breakdown: 'Breakdown',
  offline: 'Offline',
}

/**
 * A breakdown shows above everything, because someone has to act on it even when the phone has gone quiet.
 * Then offline (the rest would describe a position that is out of date), then speeding, then idling, then
 * stopped or moving.
 */
export function markerState(vehicle: FleetMapVehicle, now: number, stoppedSince: number | null): MarkerState {
  if (vehicle.breakdown) return 'breakdown'
  const seen = Date.parse(vehicle.lastSeen)
  if (Number.isNaN(seen) || now - seen > OFFLINE_AFTER_MS) return 'offline'
  if (vehicle.speeding) return 'speeding'
  if (vehicle.speedKmh !== 0) return 'moving'
  return stoppedSince !== null && now - stoppedSince > IDLE_AFTER_MS ? 'idling' : 'stopped'
}

/**
 * Keeps, per vehicle, when it was first seen stopped: the time of the first 0 km/h ping in a run of them.
 * A ping with any speed (or none) ends the run. The server's `stoppedSince` wins when given.
 * Returns the updated map; the caller keeps it between renders.
 */
export function trackStops(previous: ReadonlyMap<string, number>, vehicles: readonly FleetMapVehicle[]): Map<string, number> {
  const next = new Map<string, number>()
  for (const v of vehicles) {
    const fromServer = v.stoppedSince ? Date.parse(v.stoppedSince) : NaN
    if (!Number.isNaN(fromServer)) next.set(v.vehicleId, fromServer)
    else if (v.speedKmh === 0) {
      const seen = Date.parse(v.lastSeen)
      const since = previous.get(v.vehicleId) ?? seen
      if (!Number.isNaN(since)) next.set(v.vehicleId, since)
    }
  }
  return next
}

/** "Just now", "45 s ago", "3 min ago", "2 h ago", or the date for anything older than a day. */
export function lastSeenLabel(lastSeen: string, now: number): string {
  const at = Date.parse(lastSeen)
  if (Number.isNaN(at)) return 'Never'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
