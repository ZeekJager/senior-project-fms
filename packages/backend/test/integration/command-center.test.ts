import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { addisDayOf } from '../../src/modules/command-center/domain/overview';
import { cache } from '../../src/shared/cache';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-89: GET /command-center/overview. What needs attention on the live map, counted for the caller's depot:
// vehicles and their health, drivers, the day's trips, and the active alerts and incidents.

const app = createApp();
const PASSWORD = 'Command-Center-1';
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const overview = (cookie: string, query = '') => request(app).get(`/api/v1/command-center/overview${query}`).set('Cookie', cookie);
const pub = (row: Record<string, unknown>) => row.public_id as string;

async function route(depot: Row): Promise<Row> {
  return (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Route ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
}

async function alert(depot: Row, values: Record<string, unknown>): Promise<string> {
  const row = { alert_type: 'vehicle_fault', severity: 'high', status: 'open', source_module: 'fleet', title: 'Defects', depot_id: depot.id, ...values };
  const keys = Object.keys(row);
  const res = await pool.query<{ public_id: string }>(
    `INSERT INTO alert.alerts (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING public_id`,
    Object.values(row),
  );
  return res.rows[0].public_id;
}

async function incident(depot: Row, reporter: Row, values: Record<string, unknown>): Promise<string> {
  const row = { reported_by: reporter.id, description: 'Flat tyre on the ring road', severity: 'medium', depot_id: depot.id, ...values };
  const keys = Object.keys(row);
  const res = await pool.query<{ public_id: string }>(
    `INSERT INTO alert.incident_reports (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING public_id`,
    Object.values(row),
  );
  return res.rows[0].public_id;
}

/** Depot A with one of everything the overview counts, and depot B with an alert and incident of its own. */
async function world() {
  const now = new Date();
  const { day, from } = addisDayOf(now);
  const a = await createDepot();
  const b = await createDepot();
  const scored = (score: number) => ({ health_score: score, health_score_updated_at: now.toISOString() });

  const onTrip = await createVehicle({ depot: a, ...scored(80) });
  const free = await createVehicle({ depot: a, ...scored(60) });
  const workshop = await createVehicle({ depot: a, status: 'maintenance' });
  const flagged = await createVehicle({ depot: a, maintenance_flag: true, ...scored(90) });
  await createVehicle({ depot: a, status: 'retired' });
  const theirs = await createVehicle({ depot: b });

  const driving = await createDriver({ depot: a });
  const away = await createDriver({ depot: a });
  const expired = await createDriver({ depot: a, license_expiry: '2020-01-01' });
  await createDriver({ depot: a });
  const clerk = await createUser({ roles: ['depot_admin'], depot: a });
  await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, $2, 'absent', $3)", [away.driver.id, day, clerk.id]);

  // Under way since earlier today and past its scheduled end; and one scheduled later today.
  const start = new Date(from.getTime() + (now.getTime() - from.getTime()) / 2);
  const r = await route(a);
  await createTrip({ vehicle: onTrip, driver: driving.driver, route_id: r.id, status: 'en_route', scheduled_start: start.toISOString(), scheduled_end: new Date(now.getTime() - 1).toISOString(), actual_start: start.toISOString() });
  await pool.query("INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', $2, $3)", [r.id, start.toISOString(), now.toISOString()]);

  const critical = await alert(a, { severity: 'critical', vehicle_id: free.id, title: 'Brakes failed inspection' });
  const acknowledged = await alert(a, { severity: 'medium', status: 'acknowledged', acknowledged_at: new Date(now.getTime() + 1000).toISOString() });
  await alert(a, { status: 'resolved', resolved_at: new Date(now.getTime() + 1000).toISOString() });
  const otherAlert = await alert(b, { vehicle_id: theirs.id });

  const reporter = driving.user;
  const breakdown = await incident(a, reporter, { severity: 'high', incident_type: 'breakdown', vehicle_id: flagged.id, driver_id: driving.driver.id });
  const looking = await incident(a, reporter, { severity: 'low', status: 'investigating' });
  await incident(a, reporter, { status: 'closed', resolved_at: now.toISOString() });
  const otherIncident = await incident(b, reporter, { vehicle_id: theirs.id });

  return { a, b, onTrip, free, workshop, flagged, theirs, driving, expired, critical, acknowledged, otherAlert, breakdown, looking, otherIncident };
}

describe('GET /command-center/overview', () => {
  // CI runs with Redis: an overview cached by the test before is not this one's.
  beforeEach(async () => {
    await cache.invalidate('command-center:overview:*');
  });

  test("a dispatcher sees their depot counted: vehicles, health, drivers, today's trips, active alerts and incidents", async () => {
    const w = await world();
    const res = await overview(await signIn(['dispatcher'], w.a));
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.depot_id).toBe(pub(w.a));
    expect(data.vehicles).toMatchObject({ total: 4, on_trip: 1, available: 1, in_maintenance: 1, inactive: 0, flagged: 1 });
    expect(data.vehicles.health).toEqual({ at_risk: 1, watch: 1, healthy: 1, stale: 0, unscored: 1 });
    expect(data.vehicles.health_watch).toEqual([
      { vehicle_id: pub(w.free), registration_number: w.free.registration_number, health_score: 60, band: 'at_risk' },
      { vehicle_id: pub(w.onTrip), registration_number: w.onTrip.registration_number, health_score: 80, band: 'watch' },
    ]);
    expect(data.drivers).toEqual({ total: 4, on_trip: 1, available: 1, absent: 1, licence_expired: 1 });
    expect(data.trips).toEqual({ today: { draft: 0, scheduled: 1, assigned: 0, en_route: 1, completed: 0, cancelled: 0 }, under_way: 1, overdue: 1 });

    expect(data.alerts).toMatchObject({ active: 2, unacknowledged: 1, by_severity: { critical: 1, high: 0, medium: 1, low: 0 } });
    // The most severe first; the plate of the vehicle it is about.
    expect(data.alerts.items.map((i: { id: string }) => i.id)).toEqual([w.critical, w.acknowledged]);
    expect(data.alerts.items[0]).toMatchObject({ severity: 'critical', priority: 1, status: 'open', title: 'Brakes failed inspection', registration_number: w.free.registration_number });

    expect(data.incidents).toMatchObject({ active: 2, by_status: { open: 1, investigating: 1 }, by_severity: { critical: 0, high: 1, medium: 0, low: 1 } });
    expect(data.incidents.items.map((i: { id: string }) => i.id)).toEqual([w.breakdown, w.looking]);
    expect(data.incidents.items[0]).toMatchObject({
      incident_type: 'breakdown',
      registration_number: w.flagged.registration_number,
      driver_id: pub(w.driving.driver),
      driver_name: 'Test Driver',
      assigned_to: null,
    });
    // Nothing of depot B's.
    expect(JSON.stringify(data)).not.toContain(w.otherAlert);
    expect(JSON.stringify(data)).not.toContain(w.otherIncident);
    expect(JSON.stringify(data)).not.toContain(pub(w.theirs));
  });

  test('a section the caller may not read is null: a fleet owner has no incident:read', async () => {
    await world();
    const data = (await overview(await signIn(['fleet_owner']))).body.data;
    expect(data.incidents).toBeNull();
    expect(data.alerts).not.toBeNull();
    expect(data.drivers).not.toBeNull();
    expect(data.trips).not.toBeNull();
  });

  test("a fleet-wide user sees every depot, or one chosen; a depot outside a caller's scope is 404", async () => {
    const w = await world();
    const manager = await signIn(['fleet_manager']);
    const all = (await overview(manager)).body.data;
    expect(all.depot_id).toBeNull();
    expect(all.alerts.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([w.critical, w.otherAlert]));

    const one = (await overview(manager, `?depot_id=${pub(w.b)}`)).body.data;
    expect(one.depot_id).toBe(pub(w.b));
    expect(one.vehicles.total).toBe(1);
    expect(one.alerts.items.map((i: { id: string }) => i.id)).toEqual([w.otherAlert]);
    expect(one.incidents.items.map((i: { id: string }) => i.id)).toEqual([w.otherIncident]);

    const dispatcher = await signIn(['dispatcher'], w.a);
    expect((await overview(dispatcher, `?depot_id=${pub(w.b)}`)).status).toBe(404);
    expect((await overview(dispatcher, '?depot_id=nope')).status).toBe(400);
    expect((await overview(dispatcher, '?view=all')).status).toBe(400);
  });

  test('a driver has no command:read: 403', async () => {
    const depot = await createDepot();
    const res = await overview(await signIn(['driver'], depot));
    expect(res.status).toBe(403);
  });
});
