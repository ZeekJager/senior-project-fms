import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import type { DomainEvent } from '../../../shared/events/domain-event';
import { InProcessEventBus } from '../../../shared/events/in-process-event-bus';
import type { RequestUser } from '../../../types/express';
import type { UserAccount } from '../../auth';
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
  licenseCategory: null,
  licenseExpiry: '2030-01-01',
  hireDate: null,
  emergencyPhone: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function harness(options: { row?: DriverRow | null; account?: UserAccount; activeTrip?: boolean; activeAssignment?: boolean; licensed?: boolean } = {}) {
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
      lockForWrite: async () => current,
      list: async () => ({ rows: [], total: 0 }),
      hasActiveAssignment: async () => options.activeAssignment ?? false,
      licensedAt: async () => ({ userId: acct.id, eligible: options.licensed ?? true }),
      insert: async () => (calls.push('insert'), { id: '7' }),
      update: async (_c, _i, data) => (calls.push(`update:${Object.keys(data).join(',')}`), { id: '7' }),
      retire: async (_c, id) => (calls.push(`retire:${id}`), { id }),
    },
    users: {
      findByPublicId: async () => acct,
      findByIds: async () => [acct],
      idsMatching: async () => [acct.id],
      setDepot: async (_c, _ctx, userId, depotId) => void calls.push(`setDepot:${userId}:${depotId}`),
    },
    depots: {
      resolveInScope: async (_db, publicId) => (publicId === DEPOT_A ? '5' : null),
      publicIds: async () => new Map([['5', DEPOT_A]]),
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
    expect(moved.calls).toEqual(['insert', 'setDepot:20:5']);

    const same = harness();
    await same.service.create(caller, input);
    expect(same.calls).toEqual(['insert']);
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

describe('isEligible', () => {
  test('needs both the licence and an active account', async () => {
    const at = new Date();
    expect(await harness().service.isEligible({} as PoolClient, '7', at)).toBe(true);
    expect(await harness({ licensed: false }).service.isEligible({} as PoolClient, '7', at)).toBe(false);
    expect(await harness({ account: account({ status: 'suspended' }) }).service.isEligible({} as PoolClient, '7', at)).toBe(false);
  });
});
