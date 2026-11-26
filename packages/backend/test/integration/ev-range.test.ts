import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { EV_EVENTS } from '../../src/modules/ev';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-98 (docs/ev.md#range): an EV's range from its charge, battery and own consumption; a warning when it is assigned a
// trip longer than its range; BatteryThresholdExceeded (and a battery alert) below 20% charge, below the health line,
// and when its range is short of the km left on its trip under way.

const app = createApp();
const PASSWORD = 'Range-Test-1';
type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string };

function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}

async function account(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  return {
    get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
    put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
    patch: (path: string, body: object, etag?: string) => {
      const req = request(app).patch(`/api/v1${path}`).set('Cookie', cookie);
      return (etag ? req.set('If-Match', etag) : req).send(body);
    },
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An electric truck with a 100 kWh battery spec and readings averaging 250 Wh/km: 4 km per point of charge at 100% health. */
async function ev(depot: Depot, manager: Awaited<ReturnType<typeof account>>) {
  const vehicle = await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null });
  const spec = await manager.put(`/vehicles/${vehicle.public_id}/battery-spec`, { usable_capacity_kwh: 100 });
  expect(spec.status, JSON.stringify(spec.body)).toBe(200);
  for (const [h, wh] of [[30, 240], [28, 250], [26, 260]] as const) {
    // Old readings: history, no alert.
    expect((await manager.post('/ev/battery-logs', { vehicle_id: vehicle.public_id, state_of_charge: 90, battery_health: 100, energy_wh_per_km: wh, recorded_at: ago(h * 3_600_000) })).status).toBe(201);
  }
  return vehicle;
}

const log = (m: Awaited<ReturnType<typeof account>>, vehicle: Row, soc: number, health = 100, at = ago(60_000)) =>
  m.post('/ev/battery-logs', { vehicle_id: vehicle.public_id, state_of_charge: soc, battery_health: health, recorded_at: at });

async function trip(depot: Depot, km: number, status: 'scheduled' | 'en_route' = 'scheduled', vehicle: Row | null = null, driver: Row | null = null) {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Addis Ababa - Adama ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
  return (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end, planned_distance_km, vehicle_id, driver_id, actual_start)
       VALUES ($1, $2::trip.trip_status, '2026-11-02T06:00:00Z', '2026-11-02T09:00:00Z', $3, $4, $5, CASE WHEN $2::text = 'en_route' THEN now() END) RETURNING *`,
      [route.id, status, km, vehicle?.id ?? null, driver?.id ?? null],
    )
  ).rows[0];
}

const thresholdEvents = async () => (await publishedEvents(EV_EVENTS.thresholdExceeded)).map((e) => e.payload);

describe('range estimation (FMS-98)', () => {
  test('the battery summary shows the range from the spec, the health and the vehicle’s own consumption', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await ev(depot, manager);
    await log(manager, vehicle, 60, 95);
    const summary = await manager.get(`/vehicles/${vehicle.public_id}/battery-summary`);
    expect(summary.status).toBe(200);
    expectContract(summary, 'get', '/vehicles/{vehicle_id}/battery-summary');
    // 60% × 100 kWh × 95% ÷ 250 Wh/km = 228 km.
    expect(summary.body.data).toMatchObject({
      range: { range_km: 228, state_of_charge: 60, wh_per_km: 250, usable_capacity_kwh: 100, capacity_source: 'spec', battery_health: 95 },
      range_gap: null,
      battery_spec: { usable_capacity_kwh: 100 },
    });
  });

  test('the spec is audited and announced; a diesel vehicle has none; without one the range comes from charging sessions', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await createVehicle({ depot, fuel_type: 'electric' });
    const set = await manager.put(`/vehicles/${vehicle.public_id}/battery-spec`, { usable_capacity_kwh: 77 });
    expectContract(set, 'put', '/vehicles/{vehicle_id}/battery-spec');
    expect(set.body.data).toMatchObject({ vehicle_id: vehicle.public_id, usable_capacity_kwh: 77 });
    await manager.put(`/vehicles/${vehicle.public_id}/battery-spec`, { usable_capacity_kwh: 77 });
    await manager.put(`/vehicles/${vehicle.public_id}/battery-spec`, { usable_capacity_kwh: 75.5 });
    const audit = await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'ev.battery_specs' ORDER BY id");
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
    expect((await publishedEvents(EV_EVENTS.specSet)).map((e) => e.payload.usable_capacity_kwh)).toEqual([77, 75.5]);

    const diesel = await createVehicle({ depot });
    expect((await manager.put(`/vehicles/${diesel.public_id}/battery-spec`, { usable_capacity_kwh: 50 })).body.error.details).toEqual([{ field: 'vehicle_id', reason: 'not_electric' }]);
    expect((await manager.put(`/vehicles/${vehicle.public_id}/battery-spec`, { usable_capacity_kwh: 0 })).status).toBe(400);

    // No spec: 41.4 kWh into the battery (92%) filled 60 points, so about 63.5 kWh usable.
    const other = await createVehicle({ depot, fuel_type: 'electric' });
    const s = await manager.post('/ev/charging-sessions', { vehicle_id: other.public_id, status: 'in_progress', started_at: ago(5 * 3_600_000), start_soc: 20 });
    expect(s.status).toBe(201);
    for (const wh of [200, 200, 200]) await manager.post('/ev/battery-logs', { vehicle_id: other.public_id, state_of_charge: 80, energy_wh_per_km: wh, recorded_at: ago(3_600_000 * 7) });
    const noCapacity = await manager.get(`/vehicles/${other.public_id}/battery-summary`);
    expect(noCapacity.body.data).toMatchObject({ range: null, range_gap: 'no_capacity' });
    await manager.patch(`/ev/charging-sessions/${s.body.data.id}`, { status: 'completed', ended_at: ago(4 * 3_600_000), energy_kwh: 41.4, end_soc: 80 });
    // 41.4 kWh × 0.92 over 60 points: 63,480 Wh usable; 80% of it at 200 Wh/km is 253 km, health already in it.
    const fromSessions = await manager.get(`/vehicles/${other.public_id}/battery-summary`);
    expect(fromSessions.body.data).toMatchObject({ range: { range_km: 253, capacity_source: 'sessions', usable_capacity_kwh: 63.48 }, range_gap: null, battery_spec: null });
  });
});

describe('the range warning at assignment (FMS-98)', () => {
  async function setup(soc: number, km: number) {
    const depot = await createDepot();
    // Even with every exception policy on approve, the range warning only warns.
    await pool.query("INSERT INTO tracking.rule_thresholds (depot_id, attendance_exception, overrun_exception) VALUES ($1, 'approve', 'approve')", [depot.id]);
    const manager = await account(['fleet_manager']);
    const dispatcher = await account(['dispatcher'], depot);
    const vehicle = await ev(depot, manager);
    await log(manager, vehicle, soc);
    const driver = (await createDriver({ depot, license_categories: ['dry_cargo_2'] })).driver as Row;
    const t = await trip(depot, km);
    return { dispatcher, assign: () => dispatcher.post(`/trips/${t.public_id}/assign`, { driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: 0 }) };
  }

  test('an EV whose range is below the trip’s distance is assigned with a warning', async () => {
    // 30% of 100 kWh at 250 Wh/km: 120 km, for a 180 km trip.
    const s = await setup(30, 180);
    const res = await s.assign();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectContract(res, 'post', '/trips/{trip_id}/assign');
    expect(res.body.data.status).toBe('assigned');
    expect(res.body.meta.warnings).toEqual([{ warning: 'EV_RANGE_SHORT', field: 'vehicle_id', range_km: 120, trip_km: 180, state_of_charge: 30 }]);
  });

  test('enough range, or a vehicle that is not electric, warns of nothing', async () => {
    const s = await setup(80, 180);
    const res = await s.assign();
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings ?? []).toEqual([]);

    const depot = await createDepot();
    const dispatcher = await account(['dispatcher'], depot);
    const truck = await createVehicle({ depot });
    const driver = (await createDriver({ depot, license_categories: ['dry_cargo_2'] })).driver as Row;
    const t = await trip(depot, 400);
    const diesel = await dispatcher.post(`/trips/${t.public_id}/assign`, { driver_id: driver.public_id, vehicle_id: truck.public_id, version: 0 });
    expect(diesel.status).toBe(200);
    expect(diesel.body.meta.warnings ?? []).toEqual([]);
  });

  test('the dispatch board shows each EV’s range', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await ev(depot, manager);
    await log(manager, vehicle, 50);
    const board = await manager.get(`/dispatch/availability?depot_id=${depot.public_id}`);
    expect(board.status).toBe(200);
    expectContract(board, 'get', '/dispatch/availability');
    expect(board.body.data.vehicles.find((v: { vehicle_id: string }) => v.vehicle_id === vehicle.public_id).ev_range).toMatchObject({ range_km: 200, state_of_charge: 50, wh_per_km: 250 });
  });
});

describe('EV alerts (FMS-98)', () => {
  test('a reading below 20% raises one battery alert; staying low raises no other; recovering and falling again does', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await ev(depot, manager);
    await log(manager, vehicle, 45, 100, ago(10 * 60_000));
    await log(manager, vehicle, 18, 100, ago(5 * 60_000));
    await deliverEvents();
    expect(await thresholdEvents()).toEqual([expect.objectContaining({ vehicle_id: vehicle.public_id, metric: 'state_of_charge', value: 18, threshold: 20, severity: 'high', trip_id: null })]);
    const alerts = await pool.query("SELECT alert_type, severity, title, description AS message FROM alert.alerts WHERE entity_id = $1", [vehicle.public_id]);
    expect(alerts.rows).toEqual([{ alert_type: 'battery', severity: 'high', title: `Battery alert on ${vehicle.registration_number}`, message: 'Charge is down to 18%, below 20%.' }]);

    await log(manager, vehicle, 12, 100, ago(4 * 60_000));
    await deliverEvents();
    expect(await thresholdEvents()).toHaveLength(1);

    await log(manager, vehicle, 85, 100, ago(3 * 60_000));
    await log(manager, vehicle, 8, 100, ago(2 * 60_000));
    await deliverEvents();
    expect((await thresholdEvents()).map((p) => [p.value, p.severity])).toEqual([
      [18, 'high'],
      [8, 'critical'],
    ]);
  });

  test('the line is a setting; an old reading raises nothing', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const admin = await account(['admin']);
    const vehicle = await ev(depot, manager);
    const definition = await admin.get('/settings/definitions/ev_low_soc_pct');
    expect(definition.body.data).toMatchObject({ key: 'ev_low_soc_pct', category: 'EV', default_value: 20 });
    const changed = await admin.patch('/settings/definitions/ev_low_soc_pct', { value: 30, reason: 'Long rural routes' }, definition.headers.etag);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await log(manager, vehicle, 25, 100, ago(30 * 3_600_000 - 60_000));
    await log(manager, vehicle, 26, 100);
    await deliverEvents();
    expect(await thresholdEvents()).toEqual([expect.objectContaining({ metric: 'state_of_charge', value: 26, threshold: 30 })]);
  });

  test('a battery worn below 80% raises a degradation alert', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await ev(depot, manager);
    await log(manager, vehicle, 70, 79.2);
    await deliverEvents();
    expect(await thresholdEvents()).toEqual([expect.objectContaining({ metric: 'battery_health', value: 79.2, threshold: 80, severity: 'medium' })]);
    const alert = await pool.query("SELECT description AS message FROM alert.alerts WHERE entity_id = $1", [vehicle.public_id]);
    expect(alert.rows[0].message).toBe('Battery health is 79.2%, below 80%: the battery is wearing out.');
  });

  test('en route, a range short of the trip’s km left raises a range alert naming the trip', async () => {
    const depot = await createDepot();
    const manager = await account(['fleet_manager']);
    const vehicle = await ev(depot, manager);
    const driver = (await createDriver({ depot, license_categories: ['dry_cargo_2'] })).driver as Row;
    const t = await trip(depot, 300, 'en_route', vehicle, driver);
    // 50% × 100 kWh ÷ 250 Wh/km: 200 km for the 300 planned (no arrival estimate yet).
    await log(manager, vehicle, 50);
    await deliverEvents();
    expect(await thresholdEvents()).toEqual([expect.objectContaining({ metric: 'range', value: 200, threshold: 300, severity: 'high', trip_id: t.public_id })]);
    const alert = await pool.query("SELECT description AS message, trip_id FROM alert.alerts WHERE entity_id = $1", [vehicle.public_id]);
    expect(alert.rows).toEqual([{ message: 'Range of 200 km is short of the 300 km left on its trip.', trip_id: t.id }]);
  });
});
