// The geometry of geofences and route deviation (FMS-90, docs/geofences.md): whether a GPS fix is inside a
// polygon, and how far it is from a route's road. Pure and in metres; no PostGIS. A fix is near enough to a
// polygon or road for a flat projection about the fix to be exact to well under a metre.

/** GeoJSON Polygon: one ring, [longitude, latitude] pairs, closed (the last position repeats the first). */
export interface Polygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

/** GeoJSON LineString, as a route's road is stored (trip.routes.geometry, FMS-84). */
export interface LineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface Point {
  lat: number;
  lng: number;
}

/** The smallest box around a polygon, to rule a fix out without walking the ring. */
export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Corners a geofence may have: enough for a city's ring road, few enough to check every ping against. */
export const MAX_POLYGON_POINTS = 500;
/** A geofence smaller than this (about 20 m by 20 m) is a GPS fix's error, not a place. */
export const MIN_POLYGON_AREA_M2 = 400;
/** And none wider than this: a fence is a place, and the flat projection stays exact within it. */
export const MAX_POLYGON_SPAN_KM = 500;

const EARTH_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Why a polygon cannot be a geofence, as the API's `reason`. */
export type PolygonProblem = 'too_few_points' | 'too_many_points' | 'out_of_range' | 'self_intersecting' | 'too_small' | 'too_large';

/** The ring without its closing position: each corner once. */
export function corners(polygon: Polygon): [number, number][] {
  const ring = polygon.coordinates[0] ?? [];
  if (ring.length > 1 && samePosition(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring;
}

/**
 * The polygon as stored: one ring of the given corners, rounded to 6 decimals (about 10 cm, as GPS fixes are
 * stored), repeated corners dropped and the ring closed. Whether the ring was closed when sent does not matter.
 */
export function normalizePolygon(polygon: Polygon): Polygon {
  const out: [number, number][] = [];
  for (const [lng, lat] of corners(polygon)) {
    const p: [number, number] = [round6(lng), round6(lat)];
    if (!out.length || !samePosition(out[out.length - 1], p)) out.push(p);
  }
  if (out.length > 1 && samePosition(out[0], out[out.length - 1])) out.pop();
  return { type: 'Polygon', coordinates: [[...out, ...(out.length ? [out[0]] : [])]] };
}

/** What is wrong with a (normalized) polygon as a geofence, or null when it can be one. */
export function polygonProblem(polygon: Polygon): PolygonProblem | null {
  const pts = corners(polygon);
  if (pts.length < 3) return 'too_few_points';
  if (pts.length > MAX_POLYGON_POINTS) return 'too_many_points';
  if (pts.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180)) return 'out_of_range';
  const box = boundingBox(polygon);
  const spanKm = metresBetween({ lat: box.minLat, lng: box.minLng }, { lat: box.maxLat, lng: box.maxLng }) / 1000;
  // Across the antimeridian the box spans the globe; no Ethiopian fence does.
  if (spanKm > MAX_POLYGON_SPAN_KM || box.maxLng - box.minLng > 180) return 'too_large';
  if (selfIntersects(pts)) return 'self_intersecting';
  if (areaSquareMetres(polygon) < MIN_POLYGON_AREA_M2) return 'too_small';
  return null;
}

export function boundingBox(polygon: Polygon): BoundingBox {
  const pts = corners(polygon);
  const lats = pts.map((p) => p[1]);
  const lngs = pts.map((p) => p[0]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

/** The polygon's area in square metres, on a flat projection about its middle. */
export function areaSquareMetres(polygon: Polygon): number {
  const pts = corners(polygon);
  if (pts.length < 3) return 0;
  const box = boundingBox(polygon);
  const xy = project(pts, (box.minLat + box.maxLat) / 2);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * Whether a fix is inside the polygon (ray casting, so a concave yard works). A fix exactly on an edge counts
 * as inside: a vehicle on the fence line has not left.
 */
export function inside(point: Point, polygon: Polygon, box: BoundingBox = boundingBox(polygon)): boolean {
  if (point.lat < box.minLat || point.lat > box.maxLat || point.lng < box.minLng || point.lng > box.maxLng) return false;
  const pts = corners(polygon);
  let crossings = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (onSegment(point.lng, point.lat, xi, yi, xj, yj)) return true;
    if (yi > point.lat !== yj > point.lat && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) crossings++;
  }
  return crossings % 2 === 1;
}

/** Great-circle distance in metres. */
export function metresBetween(a: Point, b: Point): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far a fix is from a line (a route's road), in metres: to the nearest point of its nearest segment, on a
 * flat projection about the fix. Infinity for a line without points.
 */
export function metresToLine(point: Point, line: LineString): number {
  const pts = line.coordinates;
  if (pts.length === 0) return Infinity;
  const xy = project(pts, point.lat, point.lng);
  if (xy.length === 1) return Math.hypot(xy[0][0], xy[0][1]);
  let best = Infinity;
  for (let i = 1; i < xy.length; i++) best = Math.min(best, distanceToSegment([0, 0], xy[i - 1], xy[i]));
  return best;
}

/** Positions as metres east and north of (originLat, originLng). */
function project(pts: readonly [number, number][], originLat: number, originLng = 0): [number, number][] {
  const k = Math.cos(rad(originLat));
  return pts.map(([lng, lat]) => [rad(lng - originLng) * k * EARTH_M, rad(lat - originLat) * EARTH_M]);
}

function distanceToSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether any two edges that are not neighbours cross or touch. O(n²): at most 500 corners, checked on save. */
function selfIntersects(pts: readonly [number, number][]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      if (segmentsMeet(a1, a2, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsMeet(p1: readonly [number, number], p2: readonly [number, number], q1: readonly [number, number], q2: readonly [number, number]): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(p1[0], p1[1], q1[0], q1[1], q2[0], q2[1])) ||
    (d2 === 0 && onSegment(p2[0], p2[1], q1[0], q1[1], q2[0], q2[1])) ||
    (d3 === 0 && onSegment(q1[0], q1[1], p1[0], p1[1], p2[0], p2[1])) ||
    (d4 === 0 && onSegment(q2[0], q2[1], p1[0], p1[1], p2[0], p2[1]))
  );
}

function cross(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Whether (x, y) lies on the segment (x1, y1)-(x2, y2). */
function onSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  if (x < Math.min(x1, x2) || x > Math.max(x1, x2) || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return false;
  return Math.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) <= 1e-12;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const samePosition = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
