import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import type { DomainEvent } from '../../../shared/events/domain-event';
import { InProcessEventBus } from '../../../shared/events/in-process-event-bus';
import type { RequestUser } from '../../../types/express';
import type { UserAccount } from '../../auth';
import type { VehicleType } from '../domain/vehicle';
import type { DriverRow } from '../infrastructure/driver.repository';
import type { Caller } from './caller';
import { DriverService, type DriverServiceDeps } from './driver.service';

const DRIVER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DEPOT_A = '9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f';

const depotAdmin: RequestUser = { id: '10', publicId: '11111111-1111-4111-8111-111111111111', roles: ['depot_admin'], permissions: [], depotId: '5' };
const caller: Caller = { user: depotAdmin, correlationId: '22222222-2222-4222-8222-222222222222' };

const account = (over: Partial<UserAccount> = {}): UserAccount => ({
  id: '20',
  publicId: '33333333-3333-4333-8333-333333333333',
  fullName: 'Abebe',
  email: 'a@fleet.et',
  phone: null,
  status: 'active',
  depotId: '5',
  roles: ['driver'],
  ...over,
});

const row = (over: Partial<DriverRow> = {}): DriverRow => ({
  id: '7',
  publicId: DRIVER,
  userId: '20',
  licenseNumber: 'AA 1',
  licenseCategories: [],
  licenseExpiry: '2030-01-01',
  licenseStatus: 'valid',
  hireDate: null,
  emergencyPhone: null,
  isActive: true,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

interface HarnessOptions {
  row?: DriverRow | null;
  account?: UserAccount;
  activeTrip?: boolean;
  activeAssignment?: boolean;
  licence?: { isActive?: boolean; licenseValid?: boolean; licenseCategories?: DriverRow['licenseCategories'] } | null;
  vehicleType?: VehicleType | null;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const published: DomainEvent[] = [];
  const events = new InProcessEventBus(() => {});
  events.subscribe('DriverRetired', (e) => void published.push(e));
  events.subscribe('DriverRegistered', (e) => void published.push(e));
  const current = options.row === undefined ? row() : options.row;
  const acct = options.account ?? account();

  const deps: DriverServiceDeps = {
    drivers: {
      inTransaction: (fn) => fn({} as PoolClient),
      findByPublicId: async () => current,
      findById: async () => current ?? row(),
      findByUserId: async () => current,
      expiringIn: async () => [],
      lockForWrite: async () => current,
      list: async () => ({ rows: [], total: 0 }),
      hasActiveAssignment: async () => options.activeAssignment ?? false,
      licenceAt: async () =>
        options.licence === null
          ? null
          : { userId: acct.id, isActive: true, licenseValid: true, licenseCategories: ['B', 'C'], ...options.licence },
      insert: async () => (calls.push('insert'), { id: '7' }),
      update: async (_c, _i, data) => (calls.push(`update:${Object.keys(data).join(',')}`), { id: '7' }),
      retire: async (_c, id) => (calls.push(`retire:${id}`), { id }),
      touch: async (_c, id) => void calls.push(`touch:${id}`),
    },
    accounts: {
      upsert: async (_db, accts) => void calls.push(`sync:${accts.map((a) => `${a.id}@${a.depotId}`).join(',')}`),
      driverUserIds: async () => [acct.id],
      isDriver: async () => true,
    },
    vehicles: { typeOf: async () => (options.vehicleType === undefined ? 'truck' : options.vehicleType) },
    users: {
      findByPublicId: async () => acct,
      findByIds: async () => [acct],
      findByEmail: async () => acct,
      setDepot: async (_c, _ctx, userId, depotId) => void calls.push(`setDepot:${userId}:${depotId}`),
    },
    depots: {
      resolveInScope: async (_db, publicId) => (publicId === DEPOT_A ? '5' : null),
      publicIds: async () => new Map([['5', DEPOT_A]]),
      publicIdByCode: async () => DEPOT_A,
    },
    trips: { driverHasActiveTrip: async () => options.activeTrip ?? false },
    events,
  };
  return { service: new DriverService(deps), calls, published };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe('retire rule', () => {
  test('an idle driver is retired once and announced', async () => {
    const { service, calls, published } = harness();
    await service.retire(caller, DRIVER);
    expect(calls).toEqual(['retire:7']);
    expect(published.map((e) => e.type)).toEqual(['DriverRetired']);
  });

  test('an active trip or vehicle assignment blocks it with 409 CONFLICT_DRIVER_IN_USE', async () => {
    for (const blocker of [{ activeTrip: true }, { activeAssignment: true }]) {
      const { service, calls, published } = harness(blocker);
      expect(await codeOf(service.retire(caller, DRIVER))).toBe('CONFLICT_DRIVER_IN_USE');
      expect(calls).toEqual([]);
      expect(published).toEqual([]);
    }
  });

  test('already retired: success, nothing written; another depot: 404', async () => {
    const retired = harness({ row: row({ isActive: false }), activeTrip: true });
    await expect(retired.service.retire(caller, DRIVER)).resolves.toBeUndefined();
    expect(retired.calls).toEqual([]);
    expect(await codeOf(harness({ account: account({ depotId: '6' }) }).service.retire(caller, DRIVER))).toBe('NOT_FOUND');
  });
});

describe('create rules', () => {
  const input = { user_id: '33333333-3333-4333-8333-333333333333', license_number: 'AA 1', license_expiry: '2030-01-01', depot_id: DEPOT_A };

  test('the depot is written to the account only when it changes', async () => {
    const moved = harness({ account: account({ depotId: null }) });
    await moved.service.create(caller, input);
    expect(moved.calls).toEqual(['insert', 'setDepot:20:5', 'sync:20@5']);

    const same = harness();
    await same.service.create(caller, input);
    expect(same.calls).toEqual(['insert', 'sync:20@5']);
  });

  test.each([
    [{ depotId: '6' }, 'references_missing_record'],
    [{ status: 'locked' as const }, 'account_not_active'],
    [{ roles: ['technician'] }, 'not_a_driver'],
  ])('rejects an account %j: %s', async (over, reason) => {
    const { service, calls } = harness({ account: account(over) });
    const err = await service.create(caller, input).catch((e: AppError) => e);
    expect((err as AppError).details).toEqual([{ field: 'user_id', reason }]);
    expect(calls).toEqual([]);
  });
});

describe('checkEligibility', () => {
  const db = {} as PoolClient;
  const at = new Date();

  test('eligible: active driver and account, valid licence, class covers the vehicle', async () => {
    expect(await harness().service.checkEligibility(db, '7', at, '99')).toEqual({ eligible: true, reasons: [] });
    // Without a vehicle the class is not checked.
    expect(await harness({ licence: { licenseCategories: [] } }).service.checkEligibility(db, '7', at)).toEqual({ eligible: true, reasons: [] });
  });

  test('lists every reason at once', async () => {
    const h = harness({ licence: { isActive: false, licenseValid: false }, account: account({ status: 'suspended' }) });
    expect(await h.service.checkEligibility(db, '7', at)).toEqual({
      eligible: false,
      reasons: ['driver_retired', 'account_not_active', 'license_expired'],
    });
  });

  test.each([
    [{ licence: { licenseCategories: ['B' as const] } }, 'license_category_not_valid_for_vehicle'],
    [{ licence: { licenseCategories: [] } }, 'license_category_missing'],
    [{ vehicleType: null }, 'vehicle_not_found'],
  ])('with a vehicle: %j -> %s', async (opts, reason) => {
    expect(await harness(opts).service.checkEligibility(db, '7', at, '99')).toEqual({ eligible: false, reasons: [reason] });
  });

  test('an unknown driver', async () => {
    expect(await harness({ licence: null }).service.checkEligibility(db, '404', at)).toEqual({ eligible: false, reasons: ['driver_not_found'] });
  });
});
