// The live map's data (FMS-45): GET /tracking/vehicles/current and the socket's vehicle.location.updated
// (api-contract §11, docs/realtime.md).

export interface VehiclePosition {
  lat: number
  lng: number
  /** Whole km/h. */
  speed_kmh: number
  heading: number | null
  accuracy_m: number | null
  ignition_on: boolean | null
  recorded_at: string
  /** When it stopped, while at 0 km/h. */
  stopped_since: string | null
}

export interface LiveTrip {
  trip_id: string
  route_name: string | null
  origin: string | null
  destination: string | null
  started_at: string | null
  scheduled_end: string | null
  driver: { driver_id: string; full_name: string | null } | null
}

/** One vehicle on the live map. */
export interface VehicleLocation {
  vehicle_id: string
  registration_number: string
  vehicle_type: string
  vehicle_status: string
  maintenance_flag: boolean
  depot_id: string | null
  /** Null for a vehicle on a trip that has not reported yet. */
  position: VehiclePosition | null
  trip: LiveTrip | null
  /** Open telemetry flags (speeding, idling; FMS-46). */
  flags: { flag_type: string; severity: string; observed_at: string }[]
}

/** The socket's vehicle.location.updated: a vehicle's newest position, at most one per 5 s. */
export interface LocationUpdate {
  vehicle_id: string
  depot_id: string | null
  trip_id: string | null
  lat: number
  lng: number
  speed: number
  heading: number | null
  recorded_at: string
}
