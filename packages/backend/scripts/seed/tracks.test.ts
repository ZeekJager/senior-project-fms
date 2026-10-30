import { describe, expect, test } from 'vitest';
import { buildPlan } from './plan';
import { CITIES, DEPOT_SITES } from './catalog';
import { seedRoad } from './roads';
import { routeRoad, TRACK_INTERVAL_SECONDS, tripTrack } from './tracks';

const ANCHOR = '2026-10-01';
const budget = buildPlan('budget', 20261007, ANCHOR);
const completed = budget.trips.map((t, i) => ({ t, i })).filter(({ t }) => t.status === 'completed');
const kmBetween = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

describe('tripTrack (FMS-136)', () => {
  test('the same plan gives the same track; only completed trips have one', () => {
    const { i } = completed[0];
    expect(tripTrack(budget, i)).toEqual(tripTrack(buildPlan('budget', 20261007, ANCHOR), i));
    expect(budget.trips.every((t, k) => (t.status === 'completed') === tripTrack(budget, k).length > 0)).toBe(true);
  });

  test("a ping every five minutes from the trip's actual start to its actual end, from its origin to its destination", () => {
    for (const { t, i } of completed.slice(0, 40)) {
      const track = tripTrack(budget, i);
      const route = budget.routes[t.route];
      expect(track[0].recorded_at).toBe(t.actual_start);
      expect(track.at(-1)!.recorded_at).toBe(t.actual_end);
      const gaps = track.slice(1).map((p, k) => (Date.parse(p.recorded_at) - Date.parse(track[k].recorded_at)) / 1000);
      expect(gaps.slice(0, -1).every((g) => g === TRACK_INTERVAL_SECONDS)).toBe(true);
      expect(gaps.at(-1)).toBeLessThanOrEqual(TRACK_INTERVAL_SECONDS);
      expect(kmBetween(track[0], route.origin)).toBeLessThan(0.01);
      expect(kmBetween(track.at(-1)!, route.destination)).toBeLessThan(0.01);
    }
  });

  test('the speeds add up to the distance driven, stay plausible, and a long trip stops once on the way', () => {
    for (const { t, i } of completed.slice(0, 40)) {
      const track = tripTrack(budget, i);
      const km = track.slice(1).reduce((sum, p, k) => sum + (p.speed_kmh * (Date.parse(p.recorded_at) - Date.parse(track[k].recorded_at))) / 3_600_000, 0);
      // Speeds are whole km/h, so the sum is close, not exact.
      expect(Math.abs(km - t.actual_distance_km!)).toBeLessThan(Math.max(2, t.actual_distance_km! * 0.02));
      expect(Math.max(...track.map((p) => p.speed_kmh))).toBeLessThan(110);
      const long = t.actual_duration_seconds! > 3 * 3600;
      const stopped = track.slice(1, -1).some((p) => p.speed_kmh === 0);
      expect(stopped).toBe(long);
    }
  });

  test('every trip on a route follows the same road, measured on OpenStreetMap, from one city to the other (FMS-84)', () => {
    for (const route of budget.routes) {
      const road = routeRoad(route.origin, route.destination);
      expect(road).toEqual(routeRoad(route.origin, route.destination));
      expect(kmBetween(road[0], route.origin)).toBeLessThan(0.001);
      expect(kmBetween(road.at(-1)!, route.destination)).toBeLessThan(0.001);
      // The line drawn is the road measured: as long as the route, give or take the simplification and the ends.
      const length = road.slice(1).reduce((sum, p, k) => sum + kmBetween(road[k], p), 0);
      expect(Math.abs(length - route.distance_km)).toBeLessThan(Math.max(2, route.distance_km * 0.03));
    }
  });

  test('roads.json has a road from every depot to every other city, so any plan finds its routes', () => {
    const missing = DEPOT_SITES.flatMap((d) => CITIES.filter((c) => c.city !== d.city && !seedRoad(d, c)).map((c) => `${d.city} → ${c.city}`));
    expect(missing).toEqual([]);
  });

  test('the budget profile has about 71,000 pings (roads measured on OpenStreetMap, FMS-84)', () => {
    const total = completed.reduce((sum, { i }) => sum + tripTrack(budget, i).length, 0);
    expect(total).toBeGreaterThan(60_000);
    expect(total).toBeLessThan(80_000);
  });
});
