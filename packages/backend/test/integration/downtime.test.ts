import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// Vehicle downtime (FMS-131): periods from status changes and breakdowns, kept by a projection and equal to a
// rebuild; a staff member's reason; availability, MTBF and MTTR for a month.

const app = createApp();
const PASSWORD = 'Downtime-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Vehicle = Awaited<ReturnType<typeof createVehicle>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object, cookie: string) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
const local = (iso: string) => new Date(`${iso}+03:00`);

const repair = (vehicle: Vehicle, extra: Record<string, unknown> = {}) => ({
  vehicle_id: vehicle.public_id,
  description: 'Workshop work',
  labour_hours: 2,
  total_cost_cents: 50_000,
  ...extra,
});

async function periodsOf(vehicle: Vehicle, cookie: string): Promise<Record<string, unknown>[]> {
  const res = await api.get(`/vehicles/${vehicle.public_id}/downtime`, cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

/** Moves the vehicle's last status change back in time, as if it had happened then. */
const backdateLastChange = (vehicle: Vehicle, at: Date) =>
  pool.query(
    `UPDATE fleet.vehicle_status_history SET changed_at = $2
      WHERE id = (SELECT id FROM fleet.vehicle_status_history WHERE vehicle_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1)`,
    [vehicle.id, at],
  );

/** A status change as it would have been recorded at `at`. */
const historyRow = (vehicle: Vehicle, from: string, to: string, at: Date) =>
  pool.query(`INSERT INTO fleet.vehicle_status_history (vehicle_id, from_status, to_status, reason, changed_at) VALUES ($1, $2, $3, 'Test', $4)`, [
    vehicle.id,
    from,
    to,
    at,
  ]);

const PERIOD_COLUMNS = `opened_by, started_at, ended_at, derived_reason::text, reason::text, maintenance_record_id::text, failure_event_id::text`;
const storedPeriods = async (vehicles: Vehicle[]) =>
  (
    await pool.query(`SELECT vehicle_id::text, ${PERIOD_COLUMNS} FROM fleet.downtime_periods WHERE vehicle_id = ANY($1::bigint[]) ORDER BY vehicle_id, started_at`, [
      vehicles.map((v) => v.id),
    ])
  ).rows;

const rebuild = () => fleetModule.readModels!.find((m) => m.name === 'fleet.downtime_periods')!.rebuild();

describe('downtime periods from status changes and failures', () => {
  test('a vehicle in maintenance for 2 days gets one 2-day downtime period with its reason', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });

    const opened = await api.post('/maintenance', repair(vehicle, { maintenance_type: 'preventive', status: 'in_progress' }), tech);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const [open] = await periodsOf(vehicle, tech);
    expect(open).toMatchObject({ ended_at: null, reason: 'planned_service', unplanned: false, opened_by: 'status_change', maintenance_record_id: opened.body.data.id });

    // Into the workshop two days ago; the work is completed now.
    await backdateLastChange(vehicle, hoursAgo(48));
    expect((await api.put(`/maintenance/${opened.body.data.id}`, { completed_at: new Date().toISOString() }, tech)).status).toBe(200);

    const periods = await periodsOf(vehicle, tech);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ id: open.id, reason: 'planned_service', derived_reason: 'planned_service', maintenance_record_id: opened.body.data.id });
    expect(periods[0].ended_at).not.toBeNull();
    expect(Math.abs((periods[0].duration_minutes as number) - 2 * 24 * 60)).toBeLessThanOrEqual(1);
  });

  test('a breakdown before the workshop, then out of service and back: one period, from the breakdown to the repair', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const manager = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot, created_at: hoursAgo(24) });

    const breakdown = { component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'breakdown', occurred_at: hoursAgo(3).toISOString() };
    const opened = await api.post('/maintenance', repair(vehicle, { maintenance_type: 'corrective', status: 'in_progress', failures: [breakdown] }), tech);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const failureId = opened.body.data.failures[0].id;

    let periods = await periodsOf(vehicle, tech);
    expect(periods).toMatchObject([{ opened_by: 'breakdown', reason: 'breakdown', unplanned: true, failure_event_id: failureId, ended_at: null }]);
    expect(Math.abs(new Date(periods[0].started_at as string).getTime() - hoursAgo(3).getTime())).toBeLessThan(5_000);

    // Out of service, then back in service by hand while the repair is still open: still down, still one period.
    for (const status of ['inactive', 'active']) {
      expect((await api.post(`/vehicles/${vehicle.public_id}/status`, { status, reason: 'Waiting on the radiator' }, manager)).status).toBe(200);
    }
    periods = await periodsOf(vehicle, tech);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ ended_at: null, reason: 'breakdown' });

    const done = await api.put(`/maintenance/${opened.body.data.id}`, { completed_at: new Date().toISOString() }, tech);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    periods = await periodsOf(vehicle, tech);
    expect(periods).toHaveLength(1);
    expect(periods[0].ended_at).not.toBeNull();
    expect(Math.abs((periods[0].duration_minutes as number) - 180)).toBeLessThanOrEqual(1);
  });

  test('the rebuild reproduces the live periods, and keeps a staff member’s reason', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const manager = await signIn(['fleet_manager']);
    const [a, b] = [await createVehicle({ depot }), await createVehicle({ depot })];

    const opened = await api.post('/maintenance', repair(a, { maintenance_type: 'preventive', status: 'in_progress' }), tech);
    await backdateLastChange(a, hoursAgo(30));
    expect((await api.put(`/maintenance/${opened.body.data.id}`, { completed_at: new Date().toISOString() }, tech)).status).toBe(200);
    await api.post(`/vehicles/${b.public_id}/status`, { status: 'inactive', reason: 'Accident at the depot gate' }, manager);
    const [period] = await periodsOf(b, manager);
    const set = await api.patch(`/vehicles/${b.public_id}/downtime/${period.id}`, { reason: 'accident', note: 'Hit the gate post' }, manager);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({ reason: 'accident', derived_reason: 'other', unplanned: true, reason_note: 'Hit the gate post', reason_set_by: expect.any(String) });

    const live = await storedPeriods([a, b]);
    expect(live).toHaveLength(2);

    // Nothing has drifted: the rebuild changes nothing and the reason stays.
    await rebuild();
    expect(await storedPeriods([a, b])).toEqual(live);

    // Written without their events (as a restore would): the rebuild puts them back as they were.
    await pool.query(`DELETE FROM fleet.downtime_periods WHERE vehicle_id = $1`, [a.id]);
    const result = await rebuild();
    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(await storedPeriods([a, b])).toEqual(live);

    // Back to the derived reason.
    const cleared = await api.patch(`/vehicles/${b.public_id}/downtime/${period.id}`, { reason: null }, manager);
    expect(cleared.body.data).toMatchObject({ reason: 'other', reason_note: null, reason_set_by: null, unplanned: false });
  });
});

describe('GET /analytics/downtime', () => {
  test('availability, MTBF and MTTR match a hand-computed September', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot, created_at: local('2025-01-01T00:00:00') });
    // 48 h in the workshop, 12 h out of service after a breakdown, 24 h for an unplanned repair.
    await historyRow(vehicle, 'active', 'maintenance', local('2026-09-05T08:00:00'));
    await historyRow(vehicle, 'maintenance', 'active', local('2026-09-07T08:00:00'));
    await historyRow(vehicle, 'active', 'inactive', local('2026-09-10T06:00:00'));
    await historyRow(vehicle, 'inactive', 'active', local('2026-09-10T18:00:00'));
    await historyRow(vehicle, 'active', 'maintenance', local('2026-09-20T00:00:00'));
    await historyRow(vehicle, 'maintenance', 'active', local('2026-09-21T00:00:00'));
    await rebuild();
    const periods = await periodsOf(vehicle, manager);
    expect(periods.map((p) => p.reason)).toEqual(['other', 'other', 'other']);
    // Newest first: the 24 h repair, then the breakdown.
    await api.patch(`/vehicles/${vehicle.public_id}/downtime/${periods[0].id}`, { reason: 'unplanned_repair' }, manager);
    await api.patch(`/vehicles/${vehicle.public_id}/downtime/${periods[1].id}`, { reason: 'breakdown' }, manager);

    const res = await api.get(`/analytics/downtime?month=2026-09&vehicle_id=${vehicle.public_id}`, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // September: 43,200 min. Down 48 + 12 + 24 h = 5,040 min; up 38,160 (88.3%). Two failures: MTBF 19,080.
    // Two repairs of 12 h and 24 h: MTTR 1,080.
    const expected = {
      in_fleet_minutes: 43_200,
      uptime_minutes: 38_160,
      downtime_minutes: 5_040,
      unplanned_downtime_minutes: 2_160,
      availability_pct: 88.3,
      failures: 2,
      mtbf_minutes: 19_080,
      repairs: 2,
      mttr_minutes: 1_080,
      downtime_by_reason: { planned_service: 0, unplanned_repair: 1_440, breakdown: 720, accident: 0, awaiting_parts: 0, other: 2_880 },
    };
    expect(res.body.data.vehicles).toEqual([
      { vehicle_id: vehicle.public_id, registration_number: vehicle.registration_number, depot_id: depot.public_id, depot_name: depot.name, status: 'active', ...expected },
    ]);
    expect(res.body.data.fleet).toEqual({ vehicles: 1, ...expected });
    expect(res.body.data.depots).toEqual([{ depot_id: depot.public_id, depot_name: depot.name, vehicles: 1, ...expected }]);
    expect(res.body.meta).toMatchObject({ month: '2026-09', from: local('2026-09-01T00:00:00').toISOString(), to: local('2026-10-01T00:00:00').toISOString() });
    expect(res.body.meta.data_freshness).toBeDefined();
  });

  test('a month not yet begun is 400; a dispatcher sees only their depot’s vehicles, a depot admin no analytics', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const dispatcher = await signIn(['dispatcher'], mine);
    const admin = await signIn(['depot_admin'], mine);
    const manager = await signIn(['fleet_manager']);
    const theirs = await createVehicle({ depot: other, created_at: local('2025-01-01T00:00:00') });

    const future = await api.get('/analytics/downtime?month=2999-01', manager);
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual([{ field: 'month', reason: 'future_month' }]);

    const seen = await api.get(`/analytics/downtime?month=2026-09&vehicle_id=${theirs.public_id}`, manager);
    expect(seen.body.data.vehicles).toHaveLength(1);
    const res = await api.get(`/analytics/downtime?month=2026-09&vehicle_id=${theirs.public_id}`, dispatcher);
    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toEqual([]);
    expect(res.body.data.fleet).toMatchObject({ vehicles: 0, availability_pct: null });
    expect((await api.get('/analytics/downtime', admin)).status).toBe(403);
  });
});

describe('permissions and scope', () => {
  test('another depot’s vehicle is 404; reading needs vehicle:read and a reason vehicle:write', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const admin = await signIn(['depot_admin'], mine);
    const tech = await signIn(['technician'], other);
    const manager = await signIn(['fleet_manager']);
    const clerk = await signIn(['finance_clerk'], other);
    const vehicle = await createVehicle({ depot: other });
    await api.post(`/vehicles/${vehicle.public_id}/status`, { status: 'inactive', reason: 'Out of service' }, manager);
    const [period] = await periodsOf(vehicle, manager);

    expect((await api.get(`/vehicles/${vehicle.public_id}/downtime`, admin)).status).toBe(404);
    expect((await api.patch(`/vehicles/${vehicle.public_id}/downtime/${period.id}`, { reason: 'accident' }, admin)).status).toBe(404);
    expect((await api.get(`/vehicles/${vehicle.public_id}/downtime`, clerk)).status).toBe(403);
    expect((await api.patch(`/vehicles/${vehicle.public_id}/downtime/${period.id}`, { reason: 'accident' }, tech)).status).toBe(403);
    expect((await api.patch(`/vehicles/${vehicle.public_id}/downtime/${period.id}`, { reason: 'lunch' }, manager)).status).toBe(400);
    const unknown = await api.patch(`/vehicles/${vehicle.public_id}/downtime/00000000-0000-4000-8000-000000000000`, { reason: 'accident' }, manager);
    expect(unknown.status).toBe(404);
  });
});
