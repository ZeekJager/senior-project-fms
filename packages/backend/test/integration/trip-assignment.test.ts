import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { maintenanceRefs } from '../../src/modules/maintenance';
import { tripRefs } from '../../src/modules/fleet';
import { TripService } from '../../src/modules/trip/application/trip.service';
import { TripRepository } from '../../src/modules/trip/infrastructure/trip.repository';
import { RecordingEventBus } from '../../src/shared/events/recording-event-bus';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Assign-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const assign = (cookie: string, trip: Row, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/trips/${trip.public_id}/assign`).set('Cookie', cookie).send(body);

/** A truck driver (licence class C, valid) in the depot. */
async function truckDriver(depot: Depot, extra: Record<string, unknown> = {}) {
  return (await createDriver({ depot, license_categories: ['C'], ...extra })).driver;
}

async function route(depot: Depot) {
  const res = await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Addis Ababa - Adama ' || gen_random_uuid(), $1) RETURNING *", [depot.id]);
  return res.rows[0];
}

/** A scheduled (unassigned) trip on a depot route. */
async function scheduled(depot: Depot, start: string, end: string) {
  const r = await route(depot);
  const res = await pool.query<Row>(
    "INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', $2, $3) RETURNING *",
    [r.id, start, end],
  );
  return res.rows[0];
}

/** A depot with a dispatcher, a truck, a truck driver and a scheduled trip 06:00-09:00. */
async function setup() {
  const depot = await createDepot();
  const cookie = await signIn(['dispatcher'], depot);
  const vehicle = await createVehicle({ depot });
  const driver = await truckDriver(depot);
  const trip = await scheduled(depot, '2026-11-02T06:00:00Z', '2026-11-02T09:00:00Z');
  return { depot, cookie, vehicle, driver, trip };
}

describe('POST /trips/{id}/assign', () => {
  test('assigns a driver and vehicle: status assigned, version up, audited, TripAssigned published', async () => {
    const s = await setup();
    const res = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.data).toMatchObject({ id: s.trip.public_id, status: 'assigned', driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 1 });
    expect(res.body.meta.warnings).toEqual([]);
    const audit = await pool.query('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1', [res.headers['x-request-id']]);
    expect(audit.rows).toEqual([{ action: 'UPDATE', entity_type: 'trip.trips' }]);

    const [event] = await publishedEvents('TripAssigned');
    expect(event.payload).toEqual({
      trip_id: s.trip.public_id,
      driver_id: s.driver.public_id,
      vehicle_id: s.vehicle.public_id,
      previous_driver_id: null,
      previous_vehicle_id: null,
      route_id: expect.any(String),
      depot_id: s.depot.public_id,
      scheduled_start: '2026-11-02T06:00:00.000Z',
      scheduled_end: '2026-11-02T09:00:00.000Z',
    });
    expect(event.aggregate).toBe(`trip:${s.trip.public_id}`);
  });

  test('BR-1: an overlapping driver returns 409 CONFLICT_DRIVER_OVERLAP with the conflicting trip id', async () => {
    const s = await setup();
    const busy = await createTrip({ vehicle: await createVehicle({ depot: s.depot }), driver: s.driver, scheduled_start: '2026-11-02T08:00:00Z', scheduled_end: '2026-11-02T11:00:00Z' });
    const res = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DRIVER_OVERLAP', details: [{ field: 'driver_id', reason: 'overlapping_trip', record_id: busy.public_id }] });
    expect((await pool.query('SELECT status, driver_id FROM trip.trips WHERE id = $1', [s.trip.id])).rows[0]).toEqual({ status: 'scheduled', driver_id: null });
    expect(await publishedEvents('TripAssigned')).toEqual([]);
  });

  test('a 0-minute gap is an overlap; a 1-minute gap is not', async () => {
    const s = await setup();
    // The driver's earlier trip ends exactly when this one starts.
    const before = await createTrip({ vehicle: await createVehicle({ depot: s.depot }), driver: s.driver, scheduled_start: '2026-11-02T03:00:00Z', scheduled_end: '2026-11-02T06:00:00Z' });
    const touching = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(touching.status).toBe(409);
    expect(touching.body.error.details[0].record_id).toBe(before.public_id);

    await pool.query("UPDATE trip.trips SET scheduled_end = '2026-11-02T05:59:00Z' WHERE id = $1", [before.id]);
    expect((await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 })).status).toBe(200);
  });

  test('the database refuses a touching pair too, whoever writes it (migration 030)', async () => {
    const s = await setup();
    await createTrip({ vehicle: s.vehicle, driver: s.driver, scheduled_start: '2026-11-03T06:00:00Z', scheduled_end: '2026-11-03T08:00:00Z' });
    await expect(
      createTrip({ vehicle: await createVehicle({ depot: s.depot }), driver: s.driver, scheduled_start: '2026-11-03T08:00:00Z', scheduled_end: '2026-11-03T10:00:00Z' }),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'ex_trip_driver_overlap' });
  });

  test('BR-3: an overlapping vehicle returns 409 CONFLICT_VEHICLE_OVERLAP with the conflicting trip id', async () => {
    const s = await setup();
    const busy = await createTrip({ vehicle: s.vehicle, driver: await truckDriver(s.depot), scheduled_start: '2026-11-02T05:00:00Z', scheduled_end: '2026-11-02T07:00:00Z' });
    const res = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_VEHICLE_OVERLAP', details: [{ field: 'vehicle_id', reason: 'overlapping_trip', record_id: busy.public_id }] });
  });

  test('BR-2: a flagged vehicle returns 409 CONFLICT_VEHICLE_FLAGGED with the maintenance record id', async () => {
    const s = await setup();
    const repair = await request(app)
      .post('/api/v1/maintenance')
      .set('Cookie', await signIn(['fleet_manager']))
      .send({ vehicle_id: s.vehicle.public_id, description: 'Brake pads worn', labour_hours: 2, total_cost_cents: 150000 });
    expect(repair.status).toBe(201);

    const res = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_VEHICLE_FLAGGED', details: [{ field: 'vehicle_id', reason: 'maintenance_flag', record_id: repair.body.data.id }] });
  });

  test('an ineligible driver is 409 CONFLICT_DRIVER_NOT_ELIGIBLE with every reason', async () => {
    const s = await setup();
    const expired = await truckDriver(s.depot, { license_expiry: '2026-10-01', license_categories: ['B'] });
    const res = await assign(s.cookie, s.trip, { driver_id: expired.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DRIVER_NOT_ELIGIBLE');
    expect(res.body.error.details).toEqual([
      { field: 'driver_id', reason: 'license_expired' },
      { field: 'driver_id', reason: 'license_category_not_valid_for_vehicle' },
    ]);
  });

  test('a stale version returns 409 CONFLICT_CONCURRENT_MODIFICATION; a missing one is 400', async () => {
    const s = await setup();
    await pool.query("UPDATE trip.trips SET scheduled_end = '2026-11-02T09:30:00Z' WHERE id = $1", [s.trip.id]);
    const stale = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
    const missing = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id });
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'version' })]);
  });

  test('re-assigning swaps the driver and names the previous one; the same assignment again changes nothing', async () => {
    const s = await setup();
    const first = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    const other = await truckDriver(s.depot);
    const swap = await assign(s.cookie, s.trip, { driver_id: other.public_id, vehicle_id: s.vehicle.public_id, version: first.body.data.version });
    expect(swap.body.data).toMatchObject({ driver_id: other.public_id, version: 2 });
    expect((await publishedEvents('TripAssigned'))[1].payload).toMatchObject({ driver_id: other.public_id, previous_driver_id: s.driver.public_id, previous_vehicle_id: s.vehicle.public_id });

    const same = await assign(s.cookie, s.trip, { driver_id: other.public_id, vehicle_id: s.vehicle.public_id, version: 2 });
    expect(same.body.data.version).toBe(2);
    expect(await publishedEvents('TripAssigned')).toHaveLength(2);
  });

  test('only scheduled or assigned trips can be assigned; vehicles and drivers must be in your depots and active', async () => {
    const s = await setup();
    const body = { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 };
    const draft = await pool.query<Row>("INSERT INTO trip.trips (route_id, status) VALUES ($1, 'draft') RETURNING *", [(await route(s.depot)).id]);
    expect((await assign(s.cookie, draft.rows[0], body)).body.error.details).toEqual([{ field: 'status', reason: 'trip_draft' }]);
    const cancelled = await scheduled(s.depot, '2026-11-05T06:00:00Z', '2026-11-05T07:00:00Z');
    await pool.query("UPDATE trip.trips SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    expect((await assign(s.cookie, cancelled, { ...body, version: 1 })).body.error.details).toEqual([{ field: 'status', reason: 'trip_cancelled' }]);

    const elsewhere = await createDepot();
    expect((await assign(s.cookie, s.trip, { ...body, vehicle_id: (await createVehicle({ depot: elsewhere })).public_id })).body.error.details).toEqual([
      { field: 'vehicle_id', reason: 'references_missing_record' },
    ]);
    expect((await assign(s.cookie, s.trip, { ...body, driver_id: (await truckDriver(elsewhere)).public_id })).body.error.details).toEqual([
      { field: 'driver_id', reason: 'references_missing_record' },
    ]);
    const parked = await createVehicle({ depot: s.depot, status: 'inactive' });
    expect((await assign(s.cookie, s.trip, { ...body, vehicle_id: parked.public_id })).body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_inactive' }]);
  });

  test("a trip is staffed from its own depot: another depot's vehicle or driver is 409 CONFLICT_DEPOT_MISMATCH, even for a fleet manager", async () => {
    const s = await setup();
    const manager = await signIn(['fleet_manager']);
    const elsewhere = await createDepot();
    const body = { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 };

    const lentVehicle = await assign(manager, s.trip, { ...body, vehicle_id: (await createVehicle({ depot: elsewhere })).public_id });
    expect(lentVehicle.status).toBe(409);
    expect(lentVehicle.body.error).toMatchObject({ code: 'CONFLICT_DEPOT_MISMATCH', details: [{ field: 'vehicle_id', reason: 'other_depot' }] });

    const lentDriver = await assign(manager, s.trip, { ...body, driver_id: (await truckDriver(elsewhere)).public_id });
    expect(lentDriver.status).toBe(409);
    expect(lentDriver.body.error).toMatchObject({ code: 'CONFLICT_DEPOT_MISMATCH', details: [{ field: 'driver_id', reason: 'other_depot' }] });

    expect((await assign(manager, s.trip, body)).status).toBe(200);
  });

  test('a driver marked absent that day is assigned, with a DRIVER_ATTENDANCE warning', async () => {
    const s = await setup();
    const clerk = await createUser({ roles: ['depot_admin'], depot: s.depot });
    // The trip starts 2026-11-02 06:00 UTC: 09:00 in Addis Ababa, the same day.
    await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, '2026-11-02', 'absent', $2)", [s.driver.id, clerk.id]);
    const res = await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings).toEqual([{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }]);
  });

  test('a vehicle in the workshop (status maintenance, no flag) is BR-2 too; out of service is not active', async () => {
    const s = await setup();
    const body = { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 };
    const workshop = await createVehicle({ depot: s.depot, status: 'maintenance' });
    expect((await assign(s.cookie, s.trip, { ...body, vehicle_id: workshop.public_id })).body.error).toMatchObject({
      code: 'CONFLICT_VEHICLE_FLAGGED',
      details: [{ field: 'vehicle_id', reason: 'maintenance_flag' }],
    });
    const retired = await createVehicle({ depot: s.depot, status: 'retired', is_active: false });
    expect((await assign(s.cookie, s.trip, { ...body, vehicle_id: retired.public_id })).body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_retired' }]);
  });

  test("the assignment shows in fleet availability at once (the trip change's own transaction)", async () => {
    const s = await setup();
    expect((await assign(s.cookie, s.trip, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 })).status).toBe(200);
    const status = await request(app).get(`/api/v1/vehicles/${s.vehicle.public_id}/status?from=2026-11-02T07:00:00Z&to=2026-11-02T08:00:00Z`).set('Cookie', s.cookie);
    expect(status.body.data.availability).toMatchObject({ availability: 'unavailable', reasons: [{ code: 'assigned_to_overlapping_trip', trip_id: s.trip.public_id }] });
  });

  test('trip:assign is required: a driver and a depot admin get 403', async () => {
    const s = await setup();
    const body = { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 };
    expect((await assign(await signIn(['driver'], s.depot), s.trip, body)).status).toBe(403);
    expect((await assign(await signIn(['depot_admin'], s.depot), s.trip, body)).status).toBe(403);
  });
});

describe('overrun warning', () => {
  test('a trip still under way that runs into this one is a warning, not a block', async () => {
    const s = await setup();
    // Under way and already 2 hours late: it ends no earlier than now, after this trip's start.
    const late = await createTrip({
      vehicle: await createVehicle({ depot: s.depot }),
      driver: s.driver,
      status: 'en_route',
      scheduled_start: '2026-10-01T02:00:00Z',
      scheduled_end: '2026-10-01T04:00:00Z',
      actual_start: '2026-10-01T02:05:00Z',
    });
    const now = new Date('2026-10-01T06:00:00Z');
    const early = await scheduled(s.depot, '2026-10-01T05:00:00Z', '2026-10-01T07:00:00Z');
    const service = (grace: number) =>
      new TripService({ trips: new TripRepository(pool), fleet: () => tripRefs, maintenance: () => maintenanceRefs, events: new RecordingEventBus(), overrunGraceMinutes: grace, now: () => now });
    const admin = await createUser({ roles: ['admin'] });
    const caller = { user: { id: admin.id, publicId: admin.public_id as string, roles: ['admin'], permissions: [], depotId: null }, correlationId: randomUUID() };

    const result = await service(0).assign(caller, early.public_id as string, { driver_id: s.driver.public_id as string, vehicle_id: s.vehicle.public_id as string, version: 0 });
    expect(result.trip.status).toBe('assigned');
    expect(result.warnings).toEqual([{ warning: 'PREVIOUS_TRIP_OVERRUN', field: 'driver_id', trip_id: late.public_id, expected_end: '2026-10-01T06:00:00.000Z' }]);

    // With no overrun but a 60-minute buffer: a trip under way ending 30 minutes before the next start warns.
    const onTime = await createTrip({
      vehicle: await createVehicle({ depot: s.depot }),
      driver: await truckDriver(s.depot),
      status: 'en_route',
      scheduled_start: '2026-10-01T05:00:00Z',
      scheduled_end: '2026-10-01T08:00:00Z',
    });
    const next = await scheduled(s.depot, '2026-10-01T08:30:00Z', '2026-10-01T10:00:00Z');
    const nextDriver = (await pool.query<{ public_id: string }>('SELECT public_id FROM fleet.drivers WHERE id = $1', [onTime.driver_id])).rows[0].public_id;
    const truck = await createVehicle({ depot: s.depot });
    const buffered = await service(60).assign(caller, next.public_id as string, { driver_id: nextDriver, vehicle_id: truck.public_id as string, version: 0 });
    expect(buffered.warnings).toEqual([expect.objectContaining({ field: 'driver_id', trip_id: onTime.public_id, expected_end: '2026-10-01T08:00:00.000Z' })]);
    await pool.query("UPDATE trip.trips SET status = 'scheduled', driver_id = NULL, vehicle_id = NULL WHERE id = $1", [next.id]);
    const unbuffered = await service(0).assign(caller, next.public_id as string, { driver_id: nextDriver, vehicle_id: truck.public_id as string, version: 2 });
    expect(unbuffered.warnings).toEqual([]);
  });
});
