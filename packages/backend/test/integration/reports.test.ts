import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { addisDay } from '../../src/modules/analytics/domain/kpis';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-91: monthly reports and exports. Each test seeds last month (Addis Ababa) in a depot of its own and reads the
// report through the API as JSON, CSV and PDF, in the caller's depot scope.

const app = createApp();
const PASSWORD = 'Reports-Test-1';

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** Last month in Addis Ababa, YYYY-MM, and a time in it. */
const MONTH = (() => {
  const [y, m] = addisDay(new Date()).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const inMonth = (day: number, hour = 10, minute = 0) => new Date(`${MONTH}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);
const afterMonth = () => new Date(new Date(`${MONTH}-28T12:00:00+03:00`).getTime() + 10 * 86_400_000);

async function route(depot: Depot, name: string): Promise<Row> {
  return (await pool.query('INSERT INTO trip.routes (name, depot_id, origin_name, destination_name) VALUES ($1, $2, $3, $4) RETURNING *', [name, depot.id, 'Bole', 'Adama'])).rows[0];
}

/** A trip on `route`, scheduled at `start` for 2 hours; completed `lateMinutes` after its end unless another status is given. */
async function trip(r: Row, vehicle: Row, driver: Row, start: Date, km: number, options: { lateMinutes?: number; status?: string; planned?: number } = {}): Promise<Row> {
  const status = options.status ?? 'completed';
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const done = status === 'completed';
  return (
    await pool.query(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, planned_distance_km, actual_distance_km)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [r.id, vehicle.id, driver.id, status, start, end, done ? start : null, done ? new Date(end.getTime() + (options.lateMinutes ?? 0) * 60_000) : null, options.planned ?? km, done ? km : null],
    )
  ).rows[0];
}

const fill = (vehicle: Row, ml: number, cents: number, at: Date) =>
  pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', $2, $3, $4)`, [vehicle.id, ml, cents, at]);

const repair = (vehicle: Row, type: string, status: string, completedAt: Date | null, cents: number, hours = 0, createdAt = inMonth(2)) =>
  pool.query(
    `INSERT INTO maintenance.maintenance_records (vehicle_id, maintenance_type, status, completed_at, total_cost_cents, labor_hours, created_at, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Work')`,
    [vehicle.id, type, status, completedAt, cents, hours, createdAt],
  );

/** A depot with two diesel trucks (rated 300 ml/km), a driver, a route, and a third truck elsewhere. */
async function world() {
  const depot = await createDepot();
  const other = await createDepot();
  const { driver } = await createDriver({ depot });
  const truck = (await createVehicle({ depot, fuel_efficiency_ml_per_km: 300 })) as Row;
  const van = (await createVehicle({ depot, fuel_efficiency_ml_per_km: 200, vehicle_type: 'van' })) as Row;
  const elsewhere = (await createVehicle({ depot: other })) as Row;
  return { depot, other, driver: driver as Row, truck, van, elsewhere, road: await route(depot, `Bole - Adama ${depot.code}`) };
}

describe('GET /reports/{report} (FMS-91)', () => {
  test('fuel: per vehicle, most fuel first, with totals; the same table as CSV and PDF, named for the month and depot', async () => {
    const w = await world();
    await trip(w.road, w.truck, w.driver, inMonth(3), 200);
    await fill(w.truck, 66_000, 1_650_000, inMonth(4));
    await fill(w.truck, 4_000, 100_000, inMonth(20));
    await fill(w.van, 10_000, 250_000, inMonth(5));
    await fill(w.truck, 99_000, 1, afterMonth()); // next month: not counted
    await fill(w.elsewhere, 50_000, 1_250_000, inMonth(6)); // another depot
    const cookie = await signIn(['fleet_manager']);

    const res = await get(`/reports/fuel?month=${MONTH}&depot_id=${w.depot.public_id}`, cookie);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ report: 'fuel', title: 'Fuel report', month: MONTH, depot: { id: w.depot.public_id, name: w.depot.name } });
    expect(d.columns.map((c: { key: string }) => c.key)[0]).toBe('registration_number');
    expect(d.rows).toEqual([
      // 70 L over 200 km: 350 ml/km (35.0 L/100 km) against 300 rated; 17,500 birr over 200 km is 87.50 birr a km.
      expect.objectContaining({ registration_number: w.truck.registration_number, fill_ups: 2, fuel_ml: 70_000, fuel_cost_cents: 1_750_000, distance_m: 200_000, consumption_ml_per_km: 350, rated_ml_per_km: 300, cost_per_km_cents: 8750 }),
      // Not driven: no consumption to judge.
      expect.objectContaining({ registration_number: w.van.registration_number, fill_ups: 1, fuel_ml: 10_000, distance_m: 0, consumption_ml_per_km: null }),
    ]);
    expect(d.totals).toMatchObject({ registration_number: 'Total', depot: '2 vehicles', fill_ups: 3, fuel_ml: 80_000, fuel_cost_cents: 2_000_000, distance_m: 200_000, consumption_ml_per_km: 400 });
    expect(res.body.meta.data_freshness).toMatchObject({ source: 'primary', lag_seconds: 0 });

    const csv = await get(`/reports/fuel?month=${MONTH}&depot_id=${w.depot.public_id}&format=csv`, cookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="fuel-report-${MONTH}-${String(w.depot.code).toLowerCase()}.csv"`);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Vehicle,Depot,Fuel type,Fill-ups,Fuel (L),Cost (ETB),Distance (km),Used (L/100 km),Rated (L/100 km),Cost per km (ETB)');
    expect(lines[1]).toBe(`${w.truck.registration_number},${w.depot.name},Diesel,2,70.0,17500.00,200.0,35.0,30.0,87.50`);
    expect(lines.at(-1)).toBe('Total,2 vehicles,,3,80.0,20000.00,200.0,40.0,,100.00');

    const pdf = await get(`/reports/fuel?month=${MONTH}&format=pdf`, cookie).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="fuel-report-${MONTH}-all.pdf"`);
    const body = (pdf.body as Buffer).toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body).toContain(`(${w.truck.registration_number}) Tj`);
    // People read the PDF: thousands are grouped, where the CSV keeps 17500.00.
    expect(body).toContain('(17,500.00) Tj');
    expect(body).toContain('(All depots in your scope');
  });

  test('maintenance: repairs done by type, labour and cost, and what was still open when the month ended', async () => {
    const w = await world();
    await repair(w.truck, 'preventive', 'completed', inMonth(5), 300_000, 2.5);
    await repair(w.truck, 'corrective', 'completed', inMonth(9), 120_000, 1);
    await repair(w.truck, 'inspection', 'completed', inMonth(10), 10_000, 0.5);
    await repair(w.truck, 'corrective', 'completed', afterMonth(), 999_999); // finished later: open at the month's end
    await repair(w.van, 'corrective', 'in_progress', null, 0);
    await repair(w.van, 'corrective', 'open', null, 0, 0, afterMonth()); // opened later: not counted
    await repair(w.van, 'corrective', 'cancelled', null, 0);
    const res = await get(`/reports/maintenance?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['fleet_owner']));
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { registration_number: w.truck.registration_number, depot: w.depot.name, completed: 3, preventive: 1, corrective: 1, other: 1, open: 1, labour_minutes: 240, cost_cents: 430_000 },
      { registration_number: w.van.registration_number, depot: w.depot.name, completed: 0, preventive: 0, corrective: 0, other: 0, open: 1, labour_minutes: 0, cost_cents: 0 },
    ]);
    expect(res.body.data.totals).toMatchObject({ completed: 3, open: 2, labour_minutes: 240, cost_cents: 430_000 });
  });

  test('cost: fuel and repairs per vehicle and per km driven', async () => {
    const w = await world();
    await trip(w.road, w.van, w.driver, inMonth(3), 50);
    await fill(w.van, 10_000, 250_000, inMonth(5));
    await repair(w.van, 'preventive', 'completed', inMonth(6), 50_000);
    await repair(w.truck, 'corrective', 'completed', inMonth(7), 400_000);
    const res = await get(`/reports/cost?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['finance_clerk'], w.depot));
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { registration_number: w.truck.registration_number, depot: w.depot.name, distance_m: 0, fuel_cost_cents: 0, maintenance_cost_cents: 400_000, total_cost_cents: 400_000, cost_per_km_cents: null },
      { registration_number: w.van.registration_number, depot: w.depot.name, distance_m: 50_000, fuel_cost_cents: 250_000, maintenance_cost_cents: 50_000, total_cost_cents: 300_000, cost_per_km_cents: 6000 },
    ]);
    expect(res.body.data.totals).toMatchObject({ total_cost_cents: 700_000, distance_m: 50_000, cost_per_km_cents: 14_000 });
  });

  test('trip history: every trip scheduled in the month, in order, with its vehicle, driver and whether it ended on time', async () => {
    const w = await world();
    await trip(w.road, w.truck, w.driver, inMonth(2, 8), 95, { lateMinutes: 5 });
    await trip(w.road, w.van, w.driver, inMonth(3, 8), 101, { lateMinutes: 45, planned: 99 });
    await trip(w.road, w.truck, w.driver, inMonth(4, 8), 0, { status: 'cancelled' });
    await trip(w.road, w.truck, w.driver, afterMonth(), 50); // next month
    const res = await get(`/reports/trips?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['dispatcher'], w.depot));
    expect(res.status).toBe(200);
    const { rows, totals } = res.body.data;
    expect(rows.map((r: { status: string; on_time: string | null }) => [r.status, r.on_time])).toEqual([
      ['Completed', 'Yes'],
      ['Completed', 'No'],
      ['Cancelled', null],
    ]);
    expect(rows[1]).toMatchObject({ route: w.road.name, registration_number: w.van.registration_number, driver: 'Test Driver', planned_distance_m: 99_000, actual_distance_m: 101_000 });
    expect(rows[0].scheduled_start).toBe(inMonth(2, 8).toISOString());
    expect(totals).toMatchObject({ route: 'Total: 3 trips', status: '2 completed', on_time: '50%', actual_distance_m: 196_000 });
  });

  test('driver performance: trips, km, hours and punctuality, with the flags and incidents of the month', async () => {
    const w = await world();
    const t1 = await trip(w.road, w.truck, w.driver, inMonth(2, 8), 100);
    await trip(w.road, w.truck, w.driver, inMonth(3, 8), 50, { lateMinutes: 60 });
    // Each one over by the time the next began: a vehicle has one ongoing flag of a type at a time.
    for (const [i, flag] of ['speeding', 'speeding', 'idling'].entries()) {
      await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, severity, observed_at, resolved_at, details) VALUES ($1, $2, $3, 'high', $4, $5, '{}')", [
        w.truck.id,
        t1.id,
        flag,
        inMonth(2, 9, i * 10),
        inMonth(2, 9, i * 10 + 5),
      ]);
    }
    const reporter = await createUser({ roles: ['driver'], depot: w.depot });
    await pool.query("INSERT INTO alert.incident_reports (reported_by, driver_id, vehicle_id, description, severity, depot_id, occurred_at) VALUES ($1, $2, $3, 'Flat tyre', 'medium', $4, $5)", [
      reporter.id,
      w.driver.id,
      w.truck.id,
      w.depot.id,
      inMonth(3, 9),
    ]);
    const res = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['admin']));
    expect(res.status).toBe(200);
    // Two trips of 2 h and 3 h; one of two on time. Two trips are too few for a score (FMS-146, driver-score.test.ts).
    expect(res.body.data.rows).toEqual([{ rank: null, score: 'Not enough trips', driver: 'Test Driver', depot: w.depot.name, trips_completed: 2, distance_m: 150_000, driving_minutes: 300, on_time_pct: 50, speeding: 2, idling: 1, incidents: 1 }]);
  });

  test("scope and permissions: a depot's staff see their depot only; no analytics:read is 403; an unknown report is 404", async () => {
    const w = await world();
    await fill(w.truck, 1_000, 100, inMonth(4));
    await fill(w.elsewhere, 2_000, 200, inMonth(4));
    const dispatcher = await signIn(['dispatcher'], w.depot);
    const mine = await get(`/reports/fuel?month=${MONTH}`, dispatcher);
    expect(mine.body.data.rows.map((r: { registration_number: string }) => r.registration_number)).toEqual([w.truck.registration_number]);
    // Another depot's id is a filter that matches nothing, not a way in.
    const theirs = await get(`/reports/fuel?month=${MONTH}&depot_id=${w.other.public_id}`, dispatcher);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data).toMatchObject({ rows: [], totals: null, depot: null });

    for (const roles of [['driver'], ['depot_admin'], ['technician']] as RoleName[][]) {
      expect((await get(`/reports/fuel?month=${MONTH}`, await signIn(roles, w.depot))).status).toBe(403);
    }
    const manager = await signIn(['fleet_manager']);
    expect((await get(`/reports/payroll?month=${MONTH}`, manager)).status).toBe(404);
    expect((await get('/reports/fuel?month=2026-13', manager)).body.error.details).toEqual([{ field: 'month', reason: 'invalid_format' }]);
    expect((await get('/reports/fuel?month=2999-01', manager)).body.error.details).toEqual([{ field: 'month', reason: 'future_month' }]);
    expect((await get(`/reports/fuel?month=${MONTH}&format=xlsx`, manager)).status).toBe(400);
  });

  test('a monthly fuel report for 200 vehicles generates in under 10 seconds, as JSON and as PDF', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const { rows: vehicles } = await pool.query(
      `INSERT INTO fleet.vehicles (depot_id, registration_number, vehicle_type, fuel_type, fuel_efficiency_ml_per_km, make, model)
       SELECT $1, 'PF-' || $2 || '-' || g, 'truck', 'diesel', 320, 'Isuzu', 'FSR' FROM generate_series(1, 200) g RETURNING id`,
      [depot.id, depot.code],
    );
    const ids = vehicles.map((v) => v.id);
    // 15 fill-ups and 10 completed trips each over the month: 3,000 fill-ups and 2,000 trips.
    await pool.query(
      `INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at)
       SELECT v, 'diesel', 40000 + g * 100, 1000000 + g, $2::timestamptz + make_interval(hours => g * 40) FROM unnest($1::bigint[]) v, generate_series(1, 15) g`,
      [ids, inMonth(1, 6)],
    );
    await pool.query(
      `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km)
       SELECT v, $3, 'completed', s, s + interval '3 hours', s, s + interval '3 hours', 150
       FROM unnest($1::bigint[]) v, generate_series(1, 10) g, LATERAL (SELECT $2::timestamptz + make_interval(days => g * 2) AS s) x`,
      [ids, inMonth(1, 6), driver.id],
    );
    const cookie = await signIn(['fleet_manager']);

    const started = performance.now();
    const res = await get(`/reports/fuel?month=${MONTH}&depot_id=${depot.public_id}`, cookie);
    const json = performance.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(200);
    expect(res.body.data.totals).toMatchObject({ fill_ups: 3000, distance_m: 300_000_000 });
    expect(json).toBeLessThan(10_000);

    const pdfStarted = performance.now();
    const pdf = await get(`/reports/fuel?month=${MONTH}&depot_id=${depot.public_id}&format=pdf`, cookie).buffer(true);
    expect(pdf.status).toBe(200);
    expect(performance.now() - pdfStarted).toBeLessThan(10_000);
    expect(Number(/\/Count (\d+)/.exec((pdf.body as Buffer).toString('latin1'))![1])).toBeGreaterThan(5);
  });
});
