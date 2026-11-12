import { describe, expect, test, vi } from 'vitest';
import type { AvailabilityResult } from '../domain/availability';
import type { TripRiskProvider } from '../domain/dispatch';
import type { Caller } from './caller';
import { DispatchService, type DispatchServiceDeps } from './dispatch.service';

// The trip risk model on the board (FMS-155): only for tracking:read, only with a trip, only for drivers free for it,
// and never at the board's expense.

const FREE: AvailabilityResult = { availability: 'available', reasons: [] };
const BLOCKED: AvailabilityResult = { availability: 'unavailable', reasons: [{ code: 'license_expired', severity: 'block' }] };
const TRIP = '7c1d6f1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const SUMMARY = { status: 'ok', reason: null, model_version: 'tr-2026.11', demonstration: true, trips: 3000, drivers: 40, minimum: { trips: 2000, drivers: 20 } } as const;
const RISK = { late_probability: 0.18, safety_event_probability: 0.04, factors: { late: [{ feature: 'night_hours', value: 6 }], safety_event: [] } };

function service(provider: TripRiskProvider | null) {
  const deps = {
    store: {
      depotDrivers: async () => [
        { id: '1', publicId: 'd-free', fullName: 'Abebe', licenseCategories: ['automobile'] },
        { id: '2', publicId: 'd-blocked', fullName: 'Bekele', licenseCategories: [] },
      ],
      depotVehicles: async () => [],
      underWay: async () => new Map(),
    },
    availability: { check: async () => ({ drivers: new Map([['1', FREE], ['2', BLOCKED]]), vehicles: new Map() }) },
    attendance: { statusOn: async () => new Map() },
    depots: { resolveInScope: async () => '9', publicIds: async () => new Map([['9', 'depot-1']]) },
    maintenance: () => null,
    inTransaction: (fn: (client: never) => Promise<unknown>) => fn({} as never),
    tripRisk: () => provider,
    log: { warn: vi.fn() },
  } as unknown as DispatchServiceDeps;
  return new DispatchService(deps);
}

const caller = (permissions: string[]): Caller =>
  ({ user: { id: '5', publicId: 'u-5', roles: ['dispatcher'], depotId: '9', permissions }, correlationId: 'c-1' }) as unknown as Caller;

describe('trip risk on the dispatch board', () => {
  test('with tracking:read and a trip: the summary, and chances for the free drivers only', async () => {
    const forTrip = vi.fn<TripRiskProvider['forTrip']>(async () => ({ summary: SUMMARY, drivers: new Map([['d-free', RISK]]) }));
    const board = await service({ forTrip }).board(caller(['trip:assign', 'tracking:read']), { excludeTripId: TRIP });
    expect(forTrip).toHaveBeenCalledWith(TRIP, ['d-free'], 'c-1');
    expect(board.trip_risk).toEqual(SUMMARY);
    expect(board.drivers.map((d) => [d.driver_id, d.trip_risk])).toEqual([
      ['d-free', RISK],
      ['d-blocked', null],
    ]);
  });

  test('without tracking:read, or without a trip, the model is never asked and nothing shows', async () => {
    const forTrip = vi.fn<TripRiskProvider['forTrip']>();
    for (const [permissions, query] of [
      [['trip:assign'], { excludeTripId: TRIP }],
      [['trip:assign', 'tracking:read'], {}],
    ] as const) {
      const board = await service({ forTrip }).board(caller([...permissions]), query);
      expect(board.trip_risk).toBeNull();
      expect(board.drivers.every((d) => d.trip_risk === null)).toBe(true);
    }
    expect(forTrip).not.toHaveBeenCalled();
  });

  test('a provider that throws leaves the board as it is', async () => {
    const board = await service({ forTrip: async () => Promise.reject(new Error('replica down')) }).board(caller(['trip:assign', 'tracking:read']), { excludeTripId: TRIP });
    expect(board.trip_risk).toBeNull();
    expect(board.drivers).toHaveLength(2);
  });
});
