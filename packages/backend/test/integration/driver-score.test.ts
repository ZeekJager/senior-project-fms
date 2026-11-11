import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { addisDay } from '../../src/modules/analytics/domain/kpis';
import { settings } from '../../src/modules/settings';
import { copyDriverAccount, createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-146: the driver performance score, in the driver performance report, the ranking and a driver's own record.
// The scoring itself is unit-tested (src/modules/analytics/domain/driver-score.test.ts); this is the month's figures
// read from the database, who may see them, and the weights coming from Settings.

const app = createApp();
const PASSWORD = 'Driver-Score-Test-1';

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

afterEach(() => settings.forget());

async function cookieOf(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const signIn = async (roles: RoleName[], depot: Depot | null = null) => cookieOf((await createUser({ roles, depot, password: PASSWORD })).email);
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** Last month in Addis Ababa, YYYY-MM, and a time in it. */
const MONTH = (() => {
  const [y, m] = addisDay(new Date()).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const inMonth = (day: number, hour = 8, minute = 0) => new Date(`${MONTH}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);

/** A driver who can sign in, with a truck of their own in `depot`. */
async function driverIn(depot: Depot, name: string) {
  const user = await createUser({ roles: ['driver'], depot, password: PASSWORD, fullName: name });
  const driver = (await pool.query<Row>("INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, 'LIC-' || gen_random_uuid(), '2030-12-31') RETURNING *", [user.id])).rows[0];
  await copyDriverAccount(user.id);
  const truck = (await createVehicle({ depot })) as Row;
  return { user, driver, truck };
}

type Driver = Awaited<ReturnType<typeof driverIn>>;

interface Day {
  late?: boolean;
  inspected?: boolean;
  speeding?: number;
}

/** A completed 100 km trip of 2 hours on each `day` of the month, on time unless late (by an hour), with what happened on it. */
async function month(d: Driver, days: Day[]) {
  for (const [i, day] of days.entries()) {
    const start = inMonth(i + 2);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    const trip = (
      await pool.query<Row>(
        `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km)
         VALUES ($1, $2, 'completed', $3, $4, $3, $5, 100) RETURNING *`,
        [d.truck.id, d.driver.id, start, end, new Date(end.getTime() + (day.late ? 60 : 0) * 60_000)],
      )
    ).rows[0];
    if (day.inspected) {
      await pool.query("INSERT INTO fleet.dvir_reports (vehicle_id, driver_id, trip_id, inspection_type, submitted_at) VALUES ($1, $2, $3, 'pre_trip', $4)", [
        d.truck.id,
        d.driver.id,
        trip.id,
        new Date(start.getTime() - 600_000),
      ]);
    }
    // Each one over before the next: a vehicle has one ongoing flag of a type at a time.
    for (let k = 0; k < (day.speeding ?? 0); k++) {
      await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, severity, observed_at, resolved_at, details) VALUES ($1, $2, 'speeding', 'high', $3, $4, '{}')", [
        d.truck.id,
        trip.id,
        new Date(start.getTime() + (k * 10 + 5) * 60_000),
        new Date(start.getTime() + (k * 10 + 8) * 60_000),
      ]);
    }
  }
}

async function incident(d: Driver, type: string, depot: Depot) {
  await pool.query('INSERT INTO alert.incident_reports (reported_by, driver_id, vehicle_id, incident_type, description, severity, depot_id, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
    d.user.id,
    d.driver.id,
    d.truck.id,
    type,
    'On the road',
    'medium',
    depot.id,
    inMonth(4, 9),
  ]);
}

/**
 * A depot of three drivers last month:
 * - Abebe: 4 trips, all on time and inspected, nothing flagged: 100.
 * - Bekele: 4 trips (400 km), 2 late (punctuality 50), 4 speeding (1 per 100 km: safety 80), an accident (0.25 per
 *   100 km: incidents 50) and a breakdown (not counted), 3 inspected (75): (50·35 + 80·35 + 50·20 + 75·10) / 100 = 63.
 * - Chaltu: 2 trips: not enough for a score.
 */
async function depotOfThree() {
  const depot = await createDepot();
  const abebe = await driverIn(depot, 'Abebe Score');
  const bekele = await driverIn(depot, 'Bekele Score');
  const chaltu = await driverIn(depot, 'Chaltu Score');
  await month(abebe, [{ inspected: true }, { inspected: true }, { inspected: true }, { inspected: true }]);
  await month(bekele, [{ late: true, inspected: true, speeding: 2 }, { late: true, inspected: true }, { inspected: true, speeding: 2 }, {}]);
  await incident(bekele, 'accident', depot);
  await incident(bekele, 'breakdown', depot);
  await month(chaltu, [{ inspected: true }, { inspected: true }]);
  return { depot, abebe, bekele, chaltu };
}

const keys = (columns: { key: string }[]) => columns.map((c) => c.key);

describe('the driver performance report (FMS-146)', () => {
  test('gains a rank and a score, drivers in rank order; a driver with too few trips has the reason, not a low score', async () => {
    const w = await depotOfThree();
    const cookie = await signIn(['fleet_manager']);
    const res = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}`, cookie);
    expect(res.status).toBe(200);
    expect(keys(res.body.data.columns).slice(0, 4)).toEqual(['rank', 'driver', 'depot', 'score']);
    expect(res.body.data.rows.map((r: Record<string, unknown>) => [r.rank, r.driver, r.score, r.trips_completed, r.incidents])).toEqual([
      [1, 'Abebe Score', 100, 4, 0],
      [2, 'Bekele Score', 63, 4, 2],
      [null, 'Chaltu Score', 'Not enough trips', 2, 0],
    ]);
    expect(res.body.data.totals).toMatchObject({ rank: null, score: null, driver: 'Total', depot: '3 drivers' });

    const csv = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}&format=csv`, cookie);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Rank,Driver,Depot,Score (0-100),Trips,Distance (km),Driving (h),On time (%),Speeding,Idling,Incidents');
    expect(lines[1]).toBe(`1,Abebe Score,${w.depot.name},100,4,400.0,8.0,100,0,0,0`);
    expect(lines[3]).toBe(`,Chaltu Score,${w.depot.name},Not enough trips,2,200.0,4.0,100,0,0,0`);

    const pdf = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}&format=pdf`, cookie).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  test('a role without tracking:read (the finance clerk) gets the report without the rank and score, in its usual order', async () => {
    const w = await depotOfThree();
    const res = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['finance_clerk'], w.depot));
    expect(res.status).toBe(200);
    expect(keys(res.body.data.columns)).not.toContain('rank');
    expect(keys(res.body.data.columns)).not.toContain('score');
    for (const row of res.body.data.rows) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['rank']));
    expect(res.body.data.rows.map((r: { driver: string }) => r.driver)).toEqual(['Abebe Score', 'Bekele Score', 'Chaltu Score']);
    const csv = await get(`/reports/drivers?month=${MONTH}&format=csv`, await signIn(['finance_clerk'], w.depot));
    expect(csv.text.replace(/^﻿/, '').split('\r\n')[0]).toBe('Driver,Depot,Trips,Distance (km),Driving (h),On time (%),Speeding,Idling,Incidents');
  });

  test('the weights are settings: an administrator changes them, and the score follows; they cannot all be 0', async () => {
    const w = await depotOfThree();
    const admin = await signIn(['admin']);
    const patch = (body: Record<string, number | null>) => request(app).patch('/api/v1/settings').set('Cookie', admin).send(body);
    expect(
      (await patch({ driver_score_weight_punctuality: 100, driver_score_weight_safety: 0, driver_score_weight_incidents: 0, driver_score_weight_dvir: 0 })).status,
    ).toBe(200);
    const res = await get(`/reports/drivers?month=${MONTH}&depot_id=${w.depot.public_id}`, admin);
    // Punctuality alone: Bekele ended 2 of 4 on time.
    expect(res.body.data.rows[1]).toMatchObject({ driver: 'Bekele Score', score: 50 });

    const zero = await patch({ driver_score_weight_punctuality: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.error.details).toEqual([{ field: 'driver_score_weight_punctuality', reason: 'all_zero' }]);
    const list = (await get('/settings', admin)).body.data as { key: string; value: number; unit: string }[];
    expect(list.filter((s) => s.key.startsWith('driver_score_weight_')).map((s) => [s.key, s.value, s.unit])).toEqual([
      ['driver_score_weight_punctuality', 100, 'weight'],
      ['driver_score_weight_safety', 0, 'weight'],
      ['driver_score_weight_incidents', 0, 'weight'],
      ['driver_score_weight_dvir', 0, 'weight'],
    ]);
  });
});

describe('GET /analytics/driver-ranking (FMS-146)', () => {
  test("the scored drivers in rank order with their components, in the caller's depots; those with no score counted", async () => {
    const w = await depotOfThree();
    const res = await get(`/analytics/driver-ranking?month=${MONTH}&depot_id=${w.depot.public_id}`, await signIn(['fleet_manager']));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      month: MONTH,
      depot: { id: w.depot.public_id },
      weights: { punctuality: 35, safety: 35, incidents: 20, dvir: 10 },
      unscored: 1,
      min_trips: 3,
    });
    expect(res.body.data.drivers).toEqual([
      { driver_id: w.abebe.driver.public_id, name: 'Abebe Score', depot: w.depot.name, rank: 1, score: 100, components: { punctuality: 100, safety: 100, incidents: 100, dvir: 100 }, trips_completed: 4 },
      { driver_id: w.bekele.driver.public_id, name: 'Bekele Score', depot: w.depot.name, rank: 2, score: 63, components: { punctuality: 50, safety: 80, incidents: 50, dvir: 75 }, trips_completed: 4 },
    ]);
    expect(res.body.meta.data_freshness).toMatchObject({ source: 'primary' });

    // Another depot's dispatcher sees none of them.
    const other = await createDepot();
    const theirs = await get(`/analytics/driver-ranking?month=${MONTH}`, await signIn(['dispatcher'], other));
    expect(theirs.status).toBe(200);
    expect(theirs.body.data.drivers.filter((d: { driver_id: string }) => d.driver_id === w.abebe.driver.public_id)).toEqual([]);
  });

  test('is behavioural data: analytics:read is not enough (finance clerk), and a driver never sees it', async () => {
    const w = await depotOfThree();
    expect((await get(`/analytics/driver-ranking?month=${MONTH}`, await signIn(['finance_clerk'], w.depot))).status).toBe(403);
    expect((await get(`/analytics/driver-ranking?month=${MONTH}`, await cookieOf(w.abebe.user.email))).status).toBe(403);
    expect((await get('/analytics/driver-ranking?month=2026-13', await signIn(['admin']))).status).toBe(400);
  });
});

describe('GET /analytics/my-performance (FMS-146)', () => {
  test("a driver sees their own score and its components, what they come from, and no rank and no one else's", async () => {
    const w = await depotOfThree();
    const res = await get(`/analytics/my-performance?month=${MONTH}`, await cookieOf(w.bekele.user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      month: MONTH,
      period: expect.any(Object),
      score: 63,
      reason: null,
      min_trips: 3,
      trips_completed: 4,
      distance_m: 400_000,
      components: {
        punctuality: { score: 50, weight: 35, trips_timed: 4, trips_on_time: 2 },
        safety: { score: 80, weight: 35, speeding: 4, idling: 0 },
        incidents: { score: 50, weight: 20, accidents: 1 },
        dvir: { score: 75, weight: 10, trips_inspected: 3 },
      },
      generated_at: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('Abebe');
  });

  test('too few trips, or a month with none, is no score with its reason; a staff member has no record (404)', async () => {
    const w = await depotOfThree();
    const chaltu = await get(`/analytics/my-performance?month=${MONTH}`, await cookieOf(w.chaltu.user.email));
    expect(chaltu.body.data).toMatchObject({ score: null, reason: 'not_enough_trips', trips_completed: 2, components: { punctuality: { score: 100 } } });
    const idle = await driverIn(w.depot, 'Dawit Score');
    expect((await get(`/analytics/my-performance?month=${MONTH}`, await cookieOf(idle.user.email))).body.data).toMatchObject({ score: null, reason: 'not_enough_trips', trips_completed: 0 });
    expect((await get('/analytics/my-performance', await signIn(['dispatcher'], w.depot))).status).toBe(404);
  });
});
