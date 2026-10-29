import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { analyticsRefresh } from '../../src/modules/analytics';
import { addisDay, dayStart, shiftDay } from '../../src/modules/analytics/domain/kpis';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// The analytics API (FMS-50): KPIs pre-aggregated per vehicle and day into analytics_cache, summed for a range,
// integers throughout, stale after 25 hours without a refresh, in the caller's depot scope.

const app = createApp();
const PASSWORD = 'Analytics-Test-1';
const HOUR_MS = 3_600_000;

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

const today = addisDay(new Date());
const yesterday = shiftDay(today, -1);
/** `hours` into yesterday, Addis Ababa time. */
const at = (hours: number) => new Date(dayStart(yesterday).getTime() + hours * HOUR_MS);
const refresh = () => analyticsRefresh.refresh({ now: new Date(), correlationId: randomUUID(), runKey: today }, shiftDay(today, -3), today);

/** A completed trip of `km` ending `lateMinutes` after its scheduled end, at `endHour` yesterday. */
async function drove(vehicle: Row, driver: Row, km: number, endHour: number, lateMinutes = 0) {
  await pool.query(
    `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_duration_seconds)
     VALUES ($1, $2, 'completed', $3::timestamptz - interval '2 hours', $3::timestamptz - make_interval(mins => $5::int), $3::timestamptz - interval '2 hours', $3, $4, 7200)`,
    [vehicle.id, driver.id, at(endHour), km, lateMinutes],
  );
}

async function fleet(depot: Depot) {
  const { driver } = await createDriver({ depot });
  const vehicle = (await createVehicle({ depot, fuel_efficiency_ml_per_km: 300 })) as Row;
  return { driver: driver as Row, vehicle };
}

describe('the analytics refresh and the fleet summary', () => {
  test('sums the cache into integer KPIs: cost per km in whole cents, utilisation in whole percent', async () => {
    const depot = await createDepot();
    const { driver, vehicle } = await fleet(depot);
    await createVehicle({ depot }); // idle all period
    await drove(vehicle, driver, 123.456, 12);
    await pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', 40000, 10000, $2)`, [vehicle.id, at(13)]);
    await pool.query(
      `INSERT INTO maintenance.maintenance_records (vehicle_id, maintenance_type, status, completed_at, total_cost_cents) VALUES ($1, 'corrective', 'completed', $2, 2345)`,
      [vehicle.id, at(14)],
    );
    const run = await refresh();
    expect(run.rows).toBeGreaterThan(0);

    const cookie = await signIn(['fleet_manager']);
    const res = await get(`/analytics/fleet-summary?from=${yesterday}&to=${yesterday}&depot_id=${depot.public_id}`, cookie);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.vehicles).toMatchObject({ total: 2, by_status: { active: 2 } });
    // 1 of 2 vehicles drove: 50%. 123.456 km; (10,000 + 2,345) cents over 123,456 m = 99.995 → 100 cents a km.
    expect(d).toMatchObject({ utilisation_pct: 50, distance_km: 123, trips_completed: 1, fuel_ml: 40000, fuel_cost_cents: 10000, maintenance_cost_cents: 2345, total_cost_cents: 12345, cost_per_km_cents: 100 });
    expect(Number.isInteger(d.cost_per_km_cents)).toBe(true);
    expect(d.daily).toEqual([expect.objectContaining({ date: yesterday, vehicles_used: 1, cost_per_km_cents: 100 })]);
    expect(res.body.meta).toMatchObject({ from: yesterday, to: yesterday, days: 1, stale: false, data_freshness: { source: 'primary' } });

    const fuel = await get(`/analytics/fuel-efficiency?from=${yesterday}&to=${yesterday}&depot_id=${depot.public_id}`, cookie);
    // 40,000 ml over 123.456 km = 324.0 ml/km against 300 rated: 8% over.
    expect(fuel.body.data[0]).toMatchObject({ vehicle_id: vehicle.public_id, ml_per_km: 324, rated_ml_per_km: 300, variance_pct: 8, fuel_cost_per_km_cents: 81 });

    const use = await get(`/analytics/utilisation?from=${yesterday}&to=${yesterday}&depot_id=${depot.public_id}`, cookie);
    expect(use.body.data).toMatchObject({ utilisation_pct: 50, vehicle_days: 2, days_used: 1 });
    expect(use.body.data.vehicles[0]).toMatchObject({ vehicle_id: vehicle.public_id, utilisation_pct: 100, distance_km: 123 });
  });

  test('a rerun replaces the day instead of adding to it; on time is within 15 minutes of the scheduled end', async () => {
    const depot = await createDepot();
    const { driver, vehicle } = await fleet(depot);
    await drove(vehicle, driver, 50, 9, 10);
    await drove(vehicle, driver, 50, 15, 30);
    await refresh();
    await refresh();

    const cookie = await signIn(['fleet_owner']);
    const res = await get(`/analytics/trips?from=${yesterday}&to=${yesterday}&depot_id=${depot.public_id}`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ planned: 2, completed: 2, on_time: 1, timed: 2, on_time_pct: 50, distance_km: 100, average_distance_km: 50 });
    expect(res.body.data.by_status.completed).toBe(2);
  });

  test('stale: true once the cache is older than 25 hours, false again after a refresh', async () => {
    const depot = await createDepot();
    await createVehicle({ depot });
    const cookie = await signIn(['admin']);
    await refresh();
    await pool.query(`UPDATE analytics.analytics_cache SET computed_at = now() - interval '26 hours'`);
    const old = await get(`/analytics/alerts?depot_id=${depot.public_id}`, cookie);
    expect(old.status).toBe(200);
    expect(old.body.meta.stale).toBe(true);

    await refresh();
    const fresh = await get(`/analytics/alerts?depot_id=${depot.public_id}`, cookie);
    expect(fresh.body.meta.stale).toBe(false);
    expect(fresh.body.meta.days).toBe(30);
    expect(fresh.body.data.daily).toHaveLength(30);
  });
});

describe('who sees what', () => {
  test('analytics:read in the depot scope: other depots are zeros, a driver is refused, a bad range is 400', async () => {
    const mine = await createDepot();
    const other = await createDepot();
    const a = await fleet(mine);
    const b = await fleet(other);
    await drove(a.vehicle, a.driver, 10, 10);
    await drove(b.vehicle, b.driver, 20, 10);
    await pool.query(`INSERT INTO alert.alerts (vehicle_id, depot_id, alert_type, severity, source_module, title, status) VALUES ($1, $2, 'speeding', 'high', 'integration', 'Speeding', 'open')`, [
      b.vehicle.id,
      other.id,
    ]);
    await refresh();

    const dispatcher = await signIn(['dispatcher'], mine);
    const own = await get(`/analytics/fleet-summary?from=${yesterday}&to=${yesterday}`, dispatcher);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ distance_km: 10, vehicles: { total: 1 }, open_alerts: { total: 0 } });
    const theirs = await get(`/analytics/fleet-summary?from=${yesterday}&to=${yesterday}&depot_id=${other.public_id}`, dispatcher);
    expect(theirs.body.data).toMatchObject({ distance_km: 0, vehicles: { total: 0 }, utilisation_pct: null, cost_per_km_cents: null });

    const manager = await signIn(['fleet_manager']);
    const alerts = await get(`/analytics/alerts?depot_id=${other.public_id}`, manager);
    expect(alerts.body.data.open).toMatchObject({ high: 1, total: 1 });
    expect(alerts.body.data.by_type).toEqual([{ alert_type: 'speeding', count: 1 }]);

    const risk = await get(`/analytics/maintenance-risk?depot_id=${mine.public_id}`, manager);
    expect(risk.status).toBe(200);
    expect(risk.body.data).toEqual([expect.objectContaining({ vehicle_id: a.vehicle.public_id, risk_pct: null })]);

    const driver = await signIn(['driver'], mine);
    expect((await get('/analytics/fleet-summary', driver)).status).toBe(403);
    expect((await get(`/analytics/trips?from=${today}&to=${yesterday}`, manager)).status).toBe(400);
    expect((await get(`/analytics/trips?from=2020-01-01&to=${today}`, manager)).status).toBe(400);
  });

  test('answers within 200 ms from the cache for a 200-vehicle month', async () => {
    const depot = await createDepot();
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 1) ids.push(((await createVehicle({ depot })) as Row).id);
    await pool.query(
      `INSERT INTO analytics.analytics_cache (vehicle_id, period_type, period_start, utilisation_pct, cost_per_km_cents, distance_m, trips_completed, fuel_ml, fuel_cost_cents)
       SELECT v, 'day', d::date, 100, 95, 250000, 2, 80000, 8000000 FROM unnest($1::bigint[]) v, generate_series($2::date - 29, $2::date, interval '1 day') d
       ON CONFLICT DO NOTHING`,
      [ids, today],
    );
    const cookie = await signIn(['fleet_manager']);
    await get(`/analytics/fleet-summary?depot_id=${depot.public_id}`, cookie); // warm the connection
    const started = performance.now();
    const res = await get(`/analytics/fleet-summary?depot_id=${depot.public_id}`, cookie);
    const ms = performance.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ utilisation_pct: 100, distance_km: 1_500_000, vehicles: { total: 200 } });
    expect(ms).toBeLessThan(200);
  });
});
