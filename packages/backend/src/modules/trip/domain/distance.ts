/**
 * How far a trip went (FMS-145, docs/trip-distance.md): from the positions the vehicle reported between its start and
 * its end. The odometer the vehicle's own device reports when it brackets the trip, else the length of the GPS track,
 * else nothing: a trip is never given its planned distance as if it had driven it. Pure, so it is unit-tested.
 */
import { metresBetween } from './eta';

/** A stored position of the trip's vehicle, in time order. */
export interface TrackPoint {
  /** When it was recorded, epoch ms. */
  at: number;
  latitude: number;
  longitude: number;
  speedKmh: number;
  /** The odometer sent with it; trusted only from the vehicle's own device or telematics provider. */
  odometerKm: number | null;
  source: string;
}

export type DistanceSource = 'odometer' | 'gps';

/** Why a trip has no distance: fewer than two positions between its start and its end. */
export type NoDistance = 'no_positions';

export type TripDistance =
  | { km: number; source: DistanceSource; points: number }
  | { km: null; reason: NoDistance; points: number };

/** The sources whose odometer is the vehicle's own (meter-readings.md): a phone has none, a typed number is not one. */
export const ODOMETER_SOURCES: ReadonlySet<string> = new Set(['device', 'telematics']);

/** How close to the trip's start and end the first and last odometer readings must be to bracket it. */
export const ODOMETER_EDGE_MS = 5 * 60_000;

/**
 * Faster than this between two positions is a jump no road vehicle makes: a GPS glitch, not travel. Ingestion
 * accepts reported speeds up to 300 km/h (gps-ingestion.md); the jump test is on the speed the two positions imply.
 */
export const MAX_PLAUSIBLE_KMH = 180;

/** Odometer readings may wobble by a rounding step without the meter going backwards. */
const ODOMETER_TOLERANCE_KM = 0.1;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The speed two positions imply, km/h; Infinity for two at the same instant in different places. */
function impliedKmh(a: TrackPoint, b: TrackPoint): number {
  const metres = metresBetween(a, b);
  const ms = Math.abs(b.at - a.at);
  if (ms === 0) return metres === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (metres / 1000) / (ms / 3_600_000);
}

const plausible = (a: TrackPoint, b: TrackPoint) => impliedKmh(a, b) <= MAX_PLAUSIBLE_KMH;

/**
 * The odometer difference, when the vehicle's own readings bracket the trip (the first within ODOMETER_EDGE_MS
 * of the start, the last of the end), never go backwards, and imply no impossible speed. Null otherwise.
 */
export function odometerDistance(points: readonly TrackPoint[], start: number, end: number): number | null {
  const readings = points.filter((p) => p.odometerKm !== null && ODOMETER_SOURCES.has(p.source));
  if (readings.length < 2) return null;
  const first = readings[0];
  const last = readings[readings.length - 1];
  if (first.at - start > ODOMETER_EDGE_MS || end - last.at > ODOMETER_EDGE_MS) return null;
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].odometerKm! < readings[i - 1].odometerKm! - ODOMETER_TOLERANCE_KM) return null;
  }
  const km = Math.max(0, last.odometerKm! - first.odometerKm!);
  const hours = (last.at - first.at) / 3_600_000;
  if (km > MAX_PLAUSIBLE_KMH * hours + ODOMETER_TOLERANCE_KM) return null;
  return round3(km);
}

/**
 * The positions left once glitches are dropped: a position is a glitch when it is an impossible jump from both its
 * neighbours (or, at either end, from its neighbour while that neighbour and the next agree).
 */
export function withoutGlitches(points: readonly TrackPoint[]): TrackPoint[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    if (prev && next) return plausible(prev, p) || plausible(p, next) || !plausible(prev, next);
    const neighbour = prev ?? next;
    if (!neighbour) return true;
    if (plausible(neighbour, p)) return true;
    const beyond = prev ? points[i - 2] : points[i + 2];
    return !(beyond && plausible(beyond, neighbour));
  });
}

/**
 * The length of the track in km: each step from one position to the next, except a step both ends of which report
 * the vehicle standing still (GPS drifts while parked) and a step no vehicle could make. A gap with no positions
 * counts as the straight line across it, so a track with gaps is short, never long.
 */
export function trackDistance(points: readonly TrackPoint[]): number {
  const kept = withoutGlitches(points);
  let metres = 0;
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1];
    const b = kept[i];
    if (a.speedKmh === 0 && b.speedKmh === 0) continue;
    if (!plausible(a, b)) continue;
    metres += metresBetween(a, b);
  }
  return round3(metres / 1000);
}

/** How far a trip went from its positions between `start` and `end` (epoch ms), oldest first. */
export function measureTrip(points: readonly TrackPoint[], start: number, end: number): TripDistance {
  const inside = points.filter((p) => p.at >= start && p.at <= end).sort((a, b) => a.at - b.at);
  const odometer = odometerDistance(inside, start, end);
  if (odometer !== null) return { km: odometer, source: 'odometer', points: inside.length };
  if (inside.length < 2) return { km: null, reason: 'no_positions', points: inside.length };
  return { km: trackDistance(inside), source: 'gps', points: inside.length };
}
