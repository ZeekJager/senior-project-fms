import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Cache } from '../../../shared/cache';
import type { Coordinates } from '../domain/route';
import type { Leg } from '../domain/eta';
import { MAX_WAYPOINTS, simplifyLine, waypointKey, type RoadPlan } from '../domain/road';

/** OSRM is on the stack's own network (FMS-84): a route across the country answers in well under a second. */
export const ROUTING_TIMEOUT_MS = 5_000;

/** A road between the same waypoints changes only with a new map: kept a week. */
const CACHE_TTL_SECONDS = 7 * 24 * 3600;

/** GET /route/v1/driving/...'s answer (OSRM v5): what the planner needs of it. */
const osrmAnswer = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number().nonnegative(),
        duration: z.number().nonnegative(),
        geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number(), z.number()])).min(2) }),
      }),
    )
    .default([]),
});

/** GET /route/v1/driving/... with overview=false: the legs between consecutive waypoints, no line (FMS-86). */
const osrmLegs = z.object({
  code: z.string(),
  routes: z
    .array(z.object({ legs: z.array(z.object({ distance: z.number().nonnegative(), duration: z.number().nonnegative() })) }))
    .default([]),
});

/** GET /table/v1/driving/...: road distance (m) and time (s) from every waypoint to every other; null where none joins them. */
const osrmTable = z.object({
  code: z.string(),
  distances: z.array(z.array(z.number().nonnegative().nullable())).optional(),
  durations: z.array(z.array(z.number().nonnegative().nullable())).optional(),
});

/** Road distance and time between every pair of waypoints, [from][to]. */
export interface RoadTable {
  metres: number[][];
  seconds: number[][];
}

/** The routing engine could not be asked, or answered something the planner cannot use. */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** An HTTP call through the integration gateway (FMS-85): timeouts, retries and OSRM's circuit breaker. */
export interface RoutingGatewayClient {
  call<T = unknown>(request: { method: 'GET'; path: string; query?: Record<string, string> }): Promise<{ body: T }>;
}

/** The road through a route's waypoints. */
export interface RoadPlanner {
  /** Null when the engine finds no road between them. Throws RoutingError when it cannot be asked. */
  plan(points: readonly Coordinates[], correlationId: string): Promise<RoadPlan | null>;
  /**
   * The legs between consecutive waypoints, for an arrival time (FMS-86): no line, not cached (a vehicle's
   * position is never the same twice). Null when there is no road; throws RoutingError when it cannot be asked.
   */
  legs(points: readonly Coordinates[], correlationId: string): Promise<Leg[] | null>;
  /** Distance and time between every pair, for ordering stops (FMS-86). Null when some pair has no road. */
  table(points: readonly Coordinates[], correlationId: string): Promise<RoadTable | null>;
}

/**
 * OSRM's `route` service (driving profile, docs/routing.md), cached in Redis by waypoints. The road comes back
 * whole and is simplified (ROAD_TOLERANCE_METRES) before it is kept or cached.
 */
export class OsrmRoadPlanner implements RoadPlanner {
  constructor(
    private readonly client: (correlationId: string) => RoutingGatewayClient,
    private readonly cache: Cache,
  ) {}

  async plan(points: readonly Coordinates[], correlationId: string): Promise<RoadPlan | null> {
    if (points.length < 2 || points.length > MAX_WAYPOINTS) return null;
    const key = this.cache.key('trip', 'road', createHash('sha256').update(waypointKey(points)).digest('hex').slice(0, 32));
    return this.cache.getOrSet(key, CACHE_TTL_SECONDS, () => this.ask(points, correlationId));
  }

  async legs(points: readonly Coordinates[], correlationId: string): Promise<Leg[] | null> {
    if (points.length < 2 || points.length > MAX_WAYPOINTS) return null;
    const body = await this.get(`/route/v1/driving/${waypointKey(points)}`, { overview: 'false', steps: 'false', alternatives: 'false' }, correlationId);
    if (body === null) return null;
    const parsed = osrmLegs.safeParse(body);
    if (!parsed.success) throw new RoutingError('The routing engine answered something unexpected.');
    const legs = parsed.data.routes[0]?.legs;
    if (parsed.data.code !== 'Ok' || !legs || legs.length !== points.length - 1) return null;
    return legs.map((l) => ({ distanceKm: Math.round(l.distance) / 1000, durationSeconds: Math.round(l.duration) }));
  }

  async table(points: readonly Coordinates[], correlationId: string): Promise<RoadTable | null> {
    if (points.length < 2 || points.length > MAX_WAYPOINTS) return null;
    const body = await this.get(`/table/v1/driving/${waypointKey(points)}`, { annotations: 'distance,duration' }, correlationId);
    if (body === null) return null;
    const parsed = osrmTable.safeParse(body);
    if (!parsed.success) throw new RoutingError('The routing engine answered something unexpected.');
    const { code, distances, durations } = parsed.data;
    const square = (m: (number | null)[][] | undefined): m is number[][] =>
      m !== undefined && m.length === points.length && m.every((row) => row.length === points.length && row.every((v) => v !== null));
    if (code !== 'Ok' || !square(distances) || !square(durations)) return null;
    return { metres: distances, seconds: durations };
  }

  /** The engine's answer; null for waypoints it cannot join (OSRM's 400: NoRoute, NoSegment), which is no road, not a failure. */
  private async get(path: string, query: Record<string, string>, correlationId: string): Promise<unknown> {
    try {
      return (await this.client(correlationId).call({ method: 'GET', path, query })).body;
    } catch (err) {
      if ((err as { status?: number }).status === 400) return null;
      throw new RoutingError(err instanceof Error ? err.message : 'The routing engine could not be reached.');
    }
  }

  private async ask(points: readonly Coordinates[], correlationId: string): Promise<RoadPlan | null> {
    const body = await this.get(`/route/v1/driving/${waypointKey(points)}`, { overview: 'full', geometries: 'geojson', steps: 'false', alternatives: 'false' }, correlationId);
    if (body === null) return null;
    const parsed = osrmAnswer.safeParse(body);
    if (!parsed.success) throw new RoutingError('The routing engine answered something unexpected.');
    const route = parsed.data.routes[0];
    if (parsed.data.code !== 'Ok' || !route) return null;
    return {
      distanceKm: Math.round(route.distance) / 1000,
      durationSeconds: Math.round(route.duration),
      geometry: simplifyLine({ type: 'LineString', coordinates: route.geometry.coordinates }),
    };
  }
}
