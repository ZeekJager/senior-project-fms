import { describe, expect, test, vi } from 'vitest';
import type { Cache } from '../../../shared/cache/cache';
import type { RequestUser } from '../../../types/express';
import type { TrackingRepository } from '../infrastructure/tracking.repository';
import { LiveMapService, type LiveMapRefs } from './live-map.service';

// FMS-45: the live map's snapshot, cached per depot shown.

/** A cache in memory that records its keys. */
function memoryCache() {
  const store = new Map<string, unknown>();
  const cache: Cache = {
    key: (...parts) => ['fms', 'cache', ...parts].join(':'),
    async getOrSet<T>(key: string, _ttl: number, loader: () => Promise<T>) {
      if (!store.has(key)) store.set(key, await loader());
      return store.get(key) as T;
    },
    delete: async () => {},
    invalidate: vi.fn(async () => {
      const n = store.size;
      store.clear();
      return n;
    }),
    state: () => 'ok',
    ping: async () => {},
  };
  return { cache, store };
}

const user = (roles: string[], depotId: string | null = null): RequestUser => ({ id: '1', roles, depotId }) as unknown as RequestUser;

function service() {
  const vehicles = [
    { id: '10', publicId: 'v-moving', registrationNumber: 'AA 1', vehicleType: 'truck', status: 'active', maintenanceFlag: false, depotPublicId: 'd-1' },
    { id: '11', publicId: 'v-parked', registrationNumber: 'AA 2', vehicleType: 'van', status: 'active', maintenanceFlag: false, depotPublicId: 'd-1' },
  ];
  const refs: LiveMapRefs = {
    vehicles: { liveMap: vi.fn(async () => vehicles) },
    drivers: { names: vi.fn(async () => new Map([['7', { publicId: 'drv-7', fullName: 'Abebe' }]])) },
    depots: {
      resolveInScope: vi.fn(async (_db, publicId: string) => (publicId === 'd-1' ? '1' : null)),
      publicIds: vi.fn(async (_db, ids: readonly string[]) => new Map(ids.filter((id) => id === '1').map((id) => [id, 'd-1']))),
    },
    trips: {
      liveForVehicles: vi.fn(
        async () =>
          new Map([['10', { tripId: 't-1', routeName: 'Bole - Adama', origin: null, destination: null, driverId: '7', actualStart: new Date('2026-10-21T08:00:00Z'), scheduledEnd: null }]]),
      ),
    },
  };
  const tracking = {
    livePositions: vi.fn(async () => [
      { vehicleId: '10', lat: 9, lng: 38, speedKmh: 50, heading: null, accuracyM: null, ignitionOn: null, recordedAt: new Date('2026-10-21T09:00:00Z'), stoppedSince: null },
    ]),
    openFlags: vi.fn(async () => []),
  } as unknown as TrackingRepository;
  const { cache, store } = memoryCache();
  return { live: new LiveMapService({ db: {} as never, tracking, refs, cache }), refs, store, cache };
}

describe('LiveMapService', () => {
  test('lists vehicles with a position or a trip, named and with the driver', async () => {
    const { live } = service();
    const rows = await live.current(user(['fleet_manager']), {});
    expect(rows.map((r) => r.vehicle_id)).toEqual(['v-moving']);
    expect(rows[0].trip).toMatchObject({ trip_id: 't-1', route_name: 'Bole - Adama', started_at: '2026-10-21T08:00:00.000Z', driver: { driver_id: 'drv-7', full_name: 'Abebe' } });
    expect(rows[0].position).toMatchObject({ speed_kmh: 50, recorded_at: '2026-10-21T09:00:00.000Z' });
  });

  test('one cache entry per depot shown (by public id) and one for all; the second screen to open reads no database', async () => {
    const { live, refs, store } = service();
    await live.current(user(['dispatcher'], '1'), {});
    await live.current(user(['dispatcher'], '1'), {});
    // A fleet manager choosing that depot sees what its dispatcher sees: the same entry.
    await live.current(user(['fleet_manager']), { depotId: 'd-1' });
    await live.current(user(['fleet_manager']), {});
    expect([...store.keys()].sort()).toEqual(['fms:cache:integration:live-map:all', 'fms:cache:integration:live-map:d-1']);
    expect(refs.vehicles.liveMap).toHaveBeenCalledTimes(2);
    expect(refs.vehicles.liveMap).toHaveBeenNthCalledWith(1, expect.anything(), { kind: 'all' }, '1');
    expect(refs.vehicles.liveMap).toHaveBeenNthCalledWith(2, expect.anything(), { kind: 'all' }, null);
  });

  test('a depot outside the scope, or a caller with no scope, gets an empty list without a query', async () => {
    const { live, refs } = service();
    expect(await live.current(user(['dispatcher'], '1'), { depotId: 'd-elsewhere' })).toEqual([]);
    expect(await live.current(user(['dispatcher'], null), {})).toEqual([]);
    expect(refs.vehicles.liveMap).not.toHaveBeenCalled();
  });

  test('invalidate drops every snapshot', async () => {
    const { live, cache, refs } = service();
    await live.current(user(['fleet_manager']), {});
    await live.invalidate();
    expect(cache.invalidate).toHaveBeenCalledWith('integration:live-map:*');
    await live.current(user(['fleet_manager']), {});
    expect(refs.vehicles.liveMap).toHaveBeenCalledTimes(2);
  });
});
