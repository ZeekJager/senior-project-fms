import { describe, expect, test } from 'vitest';
import type { PoolClient } from 'pg';
import { AppError } from '../../../shared/errors/app-error';
import type { DomainEvent } from '../../../shared/events/domain-event';
import { InProcessEventBus } from '../../../shared/events/in-process-event-bus';
import type { RequestUser } from '../../../types/express';
import type { VehicleView } from '../domain/vehicle';
import type { LockedVehicle } from '../infrastructure/vehicle.repository';
import { VehicleService, type Caller, type VehicleServiceDeps } from './vehicle.service';

const VEHICLE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DEPOT_PUBLIC = '9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f';

const depotAdmin: RequestUser = {
  id: '10',
  publicId: '11111111-1111-4111-8111-111111111111',
  roles: ['depot_admin'],
  permissions: ['vehicle:write', 'vehicle:delete'],
  depotId: '5',
};
const caller: Caller = { user: depotAdmin, correlationId: '22222222-2222-4222-8222-222222222222' };

const view = { id: VEHICLE, depot_id: DEPOT_PUBLIC } as VehicleView;

/** A service over fakes. `locked` is what the row lock finds (null: not in scope). */
function harness(options: { locked?: Partial<LockedVehicle> | null; activeTrip?: boolean; activeAssignment?: boolean } = {}) {
  const calls: string[] = [];
  const published: DomainEvent[] = [];
  const events = new InProcessEventBus(() => {});
  for (const type of ['VehicleRegistered', 'VehicleUpdated', 'VehicleRetired']) {
    events.subscribe(type, (e) => {
      published.push(e);
    });
  }
  const locked =
    options.locked === null
      ? null
      : { id: '7', depotId: '5', isActive: true, fuelType: 'diesel' as const, fuelEfficiencyMlPerKm: 320, odometerKm: 1000, ...options.locked };

  const vehicles: VehicleServiceDeps['vehicles'] = {
    inTransaction: (fn) => fn({} as PoolClient),
    findView: async () => view,
    findViewById: async () => view,
    list: async () => ({ items: [], total: 0 }),
    resolveDepot: async (_db, publicId) => (publicId === DEPOT_PUBLIC ? '5' : null),
    lockForWrite: async () => locked,
    hasActiveAssignment: async () => options.activeAssignment ?? false,
    insert: async () => {
      calls.push('insert');
      return { id: '7' };
    },
    update: async (_ctx, _id, data) => {
      calls.push(`update:${Object.keys(data).join(',')}`);
      return { id: '7' };
    },
    retire: async (ctx, id) => {
      calls.push(`retire:${id}:${ctx.userId}`);
      return { id };
    },
  };
  const trips = { vehicleHasActiveTrip: async () => options.activeTrip ?? false };
  return { service: new VehicleService({ vehicles, trips, events }), calls, published };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe('retire rule', () => {
  test('an idle vehicle is retired once, attributed, and announced', async () => {
    const { service, calls, published } = harness();
    await service.retire(caller, VEHICLE);
    expect(calls).toEqual(['retire:7:10']);
    expect(published.map((e) => e.type)).toEqual(['VehicleRetired']);
    expect(published[0]).toMatchObject({ actor: depotAdmin.publicId, correlation_id: caller.correlationId, payload: { vehicle_id: VEHICLE } });
  });

  test('a vehicle on an assigned or en-route trip is in use: 409, nothing written or published', async () => {
    const { service, calls, published } = harness({ activeTrip: true });
    expect(await codeOf(service.retire(caller, VEHICLE))).toBe('CONFLICT_VEHICLE_IN_USE');
    expect(calls).toEqual([]);
    expect(published).toEqual([]);
  });

  test('a vehicle assigned to a driver is in use: 409', async () => {
    const { service, calls } = harness({ activeAssignment: true });
    expect(await codeOf(service.retire(caller, VEHICLE))).toBe('CONFLICT_VEHICLE_IN_USE');
    expect(calls).toEqual([]);
  });

  test('an already retired vehicle: success, no second retirement or event', async () => {
    const { service, calls, published } = harness({ locked: { isActive: false }, activeTrip: true });
    await expect(service.retire(caller, VEHICLE)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(published).toEqual([]);
  });

  test('a vehicle outside the caller’s scope is 404', async () => {
    const { service } = harness({ locked: null });
    expect(await codeOf(service.retire(caller, VEHICLE))).toBe('NOT_FOUND');
  });
});

describe('update rules', () => {
  test('the odometer only goes up', async () => {
    const { service, calls } = harness({ locked: { odometerKm: 5000 } });
    expect(await codeOf(service.update(caller, VEHICLE, { odometer_km: 4999.9 }))).toBe('CONFLICT_ODOMETER_REGRESSION');
    expect(calls).toEqual([]);
    await service.update(caller, VEHICLE, { odometer_km: 5000 });
    expect(calls).toEqual(['update:odometer_km']);
  });

  test('fuel efficiency is checked against the vehicle after the change', async () => {
    const electric = { fuelType: 'electric' as const, fuelEfficiencyMlPerKm: null };
    expect(await codeOf(harness({ locked: electric }).service.update(caller, VEHICLE, { fuel_type: 'diesel' }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(harness().service.update(caller, VEHICLE, { fuel_efficiency_ml_per_km: null }))).toBe('VALIDATION_FAILED');
    await expect(harness({ locked: electric }).service.update(caller, VEHICLE, { model: 'X' })).resolves.toBe(view);
  });

  test('a retired vehicle cannot be changed; one out of scope is 404', async () => {
    expect(await codeOf(harness({ locked: { isActive: false } }).service.update(caller, VEHICLE, { model: 'X' }))).toBe(
      'CONFLICT_INVALID_STATE_TRANSITION',
    );
    expect(await codeOf(harness({ locked: null }).service.update(caller, VEHICLE, { model: 'X' }))).toBe('NOT_FOUND');
  });

  test('year maps to model_year, and a depot outside the scope is a missing record', async () => {
    const { service, calls, published } = harness();
    await service.update(caller, VEHICLE, { year: 2020, depot_id: DEPOT_PUBLIC });
    expect(calls).toEqual(['update:model_year,depot_id']);
    expect(published[0].payload).toMatchObject({ changed_fields: ['depot_id', 'year'] });
    expect(await codeOf(service.update(caller, VEHICLE, { depot_id: VEHICLE }))).toBe('VALIDATION_FAILED');
  });
});

describe('create rules', () => {
  const input = { registration_number: 'AA 1', make: 'Isuzu', model: 'FSR', vehicle_type: 'truck' as const, depot_id: DEPOT_PUBLIC };

  test('a diesel vehicle needs a fuel efficiency; nothing is written without one', async () => {
    const { service, calls } = harness();
    expect(await codeOf(service.create(caller, { ...input, fuel_type: 'diesel' }))).toBe('VALIDATION_FAILED');
    expect(calls).toEqual([]);
  });

  test('a depot outside the scope is a missing record', async () => {
    const { service, calls } = harness();
    expect(await codeOf(service.create(caller, { ...input, fuel_type: 'electric', depot_id: VEHICLE }))).toBe('VALIDATION_FAILED');
    expect(calls).toEqual([]);
  });
});
