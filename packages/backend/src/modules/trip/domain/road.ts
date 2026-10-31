import type { Coordinates, RouteStop } from './route';

// The road a route follows (FMS-84, docs/routing.md): measured by the routing engine (OSRM) through its
// waypoints, kept simplified on the route as GeoJSON, and drawn on the maps.

/** GeoJSON LineString: [longitude, latitude] pairs, as GeoJSON orders them. */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

/** What the routing engine found for a route's waypoints. */
export interface RoadPlan {
  distanceKm: number;
  durationSeconds: number;
  geometry: LineString;
}

/** How the distance on a route was obtained: measured along the road, or typed in by a person. */
export type DistanceSource = 'road' | 'manual';

/** A road is kept to within this many metres of the engine's full line: plenty for a map, a fraction of the points. */
export const ROAD_TOLERANCE_METRES = 15;

/** OSRM's limit on waypoints (`--max-viaroute-size` in docker-compose.yml): origin, 25 stops, destination fit. */
export const MAX_WAYPOINTS = 30;

/**
 * The points a route passes, in order: origin, the stops that have coordinates, destination. Null without both
 * ends: there is nothing to measure.
 */
export function waypointsOf(origin: Coordinates | null, stops: readonly RouteStop[], destination: Coordinates | null): Coordinates[] | null {
  if (!origin || !destination) return null;
  const via = stops.filter((s): s is RouteStop & Coordinates => s.latitude !== null && s.longitude !== null);
  return [origin, ...via.map((s) => ({ latitude: s.latitude, longitude: s.longitude })), destination];
}

/** A stable text for a list of waypoints (the cache key; 6 decimals, as the columns store them). */
export function waypointKey(points: readonly Coordinates[]): string {
  return points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
}

const EARTH_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle length of a line, in km. */
export function lineLengthKm(line: LineString): number {
  let metres = 0;
  for (let i = 1; i < line.coordinates.length; i++) {
    const [lng1, lat1] = line.coordinates[i - 1];
    const [lng2, lat2] = line.coordinates[i];
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    metres += 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return metres / 1000;
}

/**
 * Douglas-Peucker within `toleranceMetres`, on a local flat projection (exact enough across a country), with
 * coordinates rounded to 5 decimals (about a metre). Keeps both ends; iterative, so a long road cannot overflow
 * the stack.
 */
export function simplifyLine(line: LineString, toleranceMetres = ROAD_TOLERANCE_METRES): LineString {
  const pts = line.coordinates;
  if (pts.length <= 2) return { type: 'LineString', coordinates: pts.map(round5) };
  const midLat = rad(pts.reduce((sum, p) => sum + p[1], 0) / pts.length);
  const xy = pts.map(([lng, lat]) => [rad(lng) * Math.cos(midLat) * EARTH_M, rad(lat) * EARTH_M] as const);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = toleranceMetres;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(xy[i], xy[first], xy[last]);
      if (d > farthestDistance) {
        farthest = i;
        farthestDistance = d;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const out: [number, number][] = [];
  pts.forEach((p, i) => {
    if (!keep[i]) return;
    const r = round5(p);
    const prev = out.at(-1);
    if (!prev || prev[0] !== r[0] || prev[1] !== r[1]) out.push(r);
  });
  return { type: 'LineString', coordinates: out };
}

function round5([lng, lat]: [number, number]): [number, number] {
  return [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}

function distanceToSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
