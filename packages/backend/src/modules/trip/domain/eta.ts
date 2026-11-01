import type { Coordinates } from './route';

// Live arrival times (FMS-86, docs/eta.md): from a trip's newest position, which of its stops it has reached and
// the road to the rest. Pure, so it is unit-tested apart from the routing engine and the database.

/**
 * A trip's estimate is worked out again at most once per this many seconds of position time (acceptance: 30 s).
 * Position time, not the clock: the same pings give the same estimates, however late they are delivered.
 */
export const ETA_INTERVAL_SECONDS = 30;

/** A vehicle this close to a stop (or its destination) has reached it: a GPS fix and the stop's pin both drift. */
export const ARRIVAL_RADIUS_M = 150;

/** A position older than this when it is handled says too little about now: no estimate is made from it. */
export const MAX_POSITION_AGE_MS = 5 * 60_000;

/** The event the estimate follows (GPS ingestion, FMS-88). Named here: trip cannot import the integration module. */
export const LOCATION_UPDATED = 'VehicleLocationUpdated';

/** Published after each new estimate; the real-time gateway sends it as `trip.updated` (api-contract §11.2). */
export const TRIP_ETA_UPDATED = 'TripEtaUpdated';

/** A stop of the trip as the estimate sees it, in travel order. */
export interface EtaStop {
  id: string;
  sequenceNumber: number;
  coordinates: Coordinates | null;
  /** Set once the vehicle has been there. */
  actualArrival: Date | null;
}

/** What the routing engine is asked: the vehicle's position, then each stop still ahead with coordinates, then the destination. */
export interface EtaRequest {
  /** Stops reached at this position, in travel order. */
  reached: string[];
  /** The stops still ahead that can be routed to, in travel order. */
  ahead: { id: string; coordinates: Coordinates }[];
  /** The destination, unless the route has no coordinates for it or the vehicle is there. */
  destination: Coordinates | null;
  /** Within ARRIVAL_RADIUS_M of the destination. */
  atDestination: boolean;
}

/** One leg the routing engine measured, between consecutive points. */
export interface Leg {
  distanceKm: number;
  durationSeconds: number;
}

export interface EtaResult {
  /** When the vehicle is expected at each stop ahead. */
  stops: { id: string; eta: Date }[];
  /** At the destination; null without destination coordinates. */
  arrivalAt: Date | null;
  remainingKm: number;
  remainingSeconds: number;
}

const EARTH_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function metresBetween(a: Coordinates, b: Coordinates): number {
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Where the trip stands at `position`. The stops ahead are those after the last one reached: a stop the vehicle
 * passed without coming near it is behind it once a later one is reached, never routed back to. Of the stops
 * ahead, the first the vehicle is within ARRIVAL_RADIUS_M of is reached now (with any between it and the last
 * reached left behind). Stops without coordinates have no estimate and are not routed to.
 */
export function etaRequest(position: Coordinates, stops: readonly EtaStop[], destination: Coordinates | null): EtaRequest {
  const ordered = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  let lastReached = -1;
  ordered.forEach((s, i) => {
    if (s.actualArrival) lastReached = i;
  });
  const reached: string[] = [];
  const near = ordered.findIndex((s, i) => i > lastReached && s.coordinates !== null && metresBetween(position, s.coordinates) <= ARRIVAL_RADIUS_M);
  if (near !== -1) {
    reached.push(ordered[near].id);
    lastReached = near;
  }
  const atDestination = destination !== null && metresBetween(position, destination) <= ARRIVAL_RADIUS_M;
  const ahead = atDestination
    ? []
    : ordered.slice(lastReached + 1).flatMap((s) => (s.coordinates ? [{ id: s.id, coordinates: s.coordinates }] : []));
  return { reached, ahead, destination: atDestination ? null : destination, atDestination };
}

/** The points to route through, in order: the position, the stops ahead, the destination. */
export function waypointsFor(position: Coordinates, request: EtaRequest): Coordinates[] {
  return [position, ...request.ahead.map((s) => s.coordinates), ...(request.destination ? [request.destination] : [])];
}

/**
 * Arrival times from the legs the routing engine measured (one per consecutive pair of waypointsFor), counted
 * from when the vehicle was at the position. At the destination: arrived at the position's time, nothing left.
 */
export function etaFrom(request: EtaRequest, legs: readonly Leg[], positionAt: Date): EtaResult {
  if (request.atDestination) return { stops: [], arrivalAt: positionAt, remainingKm: 0, remainingSeconds: 0 };
  const at = (seconds: number) => new Date(positionAt.getTime() + Math.round(seconds) * 1000);
  let seconds = 0;
  let km = 0;
  const stops = request.ahead.map((s, i) => {
    seconds += legs[i].durationSeconds;
    km += legs[i].distanceKm;
    return { id: s.id, eta: at(seconds) };
  });
  if (request.destination) {
    const last = legs[request.ahead.length];
    seconds += last.durationSeconds;
    km += last.distanceKm;
  }
  return { stops, arrivalAt: request.destination ? at(seconds) : null, remainingKm: Math.round(km * 1000) / 1000, remainingSeconds: Math.round(seconds) };
}
