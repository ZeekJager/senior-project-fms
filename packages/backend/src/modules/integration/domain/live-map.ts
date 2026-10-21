// The live map's snapshot (FMS-45, api-contract §11.1): GET /tracking/vehicles/current. The Fleet Command
// Center loads it once, then moves markers with the socket's vehicle.location.updated (docs/realtime.md).

/**
 * How long a snapshot is served from the cache (Redis). Positions move on meanwhile through the socket,
 * and trip and vehicle changes drop it at once (index.ts), so the cache only spares the database when
 * many screens open together.
 */
export const LIVE_MAP_CACHE_TTL_SECONDS = 5;

/** A stopped vehicle's stop is looked for this far back from its current position. */
export const STOPPED_LOOKBACK_HOURS = 2;

/** One vehicle on the live map: where it is, the trip it is on, and its open telemetry flags. */
export interface VehicleLocation {
  vehicle_id: string;
  registration_number: string;
  vehicle_type: string;
  vehicle_status: string;
  maintenance_flag: boolean;
  depot_id: string | null;
  /** Its newest position; null for a vehicle on a trip that has not reported yet. */
  position: {
    lat: number;
    lng: number;
    speed_kmh: number;
    heading: number | null;
    accuracy_m: number | null;
    ignition_on: boolean | null;
    recorded_at: string;
    /** When it stopped, if it is at 0 km/h (the map's idling, over 5 minutes). */
    stopped_since: string | null;
  } | null;
  /** Its trip under way, if any. */
  trip: {
    trip_id: string;
    route_name: string | null;
    origin: string | null;
    destination: string | null;
    started_at: string | null;
    scheduled_end: string | null;
    driver: { driver_id: string; full_name: string | null } | null;
  } | null;
  /** Open telemetry flags (speeding, idling; FMS-46), the newest of each type. */
  flags: { flag_type: string; severity: string; observed_at: string }[];
}
