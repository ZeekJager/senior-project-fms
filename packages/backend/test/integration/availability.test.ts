import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems } from '../support/openapi';

// The availability screen's reads (FMS-142): a vehicle's downtime periods in a month, each with the problem behind
// it (its work order and failure), and the month's figures, which match FMS-131's hand-computed September.

const app = createApp();
const PASSWORD = 'Availability-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Vehicle = Awaited<ReturnType<typeof createVehicle>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body);

const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
const local = (iso: string) => new Date(`${iso}+03:00`);
const SEPTEMBER = `from=${encodeURIComponent('2026-09-01T00:00:00+03:00')}&to=${encodeURIComponent('2026-10-01T00:00:00+03:00')}`;

const historyRow = (vehicle: Vehicle, from: string, to: string, at: Date) =>
  pool.query(`INSERT INTO fleet.vehicle_status_history (vehicle_id, from_status, to_status, reason, changed_at) VALUES ($1, $2, $3, 'Test', $4)`, [
    vehicle.id,
    from,
    to,
    at,
  ]);

/** The response is what docs/openapi.yaml says GET `path` returns with its status (FMS-65). */
function expectSpec(res: Response, path: string) {
  const problem = responseProblems(path, 'get', res.status, res.body);
  if (problem) throw new Error(`GET ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}`);
}

const rebuild = () => fleetModule.readModels!.find((m) => m.name === 'fleet.downtime_periods')!.rebuild();

describe('the problem behind each downtime period (FMS-142)', () => {
  test('a breakdown’s period names its work order and failure; a reader without maintenance:read gets neither', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const manager = await signIn(['fleet_manager']);
    const dispatcher = await signIn(['dispatcher'], depot);
    const vehicle = await createVehicle({ depot, created_at: hoursAgo(48) });

    const breakdown = { component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'breakdown', occurred_at: hoursAgo(5).toISOString() };
    const opened = await post(
      '/maintenance',
      { vehicle_id: vehicle.public_id, description: 'Radiator leak on the Adama road', labour_hours: 3, total_cost_cents: 120_000, maintenance_type: 'corrective', status: 'in_progress', failures: [breakdown] },
      tech,
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    const res = await get(`/vehicles/${vehicle.public_id}/downtime`, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      reason: 'breakdown',
      maintenance_record_id: opened.body.data.id,
      maintenance_record: { id: opened.body.data.id, maintenance_type: 'corrective', status: 'in_progress', description: 'Radiator leak on the Adama road' },
      failure_event_id: opened.body.data.failures[0].id,
      failure: { id: opened.body.data.failures[0].id, component: 'cooling', failure_mode: 'leak', detected_by: 'breakdown' },
    });
    expect(Math.abs(new Date(res.body.data[0].failure.occurred_at).getTime() - hoursAgo(5).getTime())).toBeLessThan(5_000);
    expectSpec(res, '/vehicles/{vehicle_id}/downtime');

    // A dispatcher reads a vehicle's periods (vehicle:read), not its repairs.
    const theirs = await get(`/vehicles/${vehicle.public_id}/downtime`, dispatcher);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data[0]).toMatchObject({ reason: 'breakdown', maintenance_record: null, failure: null });
    expectSpec(theirs, '/vehicles/{vehicle_id}/downtime');

    // A status set by hand has no problem behind it.
    const other = await createVehicle({ depot });
    await post(`/vehicles/${other.public_id}/status`, { status: 'inactive', reason: 'Out of service' }, manager);
    const plain = await get(`/vehicles/${other.public_id}/downtime`, manager);
    expect(plain.body.data[0]).toMatchObject({ reason: 'other', maintenance_record: null, failure: null });
  });
});

describe('a month of periods and its figures (FMS-142)', () => {
  test('from and to keep the periods overlapping September; its figures match the hand-computed month', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot, created_at: local('2025-01-01T00:00:00') });
    // August only; across the month's end into September (1 h of it: 00:00 to 01:00 on the 1st, Addis Ababa); then
    // FMS-131's September (48 h in the workshop, 12 h after a breakdown, 24 h for an unplanned repair); October only.
    await historyRow(vehicle, 'active', 'inactive', local('2026-08-10T08:00:00'));
    await historyRow(vehicle, 'inactive', 'active', local('2026-08-11T08:00:00'));
    await historyRow(vehicle, 'active', 'inactive', local('2026-08-31T20:00:00'));
    await historyRow(vehicle, 'inactive', 'active', local('2026-09-01T01:00:00'));
    await historyRow(vehicle, 'active', 'maintenance', local('2026-09-05T08:00:00'));
    await historyRow(vehicle, 'maintenance', 'active', local('2026-09-07T08:00:00'));
    await historyRow(vehicle, 'active', 'inactive', local('2026-09-10T06:00:00'));
    await historyRow(vehicle, 'inactive', 'active', local('2026-09-10T18:00:00'));
    await historyRow(vehicle, 'active', 'maintenance', local('2026-09-20T00:00:00'));
    await historyRow(vehicle, 'maintenance', 'active', local('2026-09-21T00:00:00'));
    await historyRow(vehicle, 'active', 'inactive', local('2026-10-03T08:00:00'));
    await historyRow(vehicle, 'inactive', 'active', local('2026-10-03T12:00:00'));
    await rebuild();

    expect((await get(`/vehicles/${vehicle.public_id}/downtime`, manager)).body.meta.total_items).toBe(6);
    const res = await get(`/vehicles/${vehicle.public_id}/downtime?${SEPTEMBER}`, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.total_items).toBe(4);
    expectSpec(res, '/vehicles/{vehicle_id}/downtime');
    const starts = res.body.data.map((p: { started_at: string }) => p.started_at);
    expect(starts).toEqual(
      ['2026-09-20T00:00:00', '2026-09-10T06:00:00', '2026-09-05T08:00:00', '2026-08-31T20:00:00'].map((t) => local(t).toISOString()),
    );

    // FMS-131's month: the first-of-September hour is the only change, 60 more minutes down, planned_service none.
    const [repairPeriod, breakdownPeriod] = res.body.data;
    await patch(`/vehicles/${vehicle.public_id}/downtime/${repairPeriod.id}`, { reason: 'unplanned_repair' }, manager);
    await patch(`/vehicles/${vehicle.public_id}/downtime/${breakdownPeriod.id}`, { reason: 'breakdown' }, manager);
    const month = await get(`/analytics/downtime?month=2026-09&vehicle_id=${vehicle.public_id}`, manager);
    expect(month.status).toBe(200);
    expectSpec(month, '/analytics/downtime');
    // 43,200 min in September. Down 1 + 48 + 12 + 24 h = 5,100 min; up 38,100 (88.2%). Two failures began: MTBF
    // 38,100 / 2 = 19,050. Two repairs ended, 12 h and 24 h: MTTR 1,080.
    expect(month.body.data.fleet).toMatchObject({
      in_fleet_minutes: 43_200,
      downtime_minutes: 5_100,
      uptime_minutes: 38_100,
      availability_pct: 88.2,
      failures: 2,
      mtbf_minutes: 19_050,
      repairs: 2,
      mttr_minutes: 1_080,
      downtime_by_reason: { planned_service: 0, unplanned_repair: 1_440, breakdown: 720, accident: 0, awaiting_parts: 0, other: 2_940 },
    });

    // A window the wrong way round is refused.
    const backwards = await get(`/vehicles/${vehicle.public_id}/downtime?from=${encodeURIComponent('2026-10-01T00:00:00+03:00')}&to=${encodeURIComponent('2026-09-01T00:00:00+03:00')}`, manager);
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details).toEqual([{ field: 'to', reason: 'before_from' }]);
    expectSpec(backwards, '/vehicles/{vehicle_id}/downtime');
    expect((await get(`/vehicles/${vehicle.public_id}/downtime?from=yesterday`, manager)).status).toBe(400);
  });
});
