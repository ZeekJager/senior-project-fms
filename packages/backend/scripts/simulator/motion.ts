// Movement for the GPS simulator (FMS-88): a vehicle drives along a route's points, back and forth, at a
// speed its scenario sets. Pure functions: no clock, no network; the randomness is passed in.

export interface Point {
  lat: number;
  lng: number;
}

/** What the simulated driver does: normal traffic, over the limit (FMS-46's speeding rule), or stopped with the engine on. */
export type Scenario = 'normal' | 'speeding' | 'idling';

export interface VehicleState {
  path: Point[];
  /** Kilometres travelled along the path from its first point. */
  at: number;
  /** +1 forwards, -1 on the way back. */
  direction: 1 | -1;
  scenario: Scenario;
}

const EARTH_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Initial compass bearing from a to b, 0-360 (0 is north). */
export function bearing(a: Point, b: Point): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const pathLength = (path: Point[]) => path.slice(1).reduce((sum, p, i) => sum + distanceKm(path[i], p), 0);

/** The point `km` along the path and the heading there (straight lines between points; fine at city scale). */
export function pointAlong(path: Point[], km: number): { position: Point; heading: number } {
  let left = Math.max(0, km);
  for (let i = 1; i < path.length; i++) {
    const leg = distanceKm(path[i - 1], path[i]);
    if (left <= leg || i === path.length - 1) {
      const f = leg === 0 ? 0 : Math.min(1, left / leg);
      return {
        position: { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * f, lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * f },
        heading: bearing(path[i - 1], path[i]),
      };
    }
    left -= leg;
  }
  return { position: path[0], heading: 0 };
}

/** km/h for a scenario: city traffic 25-70, speeding 95-115 (the limit is 80), idling 0. */
export function speedFor(scenario: Scenario, random: () => number): number {
  if (scenario === 'idling') return 0;
  if (scenario === 'speeding') return 95 + random() * 20;
  return 25 + random() * 45;
}

/**
 * Moves a vehicle by one tick of `seconds` and returns its new state and the ping it sends: position,
 * heading of travel (reversed on the way back), speed with one decimal as a device would send it.
 */
export function step(state: VehicleState, seconds: number, random: () => number): { state: VehicleState; ping: Point & { speed_kmh: number; heading: number } } {
  const speed = speedFor(state.scenario, random);
  const total = pathLength(state.path);
  let at = state.at + state.direction * ((speed * seconds) / 3600);
  let direction = state.direction;
  if (at >= total) [at, direction] = [total - (at - total), -1];
  if (at <= 0) [at, direction] = [-at, 1];
  at = Math.min(Math.max(at, 0), total);
  const { position, heading } = pointAlong(state.path, at);
  return {
    state: { ...state, at, direction },
    ping: { ...position, speed_kmh: Math.round(speed * 10) / 10, heading: Math.round((direction === 1 ? heading : (heading + 180) % 360) * 10) / 10 },
  };
}

/** A small loop around a point (about 1 km each side), for a vehicle whose depot has no route with coordinates. */
export function loopAround(centre: Point): Point[] {
  const d = 0.009;
  return [
    centre,
    { lat: centre.lat + d, lng: centre.lng },
    { lat: centre.lat + d, lng: centre.lng + d },
    { lat: centre.lat, lng: centre.lng + d },
    centre,
  ];
}

/** Picks each vehicle's scenario: the given shares speed and idle, the rest drive normally. */
export function scenarioFor(index: number, total: number, shares: { speeding: number; idling: number }): Scenario {
  const speeding = Math.round(total * shares.speeding);
  const idling = Math.round(total * shares.idling);
  if (index < speeding) return 'speeding';
  if (index < speeding + idling) return 'idling';
  return 'normal';
}
