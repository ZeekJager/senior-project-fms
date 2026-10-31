import type { Place } from './catalog';
import type { SeedPlan } from './plan';
import { Rng } from './random';
import { roadLine } from './roads';

/** A seeded GPS ping of a completed trip (FMS-136): what a driver's phone would have reported. */
export interface TrackPoint {
  recorded_at: string;
  latitude: number;
  longitude: number;
  speed_kmh: number;
  heading: number;
}

/** One ping every five minutes (4.6 km at 55 km/h): a city-to-city track still reads as a line, and the budget profile stays near 71,000 pings, each a row trigger (the current location). */
export const TRACK_INTERVAL_SECONDS = 300;
/** Trips longer than this stop once on the way, for 15 to 30 minutes. */
const REST_STOP_AFTER_SECONDS = 3 * 3600;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const roads = new Map<string, Place[]>();

/**
 * The road a route follows (FMS-84): measured with OSRM on OpenStreetMap and committed (roads.json), from its
 * origin to its destination, the same for every trip on the route.
 */
export function routeRoad(origin: Place, destination: Place): Place[] {
  const key = `${origin.city}|${destination.city}`;
  let road = roads.get(key);
  if (!road) {
    road = roadLine(origin, destination).coordinates.map(([longitude, latitude]) => ({ city: '', latitude, longitude }));
    roads.set(key, road);
  }
  return road;
}

/** Where a fraction (0 to 1) of the road's length lies, and the road's cumulative lengths. */
function walker(road: readonly Place[]): (fraction: number) => Place {
  const cumulative = [0];
  for (let i = 1; i < road.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(road[i].latitude - road[i - 1].latitude, road[i].longitude - road[i - 1].longitude));
  }
  const total = cumulative.at(-1)!;
  return (fraction) => {
    const target = Math.min(Math.max(fraction, 0), 1) * total;
    let i = 1;
    while (i < road.length - 1 && cumulative[i] < target) i++;
    const span = cumulative[i] - cumulative[i - 1];
    const t = span === 0 ? 0 : (target - cumulative[i - 1]) / span;
    return {
      city: '',
      latitude: road[i - 1].latitude + (road[i].latitude - road[i - 1].latitude) * t,
      longitude: road[i - 1].longitude + (road[i].longitude - road[i - 1].longitude) * t,
    };
  };
}

function bearing(a: Place, b: Place): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.longitude - a.longitude)) * Math.cos(rad(b.latitude));
  const x = Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) - Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(rad(b.longitude - a.longitude));
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) * 100) / 100;
}

/**
 * The GPS track of a completed trip: a ping every TRACK_INTERVAL_SECONDS from its actual start to its actual end
 * along its route's road, the speed varying, one rest stop on a long trip, the distance its actual_distance_km.
 * Empty for any other trip. The same plan always gives the same points.
 */
export function tripTrack(plan: SeedPlan, tripIndex: number): TrackPoint[] {
  const trip = plan.trips[tripIndex];
  if (trip.status !== 'completed' || trip.vehicle === null || !trip.actual_start || !trip.actual_end || trip.actual_distance_km === null) return [];
  const route = plan.routes[trip.route];
  const at = walker(routeRoad(route.origin, route.destination));
  const rng = new Rng((plan.seed ^ Math.imul(tripIndex + 1, 0x85ebca6b)) >>> 0);

  const start = Date.parse(trip.actual_start);
  const end = Date.parse(trip.actual_end);
  const seconds = (end - start) / 1000;
  const steps = Math.max(1, Math.ceil(seconds / TRACK_INTERVAL_SECONDS));
  const times = Array.from({ length: steps + 1 }, (_, k) => Math.min(start + k * TRACK_INTERVAL_SECONDS * 1000, end));

  // How far each interval moves: 0 during the rest stop, otherwise a speed that drifts between 75% and 125%.
  const restFrom = seconds > REST_STOP_AFTER_SECONDS ? start + seconds * 1000 * rng.between(0.4, 0.6) : Infinity;
  const restTo = restFrom + rng.int(15, 30) * 60_000;
  let drift = 1;
  const weights = times.slice(1).map((t, k) => {
    drift = Math.min(1.25, Math.max(0.75, drift + rng.between(-0.08, 0.08)));
    const resting = times[k] >= restFrom && t <= restTo;
    return resting ? 0 : drift * ((t - times[k]) / 1000);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const points: TrackPoint[] = [];
  let progress = 0;
  let heading = 0;
  let previous = at(0);
  times.forEach((t, k) => {
    if (k > 0) progress += totalWeight === 0 ? 0 : weights[k - 1] / totalWeight;
    const here = at(progress);
    const km = k === 0 || totalWeight === 0 ? 0 : (weights[k - 1] / totalWeight) * trip.actual_distance_km!;
    const hours = k === 0 ? 1 : (t - times[k - 1]) / 3_600_000;
    if (k > 0 && km > 0) heading = bearing(previous, here);
    points.push({
      recorded_at: new Date(t).toISOString(),
      latitude: round6(here.latitude),
      longitude: round6(here.longitude),
      speed_kmh: hours === 0 ? 0 : Math.round(km / hours),
      heading,
    });
    previous = here;
  });
  return points;
}
