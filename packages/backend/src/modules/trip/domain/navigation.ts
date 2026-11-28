/**
 * Driver navigation (FMS-166, docs/driver-navigation.md): the waypoints a trip under way still has to reach, the road
 * there from where the driver is, and each turn in plain words. Pure, so it is unit-tested; the road comes from the
 * routing engine (infrastructure/osrm.planner.ts).
 */
import type { Coordinates } from './route';
import type { LineString } from './road';

/** A place still to reach: a stop not yet completed, or the trip's destination. */
export interface NavigationWaypoint {
  kind: 'stop' | 'destination';
  /** The stop's id; null for the destination. */
  stop_id: string | null;
  sequence_number: number | null;
  name: string;
  lat: number;
  lng: number;
}

/** One turn of the road, as OSRM's step gives it: what to do, onto which road, and how far it lasts. */
export interface RoadStep {
  /** OSRM's maneuver type: depart, turn, new name, continue, merge, on ramp, off ramp, fork, end of road, roundabout, rotary, exit roundabout, exit rotary, arrive… */
  type: string;
  /** left, right, slight left, sharp right, straight, uturn; absent for some types. */
  modifier: string | null;
  /** The road's name; empty when it has none. */
  road: string;
  /** For a roundabout or rotary: which exit. */
  exit: number | null;
  distanceM: number;
  durationS: number;
  /** Where the maneuver happens. */
  latitude: number;
  longitude: number;
}

/** The road from the driver through the waypoints, as the routing engine answered. */
export interface NavigationRoad {
  distanceKm: number;
  durationSeconds: number;
  geometry: LineString;
  /** Every leg's steps, in order; the last is the arrival at the destination. */
  steps: RoadStep[];
}

/** Why there is no road on screen: the screen then shows the destination and the straight line. */
export type NoRoadReason = 'no_origin' | 'no_waypoints' | 'routing_not_configured' | 'routing_unavailable' | 'no_road';

/** A stop as the trip holds it. */
export interface TripStopPlace {
  id: string;
  sequence_number: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: 'planned' | 'arrived' | 'completed' | 'skipped';
}

/**
 * The waypoints left, in travel order: the stops not completed or skipped that have coordinates, then the destination
 * when it has coordinates. A stop the vehicle reached but the driver has not marked done is still on the way: the
 * driver may still be there.
 */
export function remainingWaypoints(stops: readonly TripStopPlace[], destination: (Coordinates & { name: string }) | null): NavigationWaypoint[] {
  const left: NavigationWaypoint[] = [...stops]
    .sort((a, b) => a.sequence_number - b.sequence_number)
    .filter((s) => (s.status === 'planned' || s.status === 'arrived') && s.latitude !== null && s.longitude !== null)
    .map((s) => ({ kind: 'stop', stop_id: s.id, sequence_number: s.sequence_number, name: s.name, lat: s.latitude!, lng: s.longitude! }));
  if (destination) left.push({ kind: 'destination', stop_id: null, sequence_number: null, name: destination.name, lat: destination.latitude, lng: destination.longitude });
  return left;
}

const toRad = (d: number) => (d * Math.PI) / 180;

/** The initial compass bearing from `a` to `b`, whole degrees, 0 = north, clockwise. */
export function bearingDegrees(a: Coordinates, b: Coordinates): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** A bearing as a compass word: 0-22 north, 23-67 north-east, and so on. */
export function compass(bearing: number): (typeof COMPASS)[number] {
  return COMPASS.at(Math.round((((bearing % 360) + 360) % 360) / 45) % 8)!;
}

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** "left", "slight right", "a U-turn"… as a direction word. */
function direction(modifier: string | null): string {
  if (!modifier) return '';
  if (modifier === 'uturn') return 'a U-turn';
  return modifier;
}

/**
 * One step as a driver reads it: "Turn left onto Ring Road", "Keep right", "At the roundabout, take the 2nd exit onto
 * Bole Road", "Arrive at Adama". `arriveAt` names the waypoint an arrive step reaches.
 */
export function instruction(step: Pick<RoadStep, 'type' | 'modifier' | 'road' | 'exit'>, arriveAt?: string): string {
  const onto = step.road ? ` onto ${step.road}` : '';
  const on = step.road ? ` on ${step.road}` : '';
  const dir = direction(step.modifier);
  switch (step.type) {
    case 'depart':
      return `Head off${on}`;
    case 'arrive':
      return arriveAt ? `Arrive at ${arriveAt}` : 'Arrive at your destination';
    case 'turn':
    case 'end of road':
      if (step.modifier === 'uturn') return `Make a U-turn${onto}`;
      if (step.modifier === 'straight') return `Go straight${onto}`;
      return `Turn ${dir}${onto}`;
    case 'continue':
    case 'new name':
      if (!step.modifier || step.modifier === 'straight') return `Continue${on || ' straight'}`;
      return step.modifier === 'uturn' ? `Make a U-turn${onto}` : `Keep ${dir}${onto}`;
    case 'merge':
      return `Merge${dir ? ` ${dir}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${dir ? ` on the ${dir}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${dir ? ` on the ${dir}` : ''}${onto}`;
    case 'fork':
      return `Keep ${dir || 'straight'} at the fork${onto}`;
    case 'roundabout':
    case 'rotary':
      return step.exit ? `At the roundabout, take the ${ORDINAL(step.exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Leave the roundabout${onto}`;
    default:
      return dir ? `Go ${dir}${onto}` : `Continue${on}`;
  }
}
