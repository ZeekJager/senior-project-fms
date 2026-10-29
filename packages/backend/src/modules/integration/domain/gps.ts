import { AppError } from '../../../shared/errors/app-error';

// GPS pings (FMS-88, api-contract §11.1): positions from devices, drivers' phones and telematics
// providers, one path into tracking.gps_pings.

/** At most this many pings in one request or webhook delivery. */
export const MAX_PINGS_PER_BATCH = 500;
/** A ping stamped more than this ahead of the server clock is refused (a device clock that is wrong). */
export const MAX_FUTURE_SKEW_MS = 2 * 60_000;
/** A ping older than this is refused: a phone that was offline for longer has nothing live to say. */
export const MAX_PING_AGE_MS = 7 * 24 * 3_600_000;
/** A fix less precise than this (metres) is refused: it would draw the vehicle in the wrong street. */
export const MAX_ACCURACY_M = 500;
/** Faster than any vehicle on the road: a bad reading. */
export const MAX_SPEED_KMH = 300;

/** One position as received, before checks. Speed may be fractional; it is rounded (api-contract §17). */
export interface PingInput {
  /** Public id; a device's and a phone's are implied by who reports. */
  vehicle_id?: string;
  /** A telematics provider's device identifier, for webhook positions. */
  device_id?: string;
  recorded_at: string;
  lat: number;
  lng: number;
  speed_kmh: number;
  heading?: number | null;
  accuracy_m?: number | null;
  altitude_m?: number | null;
  ignition_on?: boolean | null;
  odometer_km?: number | null;
}

/** Why one ping of a batch was not stored; the rest of the batch is. */
export type PingRejection =
  | 'future_timestamp'
  | 'too_old'
  | 'low_accuracy'
  | 'unknown_vehicle'
  | 'unknown_device'
  | 'vehicle_retired'
  /** A driver's phone, at a time when the driver had no trip under way (FMS-124). */
  | 'no_trip_at_time';

/** When a trip was driven: from its actual start to its actual end, or open-ended while it is under way. */
export interface TripWindow {
  actualStart: Date;
  actualEnd: Date | null;
}

/**
 * The trip a position recorded at `at` (ms) belongs to (FMS-124): the one driven then, from its actual start to
 * its actual end, both included; one still under way has no end. If two overlap, the one that started last (a
 * trip that began as the previous one was being closed). A ping before a trip began or after it ended is in no
 * trip: nobody back-fills a position outside a trip they drove.
 */
export function tripAt<T extends TripWindow>(trips: readonly T[], at: number): T | null {
  let found: T | null = null;
  for (const trip of trips) {
    if (trip.actualStart.getTime() > at) continue;
    if (trip.actualEnd !== null && trip.actualEnd.getTime() < at) continue;
    if (!found || trip.actualStart.getTime() >= found.actualStart.getTime()) found = trip;
  }
  return found;
}

/** Integer km/h, as stored: fractional provider values are rounded to the nearest (api-contract §17). */
export const roundSpeed = (kmh: number) => Math.round(kmh);

/** The checks that refuse one ping and keep the rest. Shape and ranges are checked before (400 for the batch). */
export function pingProblem(ping: Pick<PingInput, 'recorded_at' | 'accuracy_m'>, now: number): PingRejection | null {
  const at = Date.parse(ping.recorded_at);
  if (at - now > MAX_FUTURE_SKEW_MS) return 'future_timestamp';
  if (now - at > MAX_PING_AGE_MS) return 'too_old';
  if (ping.accuracy_m != null && ping.accuracy_m > MAX_ACCURACY_M) return 'low_accuracy';
  return null;
}

export const TRACKING_EVENTS = {
  /**
   * A vehicle's current position moved (FMS-88): at most one per vehicle per throttle interval.
   * The real-time gateway forwards it as `vehicle.location.updated` (docs/realtime.md).
   */
  locationUpdated: 'VehicleLocationUpdated',
  /** The telemetry rules (FMS-46) opened a speeding or idling flag; the alert engine makes it an alert. */
  flagRaised: 'TelemetryFlagRaised',
  /** Its condition ended: back under the limit, moving again, engine off, or no signal. */
  flagResolved: 'TelemetryFlagResolved',
} as const;

/** Where a batch came from: stored as gps_pings.source. */
export type PingSource = 'device' | 'phone' | 'api' | 'telematics';

/** A device (or a phone) naming a vehicle that is not the one it may report for: the whole batch is refused. */
export const notYourVehicle = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'This device may report positions for its own vehicle only.', [{ field: 'vehicle_id', reason: 'not_your_vehicle' }]);

export const phoneNotOnTrip = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', "A driver's phone reports positions only while their trip is under way.", [{ reason: 'no_trip_under_way' }]);

/** A legacy socket update naming a trip that is not the driver's trip under way. */
export const notYourTrip = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Positions are accepted for your own trip under way only.', [{ field: 'tripId', reason: 'not_your_trip' }]);

export const deviceTokenInvalid = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'The device token is not valid.');
