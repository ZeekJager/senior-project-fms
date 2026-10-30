import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { NoCache, type Cache } from '../../../shared/cache/cache';
import { OsrmRoadPlanner, RoutingError, type RoutingGatewayClient } from './osrm.planner';

/** A real answer of OSRM v5.27.1 on the Ethiopia extract, Bole to Megenagna in Addis Ababa (waypoint hints removed). */
const recorded = JSON.parse(readFileSync(join(__dirname, '../../../../test/fixtures/osrm/bole-megenagna.json'), 'utf8'));
const BOLE = { latitude: 8.9806, longitude: 38.7578 };
const MEGENAGNA = { latitude: 9.0203, longitude: 38.8008 };

/** The gateway's errors as the planner sees them (ProviderCallError: a message, and the HTTP status for `http`). */
const failure = (message: string, status?: number) => Object.assign(new Error(message), { status });

function gateway(answer: () => Promise<unknown>) {
  const calls: { method: string; path: string; query?: Record<string, string> }[] = [];
  const client: RoutingGatewayClient = {
    call: async <T>(request: { method: 'GET'; path: string; query?: Record<string, string> }) => {
      calls.push(request);
      return { body: (await answer()) as T };
    },
  };
  return { calls, factory: vi.fn(() => client) };
}

/** A cache that keeps values in memory, as Redis would. */
function memoryCache(): Cache {
  const store = new Map<string, unknown>();
  return Object.assign(new NoCache(), {
    key: (...parts: string[]) => ['test', 'cache', ...parts].join(':'),
    getOrSet: async <T>(key: string, _ttl: number, loader: () => Promise<T>) => {
      if (store.has(key)) return store.get(key) as T;
      const value = await loader();
      store.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    },
  });
}

describe('OSRM road planner (FMS-84)', () => {
  test('asks the driving route through the waypoints, and keeps distance, time and the simplified road', async () => {
    const { calls, factory } = gateway(async () => recorded);
    const plan = await new OsrmRoadPlanner(factory, new NoCache()).plan([BOLE, MEGENAGNA], 'corr-1');

    expect(factory).toHaveBeenCalledWith('corr-1');
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/route/v1/driving/38.757800,8.980600;38.800800,9.020300',
        query: { overview: 'full', geometries: 'geojson', steps: 'false', alternatives: 'false' },
      },
    ]);
    expect(plan!.distanceKm).toBe(8.748);
    expect(plan!.durationSeconds).toBe(571);
    const full: [number, number][] = recorded.routes[0].geometry.coordinates;
    const round5 = ([lng, lat]: [number, number]) => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
    expect(plan!.geometry.type).toBe('LineString');
    expect(plan!.geometry.coordinates[0]).toEqual(round5(full[0]));
    expect(plan!.geometry.coordinates.at(-1)).toEqual(round5(full.at(-1)!));
    expect(plan!.geometry.coordinates.length).toBeLessThan(full.length / 3);
  });

  test('the same waypoints are answered from the cache', async () => {
    const { calls, factory } = gateway(async () => recorded);
    const planner = new OsrmRoadPlanner(factory, memoryCache());
    const first = await planner.plan([BOLE, MEGENAGNA], 'a');
    expect(await planner.plan([BOLE, MEGENAGNA], 'b')).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  test('no road between the waypoints (OSRM answers 400, or no route) is null, not a failure', async () => {
    const noRoad = gateway(async () => {
      throw failure('GET /route/v1/driving/... answered 400.', 400);
    });
    expect(await new OsrmRoadPlanner(noRoad.factory, new NoCache()).plan([BOLE, MEGENAGNA], 'c')).toBeNull();
    const empty = gateway(async () => ({ code: 'NoRoute', routes: [] }));
    expect(await new OsrmRoadPlanner(empty.factory, new NoCache()).plan([BOLE, MEGENAGNA], 'c')).toBeNull();
  });

  test('an engine that is down, times out or answers nonsense is a RoutingError', async () => {
    for (const answer of [
      async () => {
        throw failure('GET /route/v1/driving/... could not reach the provider.');
      },
      async () => {
        throw failure('osrm is failing fast.');
      },
      async () => {
        throw failure('GET /route/v1/driving/... answered 503.', 503);
      },
      async () => ({ code: 'Ok', routes: [{ distance: 'far' }] }),
    ]) {
      const { factory } = gateway(answer);
      await expect(new OsrmRoadPlanner(factory, new NoCache()).plan([BOLE, MEGENAGNA], 'd')).rejects.toBeInstanceOf(RoutingError);
    }
  });

  test('fewer than 2 or more than 30 waypoints are not asked', async () => {
    const { calls, factory } = gateway(async () => recorded);
    const planner = new OsrmRoadPlanner(factory, new NoCache());
    expect(await planner.plan([BOLE], 'e')).toBeNull();
    expect(await planner.plan(Array.from({ length: 31 }, () => BOLE), 'e')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
