import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Board-Test-1';
const HOUR = 60 * 60 * 1000;

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A trip of the depot, written directly, then announced so fleet's read model holds it (as the trip API would). */
async function trip(depot: Depot, fields: Record<string, unknown>): Promise<Row> {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Board ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
  const row = { route_id: route.id, ...fields };
  const keys = Object.keys(row);
  const res = await pool.query<Row>(`INSERT INTO trip.trips (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(row));
  await pool.query(
    "INSERT INTO fleet.trip_assignments (trip_id, vehicle_id, driver_id, status, during) SELECT public_id, vehicle_id, driver_id, status::text, tstzrange(scheduled_start, scheduled_end, '[]') FROM trip.trips WHERE id = $1 AND status IN ('assigned', 'en_route')",
    [res.rows[0].id],
  );
  return res.rows[0];
}

const board = (cookie: string, query: Record<string, string>) => request(app).get(`/api/v1/dispatch/availability?${new URLSearchParams(query)}`).set('Cookie', cookie);

describe('GET /dispatch/availability', () => {
  test("a depot's drivers and vehicles with their state now and their availability for the trip's window", async () => {
    const depot = await createDepot();
    const dispatcher = await signIn(['dispatcher'], depot);
    const clerk = await createUser({ roles: ['depot_admin'], depot });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());

    const idle = await createDriver({ depot, license_categories: ['C'] });
    const absent = await createDriver({ depot, license_categories: ['B'] });
    await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, $2, 'absent', $3)", [absent.driver.id, today, clerk.id]);
    const busy = await createDriver({ depot });
    const truck = await createVehicle({ depot, vehicle_type: 'truck' });
    const flagged = await createVehicle({ depot, maintenance_flag: true });
    await pool.query("INSERT INTO maintenance.maintenance_records (vehicle_id, description, status, priority) VALUES ($1, 'Brake pads worn', 'open', 'high')", [flagged.id]);
    const onRoad = await createVehicle({ depot });
    const underWay = await trip(depot, {
      status: 'en_route',
      driver_id: busy.driver.id,
      vehicle_id: onRoad.id,
      scheduled_start: new Date(Date.now() - HOUR),
      scheduled_end: new Date(Date.now() + 2 * HOUR),
    });
    await createDriver({ depot: await createDepot() });

    const from = new Date(Date.now() + 3 * HOUR).toISOString();
    const to = new Date(Date.now() + 5 * HOUR).toISOString();
    const res = await board(dispatcher, { from, to });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ depot_id: depot.public_id, window: { start: from, end: to } });

    const drivers = new Map(res.body.data.drivers.map((d: { driver_id: string }) => [d.driver_id, d]));
    expect(drivers.size).toBe(3);
    expect(drivers.get(idle.driver.public_id)).toMatchObject({ state: 'idle', attendance: null, vehicle_types: expect.arrayContaining(['truck']), availability: { availability: 'available' } });
    expect(drivers.get(absent.driver.public_id)).toMatchObject({
      state: 'absent',
      attendance: 'absent',
      availability: { availability: 'available_with_warning', reasons: [{ code: 'driver_absent', severity: 'warning' }] },
    });
    // Under way now, but free for a window after the trip ends.
    expect(drivers.get(busy.driver.public_id)).toMatchObject({ state: 'en_route', current_trip: { trip_id: underWay.public_id }, availability: { availability: 'available' } });

    const vehicles = new Map(res.body.data.vehicles.map((v: { vehicle_id: string }) => [v.vehicle_id, v]));
    expect(vehicles.get(truck.public_id)).toMatchObject({ state: 'idle', vehicle_type: 'truck', open_work: null });
    expect(vehicles.get(flagged.public_id)).toMatchObject({
      state: 'flagged',
      availability: { availability: 'unavailable', reasons: [{ code: 'maintenance_flag' }] },
      open_work: { description: 'Brake pads worn', status: 'open', priority: 'high', id: expect.any(String), opened_at: expect.any(String) },
    });
    expect(vehicles.get(onRoad.public_id)).toMatchObject({ state: 'en_route', current_trip: { trip_id: underWay.public_id } });
  });

  test("the window decides availability: a driver on another trip then is unavailable, unless that is the trip being staffed", async () => {
    const depot = await createDepot();
    const dispatcher = await signIn(['dispatcher'], depot);
    const { driver } = await createDriver({ depot });
    const assigned = await trip(depot, {
      status: 'assigned',
      driver_id: driver.id,
      vehicle_id: (await createVehicle({ depot })).id,
      scheduled_start: new Date('2029-06-01T06:00:00Z'),
      scheduled_end: new Date('2029-06-01T08:00:00Z'),
    });
    const window = { from: '2029-06-01T07:00:00Z', to: '2029-06-01T09:00:00Z' };
    const clash = (await board(dispatcher, window)).body.data.drivers[0];
    expect(clash).toMatchObject({ state: 'unavailable', availability: { reasons: [{ code: 'assigned_to_overlapping_trip', trip_id: assigned.public_id }] } });
    const self = (await board(dispatcher, { ...window, exclude_trip_id: String(assigned.public_id) })).body.data.drivers[0];
    expect(self).toMatchObject({ state: 'idle', availability: { availability: 'available' } });
  });

  test('depot scope: a depot-scoped dispatcher gets their own depot; someone who sees all must choose; another depot is 400', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager']);
    expect((await board(manager, {})).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'depot_id', reason: 'required' }] });
    expect((await board(manager, { depot_id: String(depot.public_id) })).body.data.depot_id).toBe(depot.public_id);

    const dispatcher = await signIn(['dispatcher'], depot);
    const elsewhere = await createDepot();
    expect((await board(dispatcher, { depot_id: String(elsewhere.public_id) })).body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
  });

  test('trip:assign is needed: a driver and a depot admin get 403; a bad window is 400', async () => {
    const depot = await createDepot();
    expect((await board(await signIn(['driver'], depot), {})).status).toBe(403);
    expect((await board(await signIn(['depot_admin'], depot), {})).status).toBe(403);
    const dispatcher = await signIn(['dispatcher'], depot);
    expect((await board(dispatcher, { from: '2026-11-02T10:00:00Z', to: '2026-11-02T08:00:00Z' })).body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
  });
});
