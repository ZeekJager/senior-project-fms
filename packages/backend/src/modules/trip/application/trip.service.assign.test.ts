import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { RecordingEventBus } from '../../../shared/events/recording-event-bus';
import type { RequestUser } from '../../../types/express';
import type { AvailabilityAnswer } from '../domain/assignment';
import type { TripStatus } from '../domain/trip';
import type { TripRow } from '../infrastructure/trip.repository';
import type { FleetRefs } from './route.service';
import { TripService, type TripServiceDeps } from './trip.service';

/**
 * The assignment rules (FMS-31) with the database and fleet faked: which check
 * runs when, what each refusal says, and that a refusal writes and publishes
 * nothing. The interval arithmetic behind BR-1 and BR-3 is a SQL range query,
 * so it is tested against the database in test/integration/trip-overlap.test.ts;
 * here the overlap query answers what the test tells it to.
 */

const TRIP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const VEHICLE = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const DRIVER = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const OTHER_TRIP = '3f2504e0-4f89-41d3-9a0c-0305e82c3304';
const RECORD = '3f2504e0-4f89-41d3-9a0c-0305e82c3305';
const OLD_DRIVER = '3f2504e0-4f89-41d3-9a0c-0305e82c3306';
const NOW = new Date('2026-11-02T05:00:00Z');
const START = new Date('2026-11-02T09:00:00Z');
const END = new Date('2026-11-02T10:00:00Z');

const dispatcher: RequestUser = {
  id: '10',
  publicId: '11111111-1111-4111-8111-111111111111',
  roles: ['dispatcher'],
  permissions: ['trip:assign'],
  depotId: '5',
};
const caller = { user: dispatcher, correlationId: '22222222-2222-4222-8222-222222222222' };

const available: AvailabilityAnswer = { availability: 'available', reasons: [] };
const blocked = (...codes: string[]): AvailabilityAnswer => ({ availability: 'unavailable', reasons: codes.map((code) => ({ code, severity: 'block' })) });
const warned = (...codes: string[]): AvailabilityAnswer => ({ availability: 'available_with_warning', reasons: codes.map((code) => ({ code, severity: 'warning' })) });

function tripRow(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: '100',
    publicId: TRIP,
    routeId: '1',
    routePublicId: 'r',
    routeName: 'Route',
    depotId: '5',
    vehicleId: null,
    driverId: null,
    status: 'scheduled',
    origin: null,
    destination: null,
    plannedDistanceKm: null,
    plannedDurationSeconds: null,
    scheduledStart: START,
    scheduledEnd: END,
    actualStart: null,
    actualEnd: null,
    actualDistanceKm: null,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    at: '',
    ...overrides,
  };
}

interface Options {
  trip?: Partial<TripRow> | null;
  vehicle?: { status?: string; maintenanceFlag?: boolean } | null;
  driver?: object | null;
  vehicleAnswer?: AvailabilityAnswer;
  driverAnswer?: AvailabilityAnswer;
  eligibility?: { eligible: boolean; reasons: string[] };
  /** Public id of the trip each overlap query finds, per column; null: no clash. */
  clash?: { driver_id?: string | null; vehicle_id?: string | null };
  /** Trips still under way, per column. */
  underWay?: { driver_id?: { publicId: string; scheduledEnd: Date | null }[]; vehicle_id?: { publicId: string; scheduledEnd: Date | null }[] };
  openRecord?: string | null;
  graceMinutes?: number;
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const queried: Record<string, unknown[]> = {};
  const tx = {} as PoolClient;
  const events = new RecordingEventBus();
  const row = options.trip === null ? null : tripRow(options.trip);
  const assigned = tripRow({ ...options.trip, status: 'assigned', driverId: '9', vehicleId: '7', version: (row?.version ?? 3) + 1 });

  const fleet: FleetRefs = {
    depots: { resolveInScope: async () => '5', publicIds: async () => new Map([['5', 'depot-public']]) },
    vehicles: {
      idOf: async () => '7',
      publicIds: async () => new Map([['7', VEHICLE]]),
      forAssignment: async () => {
        calls.push('vehicle');
        return options.vehicle === null ? null : { id: '7', publicId: VEHICLE, status: 'active', maintenanceFlag: false, ...options.vehicle };
      },
    },
    drivers: {
      idOf: async () => '9',
      idOfUser: async () => null,
      publicIds: async () => new Map([['9', DRIVER], ['8', OLD_DRIVER]]),
      forAssignment: async () => {
        calls.push('driver');
        return options.driver === null ? null : { id: '9', publicId: DRIVER };
      },
      eligibility: async (_db, driverId, at, vehicleId) => {
        calls.push('eligibility');
        queried.eligibility = [driverId, at, vehicleId];
        return options.eligibility ?? { eligible: true, reasons: [] };
      },
    },
    availability: {
      check: async (_db, query) => {
        calls.push('availability');
        queried.availability = [query];
        return { vehicles: new Map([['7', options.vehicleAnswer ?? available]]), drivers: new Map([['9', options.driverAnswer ?? available]]) };
      },
    },
  };

  const trips: TripServiceDeps['trips'] = {
    inTransaction: (fn) => fn(tx),
    findVisible: async () => {
      calls.push('trip');
      return row;
    },
    findById: async () => assigned,
    stops: async () => [],
    overlapping: async (_db, column, id, start, end, exceptTripId) => {
      calls.push(`overlap:${column}`);
      queried[`overlap:${column}`] = [id, start, end, exceptTripId];
      return options.clash?.[column] ?? null;
    },
    underWay: async (_db, column) => options.underWay?.[column] ?? [],
    update: async (_ctx, _id, data) => {
      calls.push(`update:${Object.keys(data).sort().join(',')}`);
      return { id: '100' };
    },
    history: async () => ({ rows: [], more: false }),
    routePlan: async () => null,
    routeId: async () => null,
    insert: async () => ({ id: '1' }),
    insertStop: async () => ({ id: '1' }),
  };

  const service = new TripService({
    trips,
    fleet: () => fleet,
    maintenance: () => ({ openRecordFor: async () => (options.openRecord === undefined ? RECORD : options.openRecord) }),
    events,
    overrunGraceMinutes: options.graceMinutes ?? 15,
    now: () => NOW,
  });
  return { service, calls, queried, published: events.published };
}

const assign = (service: TripService, version = 3) => service.assign(caller, TRIP, { driver_id: DRIVER, vehicle_id: VEHICLE, version });

async function refused(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

/** A refusal changes nothing: no write, no event. */
function expectUntouched(h: ReturnType<typeof harness>) {
  expect(h.calls.filter((c) => c.startsWith('update'))).toEqual([]);
  expect(h.published).toEqual([]);
}

describe('a clean assignment', () => {
  test('runs the checks in order, writes driver, vehicle and status together, and publishes TripAssigned', async () => {
    const h = harness();
    const { trip, warnings } = await assign(h.service);

    expect(h.calls).toEqual(['trip', 'vehicle', 'driver', 'availability', 'eligibility', 'overlap:driver_id', 'overlap:vehicle_id', 'update:driver_id,status,vehicle_id']);
    expect(trip).toMatchObject({ id: TRIP, status: 'assigned', driver_id: DRIVER, vehicle_id: VEHICLE, version: 4 });
    expect(warnings).toEqual([]);
    expect(h.published.map((e) => e.type)).toEqual(['TripAssigned']);
    expect(h.published[0]).toMatchObject({
      actor: dispatcher.publicId,
      aggregate: `trip:${TRIP}`,
      payload: { trip_id: TRIP, driver_id: DRIVER, vehicle_id: VEHICLE, previous_driver_id: null, previous_vehicle_id: null, scheduled_start: START.toISOString(), scheduled_end: END.toISOString() },
    });
  });

  test("both overlap checks cover the trip's whole window and leave the trip itself out", async () => {
    const h = harness();
    await assign(h.service);
    expect(h.queried['overlap:driver_id']).toEqual(['9', START, END, '100']);
    expect(h.queried['overlap:vehicle_id']).toEqual(['7', START, END, '100']);
  });

  test("eligibility is judged on the trip's start for this vehicle, and availability on a window that starts there", async () => {
    const h = harness();
    await assign(h.service);
    expect(h.queried.eligibility).toEqual(['9', START, '7']);
    expect(h.queried.availability).toEqual([
      { vehicleIds: ['7'], driverIds: ['9'], window: { start: START, end: START }, excludeTripId: TRIP, depotId: '5' },
    ]);
  });

  test('assigning the same driver and vehicle again changes nothing and publishes nothing', async () => {
    const h = harness({ trip: { status: 'assigned', driverId: '9', vehicleId: '7' } });
    await assign(h.service);
    expectUntouched(h);
  });

  test('swapping the driver writes once and names the previous driver', async () => {
    const h = harness({ trip: { status: 'assigned', driverId: '8', vehicleId: '7' } });
    await assign(h.service);
    expect(h.calls.filter((c) => c.startsWith('update'))).toEqual(['update:driver_id,status,vehicle_id']);
    expect(h.published[0].payload).toMatchObject({ driver_id: DRIVER, previous_driver_id: OLD_DRIVER, previous_vehicle_id: VEHICLE });
  });
});

describe('BR-1: the driver cannot be in two places', () => {
  test('a driver clash is 409 CONFLICT_DRIVER_OVERLAP naming the other trip, and nothing is written', async () => {
    const h = harness({ clash: { driver_id: OTHER_TRIP } });
    const err = await refused(assign(h.service));
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT_DRIVER_OVERLAP' });
    expect(err.details).toEqual([{ field: 'driver_id', reason: 'overlapping_trip', record_id: OTHER_TRIP }]);
    expectUntouched(h);
  });

  test('no clash for the driver: the assignment goes ahead', async () => {
    const h = harness({ clash: { driver_id: null } });
    await expect(assign(h.service)).resolves.toMatchObject({ trip: { status: 'assigned' } });
  });

  test('the driver is checked before the vehicle: with both clashing, BR-1 answers and BR-3 is never asked', async () => {
    const h = harness({ clash: { driver_id: OTHER_TRIP, vehicle_id: 'someone-else' } });
    expect((await refused(assign(h.service))).code).toBe('CONFLICT_DRIVER_OVERLAP');
    expect(h.calls).not.toContain('overlap:vehicle_id');
  });
});

describe('BR-3: the vehicle cannot be on two trips', () => {
  test('a vehicle clash is 409 CONFLICT_VEHICLE_OVERLAP naming the other trip, and nothing is written', async () => {
    const h = harness({ clash: { vehicle_id: OTHER_TRIP } });
    const err = await refused(assign(h.service));
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT_VEHICLE_OVERLAP' });
    expect(err.details).toEqual([{ field: 'vehicle_id', reason: 'overlapping_trip', record_id: OTHER_TRIP }]);
    expectUntouched(h);
  });

  test('a free driver does not excuse a busy vehicle: both are always checked', async () => {
    const h = harness({ clash: { driver_id: null, vehicle_id: OTHER_TRIP } });
    await refused(assign(h.service));
    expect(h.calls).toEqual(expect.arrayContaining(['overlap:driver_id', 'overlap:vehicle_id']));
  });
});

describe('BR-2: a flagged vehicle is not dispatched', () => {
  test('a maintenance flag is 409 CONFLICT_VEHICLE_FLAGGED naming the open maintenance record', async () => {
    const h = harness({ vehicleAnswer: blocked('maintenance_flag') });
    const err = await refused(assign(h.service));
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT_VEHICLE_FLAGGED' });
    expect(err.details).toEqual([{ field: 'vehicle_id', reason: 'maintenance_flag', record_id: RECORD }]);
    expectUntouched(h);
  });

  test('a vehicle in the workshop is refused the same way', async () => {
    const h = harness({ vehicleAnswer: blocked('vehicle_in_maintenance') });
    expect((await refused(assign(h.service))).code).toBe('CONFLICT_VEHICLE_FLAGGED');
  });

  test('a flag with no open record is still refused, just without a record id', async () => {
    const h = harness({ vehicleAnswer: blocked('maintenance_flag'), openRecord: null });
    expect((await refused(assign(h.service))).details).toEqual([{ field: 'vehicle_id', reason: 'maintenance_flag' }]);
  });

  test('an unflagged vehicle is allowed', async () => {
    const h = harness({ vehicleAnswer: available });
    await expect(assign(h.service)).resolves.toBeDefined();
  });

  test('the order of checks: BR-2 is read before the overlaps, so with both failing BR-2 answers and the overlaps are never queried', async () => {
    const h = harness({ vehicleAnswer: blocked('maintenance_flag'), clash: { driver_id: OTHER_TRIP, vehicle_id: OTHER_TRIP } });
    expect((await refused(assign(h.service))).code).toBe('CONFLICT_VEHICLE_FLAGGED');
    expect(h.calls).not.toContain('overlap:driver_id');
    expect(h.calls).not.toContain('overlap:vehicle_id');
  });
});

describe('eligibility: the driver must be able to drive this vehicle', () => {
  test('an expired licence blocks: 409 CONFLICT_DRIVER_NOT_ELIGIBLE with the reason, and nothing is written', async () => {
    const h = harness({ eligibility: { eligible: false, reasons: ['license_expired'] } });
    const err = await refused(assign(h.service));
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT_DRIVER_NOT_ELIGIBLE' });
    expect(err.details).toEqual([{ field: 'driver_id', reason: 'license_expired' }]);
    expectUntouched(h);
  });

  test('every reason is listed, not just the first', async () => {
    const h = harness({ eligibility: { eligible: false, reasons: ['driver_retired', 'license_expired', 'license_class_mismatch'] } });
    const err = await refused(assign(h.service));
    expect(err.details?.map((d) => d.reason)).toEqual(['driver_retired', 'license_expired', 'license_class_mismatch']);
  });

  test('an ineligible driver is refused before the overlaps are looked at', async () => {
    const h = harness({ eligibility: { eligible: false, reasons: ['license_expired'] }, clash: { driver_id: OTHER_TRIP } });
    expect((await refused(assign(h.service))).code).toBe('CONFLICT_DRIVER_NOT_ELIGIBLE');
    expect(h.calls).not.toContain('overlap:driver_id');
  });

  test('an eligible driver is allowed', async () => {
    const h = harness({ eligibility: { eligible: true, reasons: [] } });
    await expect(assign(h.service)).resolves.toBeDefined();
  });
});

describe("fleet availability (FMS-76) before the trip's own rules", () => {
  test.each([
    ['vehicle_other_depot', blocked('vehicle_other_depot'), available, 'CONFLICT_DEPOT_MISMATCH', 'vehicle_id', 'other_depot'],
    ['driver_other_depot', available, blocked('driver_other_depot'), 'CONFLICT_DEPOT_MISMATCH', 'driver_id', 'other_depot'],
    ['vehicle_retired', blocked('vehicle_retired'), available, 'CONFLICT_INVALID_STATE_TRANSITION', 'vehicle_id', 'vehicle_retired'],
    ['vehicle_out_of_service', blocked('vehicle_out_of_service'), available, 'CONFLICT_INVALID_STATE_TRANSITION', 'vehicle_id', 'vehicle_inactive'],
  ])('%s is refused as %s on %s', async (_code, vehicleAnswer, driverAnswer, code, field, reason) => {
    const h = harness({ vehicleAnswer, driverAnswer });
    const err = await refused(assign(h.service));
    expect(err.code).toBe(code);
    expect(err.details).toEqual([{ field, reason }]);
    expectUntouched(h);
  });

  test("a driver's absence is a warning: the assignment goes ahead and says so", async () => {
    const h = harness({ driverAnswer: warned('driver_sick') });
    const { warnings } = await assign(h.service);
    expect(warnings).toEqual([{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'sick' }]);
    expect(h.calls.some((c) => c.startsWith('update'))).toBe(true);
  });
});

describe('a trip still under way (overrun) warns, never blocks', () => {
  const underWay = (scheduledEnd: Date | null) => [{ publicId: OTHER_TRIP, scheduledEnd }];

  test('one that is expected to end after this trip starts is a PREVIOUS_TRIP_OVERRUN warning', async () => {
    const h = harness({ underWay: { driver_id: underWay(new Date('2026-11-02T09:10:00Z')) } });
    const { warnings } = await assign(h.service);
    expect(warnings).toEqual([{ warning: 'PREVIOUS_TRIP_OVERRUN', field: 'driver_id', trip_id: OTHER_TRIP, expected_end: '2026-11-02T09:10:00.000Z' }]);
  });

  test('the grace buffer counts: ending 10 minutes before the start still warns with a 15-minute buffer, not with 5', async () => {
    const ends = new Date('2026-11-02T08:50:00Z');
    expect((await assign(harness({ underWay: { vehicle_id: underWay(ends) } }).service)).warnings).toHaveLength(1);
    expect((await assign(harness({ underWay: { vehicle_id: underWay(ends) }, graceMinutes: 5 }).service)).warnings).toEqual([]);
  });

  test('one already late is expected to end now; one far ahead of the start is no warning', async () => {
    const late = await assign(harness({ underWay: { driver_id: underWay(new Date('2026-11-02T03:00:00Z')) } }).service);
    expect(late.warnings).toEqual([]); // now is 05:00, four hours before the 09:00 start
    const veryLate = await assign(harness({ trip: { scheduledStart: new Date('2026-11-02T05:10:00Z') }, underWay: { driver_id: underWay(new Date('2026-11-02T03:00:00Z')) } }).service);
    expect(veryLate.warnings).toEqual([{ warning: 'PREVIOUS_TRIP_OVERRUN', field: 'driver_id', trip_id: OTHER_TRIP, expected_end: NOW.toISOString() }]);
  });
});

describe('what cannot be assigned at all', () => {
  test.each<TripStatus>(['draft', 'en_route', 'completed', 'cancelled'])('a %s trip is 409 and no fleet lookup is made', async (status) => {
    const h = harness({ trip: { status } });
    const err = await refused(assign(h.service));
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT_INVALID_STATE_TRANSITION' });
    expect(h.calls).toEqual(['trip']);
  });

  test('a scheduled and an already assigned trip can be (re)assigned', async () => {
    for (const status of ['scheduled', 'assigned'] as const) await expect(assign(harness({ trip: { status } }).service)).resolves.toBeDefined();
  });

  test('a trip without both times cannot be assigned', async () => {
    const h = harness({ trip: { scheduledEnd: null } });
    expect((await refused(assign(h.service))).code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
  });

  test('a stale version is 409 CONFLICT_CONCURRENT_MODIFICATION before anything else is read', async () => {
    const h = harness({ trip: { version: 5 } });
    expect((await refused(assign(h.service, 3))).code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
    expect(h.calls).toEqual(['trip']);
  });

  test('a trip the caller cannot see is 404; an unknown vehicle or driver is 400 references_missing_record', async () => {
    expect((await refused(assign(harness({ trip: null }).service))).code).toBe('NOT_FOUND');

    const noVehicle = await refused(assign(harness({ vehicle: null }).service));
    expect(noVehicle).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(noVehicle.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);

    const noDriver = await refused(assign(harness({ driver: null }).service));
    expect(noDriver.details).toEqual([{ field: 'driver_id', reason: 'references_missing_record' }]);
  });
});
