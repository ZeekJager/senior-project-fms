import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Cache } from '../../../shared/cache';
import type { Coordinates } from '../domain/route';
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

  private async ask(points: readonly Coordinates[], correlationId: string): Promise<RoadPlan | null> {
    let body: unknown;
    try {
      ({ body } = await this.client(correlationId).call({
        method: 'GET',
        path: `/route/v1/driving/${waypointKey(points)}`,
        query: { overview: 'full', geometries: 'geojson', steps: 'false', alternatives: 'false' },
      }));
    } catch (err) {
      // OSRM answers 400 for waypoints it cannot join (NoRoute, NoSegment): no road, not a failure.
      if ((err as { status?: number }).status === 400) return null;
      throw new RoutingError(err instanceof Error ? err.message : 'The routing engine could not be reached.');
    }
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
