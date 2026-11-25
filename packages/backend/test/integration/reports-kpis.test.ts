import { inflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { addisDay } from '../../src/modules/analytics/domain/kpis';
import { REPORT_KINDS } from '../../src/modules/analytics/domain/reports';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-160: any period and filters on every report; the utilisation, compliance and safety reports; the KPI dashboard
// against its targets; trends; Excel with typed cells; PDF with an embedded Unicode font.

const app = createApp();
const PASSWORD = 'Reports-Kpis-Test-1';
const DAY = 86_400_000;
type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const binary = (path: string, cookie: string) =>
  get(path, cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

/** Last month in Addis Ababa, YYYY-MM, a time in it, and its first and last days. */
const MONTH = (() => {
  const [y, m] = addisDay(new Date()).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const DAYS_IN_MONTH = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).getUTCDate();
const inMonth = (day: number, hour = 10) => new Date(`${MONTH}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+03:00`);
const LONG_AGO = new Date(Date.now() - 400 * DAY);

async function route(depot: Depot, name: string): Promise<Row> {
  return (await pool.query('INSERT INTO trip.routes (name, depot_id, origin_name, destination_name) VALUES ($1, $2, $3, $4) RETURNING *', [name, depot.id, 'Bole', 'Adama'])).rows[0];
}

async function trip(r: Row, vehicle: Row, driver: Row, start: Date, km: number, lateMinutes = 0): Promise<Row> {
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return (
    await pool.query(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, planned_distance_km, actual_distance_km)
       VALUES ($1, $2, $3, 'completed', $4, $5, $4, $6, $7, $7) RETURNING *`,
      [r.id, vehicle.id, driver.id, start, end, new Date(end.getTime() + lateMinutes * 60_000), km],
    )
  ).rows[0];
}

const fill = (vehicle: Row, ml: number, cents: number, at: Date) =>
  pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', $2, $3, $4)`, [vehicle.id, ml, cents, at]);

/** Two depots: in A a truck and a van, a driver, a route; in B a truck, a driver, a route. All in the fleet for a year. */
async function world() {
  const a = await createDepot();
  const b = await createDepot();
  const driverA = (await createDriver({ depot: a })).driver as Row;
  const driverB = (await createDriver({ depot: b })).driver as Row;
  const truck = (await createVehicle({ depot: a, created_at: LONG_AGO, fuel_efficiency_ml_per_km: 300 })) as Row;
  const van = (await createVehicle({ depot: a, created_at: LONG_AGO, vehicle_type: 'van' })) as Row;
  const truckB = (await createVehicle({ depot: b, created_at: LONG_AGO })) as Row;
  return { a, b, driverA, driverB, truck, van, truckB, roadA: await route(a, `A ${a.code}`), roadA2: await route(a, `A2 ${a.code}`), roadB: await route(b, `B ${b.code}`) };
}

describe('periods and filters on every report (FMS-160)', () => {
  test('a quarter, a year or a custom range; several depots, a vehicle type, a vehicle, a driver or a route narrow the rows', async () => {
    const w = await world();
    await trip(w.roadA, w.truck, w.driverA, inMonth(3), 100);
    await trip(w.roadA2, w.van, w.driverA, inMonth(4), 50);
    await trip(w.roadB, w.truckB, w.driverB, inMonth(5), 70);
    const cookie = await signIn(['fleet_manager']);
    const both = `depot_ids=${w.a.public_id},${w.b.public_id}`;
    const regs = async (q: string) => ((await get(`/reports/trips?${q}`, cookie)).body.data.rows as { registration_number: string }[]).map((r) => r.registration_number).sort();

    const from = `${MONTH}-01`;
    const to = `${MONTH}-${DAYS_IN_MONTH}`;
    const all = await get(`/reports/trips?from=${from}&to=${to}&${both}`, cookie);
    expect(all.status).toBe(200);
    expect(all.body.data.period).toMatchObject({ kind: 'range', first_day: from, last_day: to });
    expect(all.body.data.rows).toHaveLength(3);
    expect(await regs(`year=${MONTH.slice(0, 4)}&${both}`)).toHaveLength(3);
    const q = Math.floor((Number(MONTH.slice(5, 7)) - 1) / 3) + 1;
    expect(await regs(`quarter=${MONTH.slice(0, 4)}-Q${q}&${both}`)).toHaveLength(3);

    expect(await regs(`month=${MONTH}&depot_ids=${w.a.public_id}`)).toEqual([w.truck.registration_number, w.van.registration_number].sort());
    expect(await regs(`month=${MONTH}&${both}&vehicle_type=van`)).toEqual([w.van.registration_number]);
    expect(await regs(`month=${MONTH}&${both}&vehicle_id=${w.truckB.public_id}`)).toEqual([w.truckB.registration_number]);
    expect(await regs(`month=${MONTH}&${both}&driver_id=${w.driverB.public_id}`)).toEqual([w.truckB.registration_number]);
    expect(await regs(`month=${MONTH}&${both}&route_id=${w.roadA2.public_id}`)).toEqual([w.van.registration_number]);
    // The answer says what it was narrowed by.
    expect(all.body.data.filters.depot_ids).toEqual([w.a.public_id, w.b.public_id].map(String));

    const tooLong = await get(`/reports/trips?from=2025-01-01&to=2026-01-02`, cookie);
    expect([tooLong.status, tooLong.body.error.details[0]]).toEqual([400, { field: 'to', reason: 'range_too_long' }]);
    // A depot's staff name another depot's vehicle: not found.
    const dispatcher = await signIn(['dispatcher'], w.a);
    expect((await get(`/reports/trips?month=${MONTH}&vehicle_id=${w.truckB.public_id}`, dispatcher)).status).toBe(404);
    expect((await get(`/reports/trips?month=${MONTH}&depot_ids=${w.b.public_id}`, dispatcher)).status).toBe(404);
  });

  test('the ?month= links and the CSV export keep working', async () => {
    const w = await world();
    await trip(w.roadA, w.truck, w.driverA, inMonth(3), 100);
    const cookie = await signIn(['fleet_manager']);
    const json = await get(`/reports/trips?month=${MONTH}&depot_id=${w.a.public_id}`, cookie);
    expect(json.body.data).toMatchObject({ month: MONTH, depot: { id: w.a.public_id } });
    const csv = await get(`/reports/trips?month=${MONTH}&depot_id=${w.a.public_id}&format=csv`, cookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toMatch(new RegExp(`trip-history-${MONTH}.*\\.csv`));
    expect(csv.text).toContain(String(w.truck.registration_number));
  });
});

describe('the new reports (FMS-160)', () => {
  test('utilisation and downtime: days in the fleet, available and in use; downtime by cause; availability', async () => {
    const w = await world();
    for (const d of [3, 4, 10]) await trip(w.roadA, w.truck, w.driverA, inMonth(d), 100);
    // Two whole days broken down.
    await pool.query(`INSERT INTO fleet.downtime_periods (vehicle_id, opened_by, started_at, ended_at, derived_reason) VALUES ($1, 'test', $2, $3, 'breakdown')`, [w.truck.id, inMonth(20, 0), inMonth(22, 0)]);
    const cookie = await signIn(['fleet_manager']);
    const res = await get(`/reports/utilisation?month=${MONTH}&depot_ids=${w.a.public_id}`, cookie);
    expect(res.status).toBe(200);
    const truck = res.body.data.rows.find((r: { registration_number: string }) => r.registration_number === w.truck.registration_number);
    expect(truck).toMatchObject({ days_in_fleet: DAYS_IN_MONTH, days_available: DAYS_IN_MONTH - 2, days_in_use: 3, breakdown_minutes: 2 * 1440, downtime_minutes: 2 * 1440 });
    expect(truck.utilisation_pct).toBe(Math.round((3 * 100) / (DAYS_IN_MONTH - 2)));
    expect(truck.availability_pct).toBe(Math.round(((DAYS_IN_MONTH - 2) * 100) / DAYS_IN_MONTH));
    expect(res.body.data.totals).toMatchObject({ days_in_use: 3, days_in_fleet: 2 * DAYS_IN_MONTH });
  });

  test('maintenance compliance: programmed services on time, late and overdue; repeat repairs; MTBF; cost by system and vendor', async () => {
    const w = await world();
    const program = (await pool.query("INSERT INTO maintenance.service_programs (depot_id, name, interval_km, lead_km) VALUES ($1, 'Service A', 10000, 1000) RETURNING id", [w.a.id])).rows[0].id;
    const record = (type: string, status: string, scheduled: Date | null, completed: Date | null, cents: number, workshop: string | null, programId: unknown = null) =>
      pool.query(
        `INSERT INTO maintenance.maintenance_records (vehicle_id, maintenance_type, status, scheduled_at, completed_at, total_cost_cents, workshop, service_program_id, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Work') RETURNING id`,
        [w.truck.id, type, status, scheduled, completed, cents, workshop, programId],
      );
    await record('preventive', 'completed', inMonth(5), inMonth(5, 15), 100_00, 'Moenco', program);
    await record('preventive', 'completed', inMonth(6), inMonth(9), 100_00, 'Moenco', program);
    await record('preventive', 'scheduled', inMonth(8), null, 0, null, program);
    const first = (await record('corrective', 'completed', null, inMonth(10), 500_00, 'Abay Garage')).rows[0].id;
    const again = (await record('corrective', 'completed', null, inMonth(25), 700_00, 'Abay Garage')).rows[0].id;
    for (const [id, at] of [[first, inMonth(9)], [again, inMonth(24)]] as const) {
      await pool.query("INSERT INTO maintenance.failure_events (vehicle_id, component, failure_mode, detected_by, unplanned, occurred_at, maintenance_record_id) VALUES ($1, 'brakes', 'wear', 'technician', true, $2, $3)", [w.truck.id, at, id]);
    }
    const cookie = await signIn(['fleet_manager']);
    const res = await get(`/reports/compliance?month=${MONTH}&vehicle_id=${w.truck.public_id}`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0]).toMatchObject({ pm_on_time: 1, pm_late: 1, pm_overdue: 1, pm_compliance_pct: 33, corrective: 2, repeat_repairs: 1, unplanned_failures: 2, cost_cents: 1400_00 });
    expect(res.body.data.rows[0].mtbf_minutes).toBe(Math.round((DAYS_IN_MONTH * 1440) / 2));
    const [bySystem, byVendor] = res.body.data.sections;
    expect(bySystem.rows).toEqual([{ name: 'brakes', repairs: 2, cost_cents: 1200_00 }, expect.objectContaining({ name: 'Not recorded' })]);
    expect(byVendor.rows.map((r: { name: string }) => r.name)).toEqual(['Abay Garage', 'Moenco']);
  });

  test('safety and incidents: per 100,000 km by depot, driver or route, with appeals', async () => {
    const w = await world();
    const t = await trip(w.roadA, w.truck, w.driverA, inMonth(3), 1000);
    await trip(w.roadB, w.truckB, w.driverB, inMonth(4), 500);
    const reporter = await createUser({ roles: ['dispatcher'], depot: w.a });
    await pool.query(
      "INSERT INTO alert.incident_reports (reported_by, driver_id, vehicle_id, trip_id, incident_type, description, severity, depot_id, occurred_at) VALUES ($1, $2, $3, $4, 'minor_collision', 'Mirror', 'low', $5, $6)",
      [reporter.id, w.driverA.id, w.truck.id, t.id, w.a.id, inMonth(3, 11)],
    );
    const cookie = await signIn(['fleet_manager']);
    const both = `depot_ids=${w.a.public_id},${w.b.public_id}`;
    const byDepot = await get(`/reports/safety?month=${MONTH}&${both}`, cookie);
    expect(byDepot.status).toBe(200);
    const a = byDepot.body.data.rows.find((r: { name: string }) => r.name === w.a.name);
    // One incident in 1,000 km: 100 per 100,000 km, in tenths.
    expect(a).toMatchObject({ distance_m: 1_000_000, incidents: 1, incidents_per_100k_km: 1000 });
    expect(byDepot.body.data.totals).toMatchObject({ distance_m: 1_500_000, incidents: 1, incidents_per_100k_km: Math.round(1e9 / 1_500_000) });
    const byRoute = await get(`/reports/safety?month=${MONTH}&${both}&by=route`, cookie);
    expect(byRoute.body.data.rows.map((r: { name: string }) => r.name).sort()).toEqual([w.roadA.name, w.roadB.name].sort());
    expect((await get(`/reports/safety?month=${MONTH}&${both}&by=driver`, cookie)).body.data.rows).toHaveLength(2);
  });
});

describe('the KPI dashboard (FMS-160)', () => {
  test("each KPI matches its report for the same period and filters, with its change, a 12-month sparkline and a link", { timeout: 120_000 }, async () => {
    const w = await world();
    for (const d of [3, 4]) await trip(w.roadA, w.truck, w.driverA, inMonth(d), 200, d === 4 ? 30 : 0);
    await fill(w.truck, 60_000, 1_500_000, inMonth(5));
    const cookie = await signIn(['fleet_manager']);
    const q = `month=${MONTH}&depot_ids=${w.a.public_id}`;
    const res = await get(`/analytics/kpis?${q}`, cookie);
    expect(res.status).toBe(200);
    const kpi = (key: string) => res.body.data.kpis.find((k: { key: string }) => k.key === key);
    const totals = async (report: string) => (await get(`/reports/${report}?${q}`, cookie)).body.data;

    expect(kpi('cost_per_km').value).toBe((await totals('cost')).totals.cost_per_km_cents);
    expect(kpi('fuel_l_per_100km').value).toBe((await totals('fuel')).totals.consumption_ml_per_km);
    const util = (await totals('utilisation')).totals;
    expect(kpi('utilisation_pct').value).toBe(util.utilisation_pct);
    expect(kpi('availability_pct').value).toBe(util.availability_pct);
    expect(kpi('on_time_pct').value).toBe(50);
    expect(kpi('incidents_per_100k_km').value).toBe((await totals('safety')).totals.incidents_per_100k_km);
    expect(kpi('cost_per_km')).toMatchObject({ report: 'cost', target: 3500, unit: 'cents_per_km' });
    expect(kpi('cost_per_km').sparkline).toHaveLength(12);
    expect(kpi('cost_per_km').sparkline.at(-1)).toEqual([MONTH, kpi('cost_per_km').value]);
    expect(kpi('on_time_pct').previous).toBeNull();
    expect(['green', 'amber', 'red', 'none']).toContain(kpi('utilisation_pct').status);
  });

  test('changing a target in Settings changes the status, without a deployment', { timeout: 120_000 }, async () => {
    const w = await world();
    for (const d of [3, 4]) await trip(w.roadA, w.truck, w.driverA, inMonth(d), 200);
    const cookie = await signIn(['fleet_manager']);
    const admin = await signIn(['admin']);
    const q = `/analytics/kpis?month=${MONTH}&vehicle_id=${w.truck.public_id}`;
    const status = async () => (await get(q, cookie)).body.data.kpis.find((k: { key: string }) => k.key === 'utilisation_pct');
    const before = await status();
    expect(before.value).toBeLessThan(75);
    expect(before.status).toBe('red');
    const set = await request(app).patch('/api/v1/settings/definitions/kpi_utilisation_target_pct').set('Cookie', admin).send({ value: before.value, reason: 'This quarter the target is what we reach' });
    expect(set.status).toBe(200);
    expect(await status()).toMatchObject({ target: before.value, status: 'green' });
  });

  test('a trend: up to 24 months beside last year, and the drill-down by depot and vehicle', { timeout: 120_000 }, async () => {
    const w = await world();
    await trip(w.roadA, w.truck, w.driverA, inMonth(3), 200);
    await trip(w.roadB, w.truckB, w.driverB, inMonth(3), 100);
    const cookie = await signIn(['fleet_manager']);
    const both = `depot_ids=${w.a.public_id},${w.b.public_id}`;
    const res = await get(`/analytics/kpis/utilisation_pct/trend?month=${MONTH}&${both}&months=3&group=depot`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.series).toHaveLength(3);
    // A year before, the vehicles were in the fleet and drove nothing: 0 %.
    expect(res.body.data.series.at(-1)).toMatchObject({ month: MONTH, last_year: 0 });
    expect(res.body.data.breakdown.map((b: { name: string }) => b.name).sort()).toEqual([w.a.name, w.b.name].sort());
    const byVehicle = await get(`/analytics/kpis/utilisation_pct/trend?month=${MONTH}&depot_ids=${w.a.public_id}&group=vehicle`, cookie);
    expect(byVehicle.body.data.breakdown.map((b: { name: string }) => b.name)).toContain(w.truck.registration_number);
    expect((await get(`/analytics/kpis/utilisation_pct/trend?months=25`, cookie)).status).toBe(400);
    expect((await get(`/analytics/kpis/nope/trend`, cookie)).status).toBe(404);
  });
});

describe('Excel and PDF (FMS-160)', () => {
  test('the Excel file has numbers as numbers, a frozen and filtered header, totals, and a sheet of the filters', async () => {
    const w = await world();
    await fill(w.truck, 60_000, 1_500_000, inMonth(5));
    await fill(w.van, 10_000, 250_000, inMonth(6));
    const cookie = await signIn(['fleet_manager']);
    const res = await binary(`/reports/fuel?month=${MONTH}&depot_ids=${w.a.public_id}&format=xlsx`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(new RegExp(`fuel-report-${MONTH}.*\\.xlsx`));
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as never);
    const sheet = book.worksheets[0];
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    const litres = header.indexOf('Fuel (L)') + 1;
    expect(litres).toBeGreaterThan(0);
    const cell = sheet.getRow(2).getCell(litres);
    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBe(60);
    const last = sheet.getRow(sheet.rowCount);
    expect(last.getCell(1).value).toBe('Total');
    expect(last.font?.bold ?? last.getCell(1).font?.bold).toBe(true);
    expect(last.getCell(litres).value).toBe(70);
    const filters = book.getWorksheet('Filters')!;
    const text = filters.getSheetValues().flat().map(String).join(' ');
    expect(text).toContain(MONTH.slice(0, 4));
    expect(text).toContain(String(w.a.name));
  });

  test('a PDF with Amharic names embeds a Unicode font that maps them', async () => {
    const w = await world();
    await pool.query("UPDATE auth.users SET full_name = 'አበበ ከበደ' WHERE id = (SELECT user_id FROM fleet.drivers WHERE id = $1)", [w.driverA.id]);
    await pool.query("UPDATE fleet.driver_accounts SET full_name = 'አበበ ከበደ' WHERE user_id = (SELECT user_id FROM fleet.drivers WHERE id = $1)", [w.driverA.id]);
    await trip(w.roadA, w.truck, w.driverA, inMonth(3), 100);
    const cookie = await signIn(['fleet_manager']);
    const res = await binary(`/reports/drivers?month=${MONTH}&depot_ids=${w.a.public_id}&format=pdf`, cookie);
    expect(res.status).toBe(200);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/\/FontFile2/);
    // The streams, inflated: the font's ToUnicode map carries the Ge'ez letters (U+12A0 is አ, U+1260 is በ).
    const streams: string[] = [];
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = raw.indexOf('endstream', start);
      try {
        streams.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
      } catch {
        /* not deflated */
      }
    }
    const maps = streams.filter((s) => s.includes('beginbfchar') || s.includes('beginbfrange')).join('\n').toLowerCase();
    expect(maps).toContain('12a0');
    expect(maps).toContain('1260');
  });
});

describe('speed (FMS-160)', () => {
  test('every report runs for a year of 200 vehicles, filtered, in under 10 seconds', { timeout: 300_000 }, async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const road = await route(depot, `Speed ${depot.code}`);
    const vehicles = await pool.query(
      `INSERT INTO fleet.vehicles (depot_id, registration_number, vehicle_type, fuel_type, fuel_efficiency_ml_per_km, make, model, created_at)
       SELECT $1, 'SP-' || $2 || '-' || n, (CASE WHEN n % 4 = 0 THEN 'van' ELSE 'truck' END)::shared.vehicle_type, 'diesel', 300, 'Isuzu', 'FSR', now() - interval '400 days'
         FROM generate_series(1, 200) n RETURNING id`,
      [depot.id, depot.code],
    );
    const ids = vehicles.rows.map((r) => r.id);
    // A trip and a fill-up a week per vehicle for a year: 10,400 of each.
    await pool.query(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, planned_distance_km, actual_distance_km)
       SELECT $1, v, $2, 'completed', s, s + interval '2 hours', s, s + interval '2 hours', 120, 120
         FROM unnest($3::bigint[]) v, generate_series(now() - interval '364 days', now() - interval '1 day', interval '7 days') s`,
      [road.id, (driver as Row).id, ids],
    );
    await pool.query(
      `INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at)
       SELECT v, 'diesel', 36000, 900000, s FROM unnest($1::bigint[]) v, generate_series(now() - interval '364 days', now() - interval '1 day', interval '7 days') s`,
      [ids],
    );
    const cookie = await signIn(['fleet_manager']);
    const to = addisDay(new Date());
    const from = addisDay(new Date(Date.now() - 365 * DAY));
    for (const kind of REPORT_KINDS) {
      const started = Date.now();
      const res = await get(`/reports/${kind}?from=${from}&to=${to}&depot_ids=${depot.public_id}&vehicle_type=truck`, cookie);
      const took = Date.now() - started;
      expect(res.status, kind).toBe(200);
      expect(res.body.meta.data_freshness, kind).toBeTruthy();
      expect(took, `${kind} took ${took} ms`).toBeLessThan(10_000);
    }
  });
});
