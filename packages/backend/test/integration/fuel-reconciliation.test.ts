import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { fuelReconciliation } from '../../src/modules/fuel';
import { addisDay, previousMonth, roundDiv } from '../../src/modules/fuel/domain/reconciliation';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// Fuel reconciliation (FMS-41): a month's fuel logged against what the completed trips needed at the vehicle's
// rated efficiency. The monthly job writes an anomaly and FuelAnomalyDetected beyond ±20%; the API reconciles
// any period on demand and writes nothing.

const app = createApp();
const PASSWORD = 'Reconcile-Test-1';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

const savedThreshold = config.fuel.varianceThresholdPct;
afterEach(() => {
  config.fuel.varianceThresholdPct = savedThreshold;
});

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** Today's run of the job: it reconciles the calendar month before today (Addis Ababa). */
const runKey = addisDay(new Date());
const job = () => ({ now: new Date(), correlationId: randomUUID(), runKey });
const month = previousMonth(runKey);
/** A moment inside last month, `days` after it began. */
const inMonth = (days: number, hours = 0) => new Date(month.from.getTime() + days * DAY_MS + hours * HOUR_MS);

let tripHour = 0;
/** A completed trip of `km`, ending at `at` (each a different hour, so a shared driver's trips never overlap). */
async function drove(vehicle: Row, driver: Row, km: number, at = inMonth(10, tripHour++)) {
  await pool.query(
    `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_duration_seconds)
     VALUES ($1, $2, 'completed', $3::timestamptz - interval '50 minutes', $3, $3::timestamptz - interval '50 minutes', $3, $4, 3000)`,
    [vehicle.id, driver.id, at, km],
  );
}

async function fuelled(vehicle: Row, ml: number, cents: number, at = inMonth(12)) {
  await pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', $2, $3, $4)`, [
    vehicle.id,
    ml,
    cents,
    at,
  ]);
}

/** A diesel vehicle rated 320 ml/km that drove 1,000 km last month and was logged `ml`: 320,000 ml is exactly as expected. */
async function vehicleWith(depot: Depot, driver: Row, ml: number, extra: Record<string, unknown> = {}): Promise<Row> {
  const vehicle = (await createVehicle({ depot, ...extra })) as Row;
  await drove(vehicle, driver, 600);
  await drove(vehicle, driver, 400);
  // 1 birr a litre: 100 cents per 1,000 ml.
  await fuelled(vehicle, ml, roundDiv(ml, 10));
  return vehicle;
}

const anomalies = async (vehicle: Row) =>
  (await pool.query('SELECT * FROM fuel.fuel_anomalies WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows as Record<string, unknown>[];

describe('the monthly reconciliation', () => {
  test('25% over expected creates an anomaly and FuelAnomalyDetected; 15% creates none', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const over = await vehicleWith(depot, driver as Row, 400_000);
    const fine = await vehicleWith(depot, driver as Row, 368_000);
    const context = job();

    const result = await fuelReconciliation.run(context);

    expect(result).toMatchObject({ period: addisDay(month.from).slice(0, 7), vehicles: 2, above: 1, within: 1, below: 0, anomalies: 1, already_flagged: 0, threshold_pct: 20 });
    expect(await anomalies(fine)).toEqual([]);
    const [anomaly] = await anomalies(over);
    expect(anomaly).toMatchObject({
      fuel_log_id: null,
      anomaly_type: 'consumption_above_expected',
      severity: 'medium',
      status: 'open',
      period_start: month.from,
      period_end: month.to,
      distance_km: '1000.000',
      expected_ml: '320000',
      actual_ml: '400000',
      expected_consumption_ml_100km: '32000.000',
      actual_consumption_ml_100km: '40000.000',
      deviation_percentage: '25.00',
    });

    const events = await publishedEvents('FuelAnomalyDetected');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: null,
      correlation_id: context.correlationId,
      aggregate: `vehicle:${over.public_id}`,
      payload: {
        anomaly_id: anomaly.public_id,
        vehicle_id: over.public_id,
        driver_id: null,
        trip_id: null,
        fuel_log_id: null,
        anomaly_type: 'consumption_above_expected',
        severity: 'medium',
        period_from: month.from.toISOString(),
        period_to: month.to.toISOString(),
        distance_km: 1000,
        expected_ml: 320_000,
        actual_ml: 400_000,
        deviation_pct: 25,
      },
    });

    // Written as the system, with the run's correlation id.
    const audit = await pool.query("SELECT user_id, action FROM audit.audit_logs WHERE correlation_id = $1 AND entity_type = 'fuel.fuel_anomalies'", [context.correlationId]);
    expect(audit.rows).toEqual([{ user_id: null, action: 'INSERT' }]);
  });

  test('below by more than the threshold is an anomaly too; beyond twice the threshold is high', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const under = await vehicleWith(depot, driver as Row, 240_000);
    const wayOver = await vehicleWith(depot, driver as Row, 480_000);

    await fuelReconciliation.run(job());

    expect(await anomalies(under)).toMatchObject([{ anomaly_type: 'consumption_below_expected', severity: 'medium', deviation_percentage: '-25.00' }]);
    expect(await anomalies(wayOver)).toMatchObject([{ anomaly_type: 'consumption_above_expected', severity: 'high', deviation_percentage: '50.00' }]);
  });

  test('a rerun adds nothing for a month already flagged, and flags a vehicle late fill-ups pushed over', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const over = await vehicleWith(depot, driver as Row, 400_000);
    const later = await vehicleWith(depot, driver as Row, 352_000);
    await fuelReconciliation.run(job());

    // A fill-up from last month, logged late (FMS-115): 352 + 48 = 400 L, now 25% over.
    await fuelled(later, 48_000, 4_800, inMonth(20));
    const result = await fuelReconciliation.run(job());

    expect(result).toMatchObject({ above: 2, anomalies: 1, already_flagged: 1 });
    expect(await anomalies(over)).toHaveLength(1);
    expect(await anomalies(later)).toHaveLength(1);
    expect(await publishedEvents('FuelAnomalyDetected')).toHaveLength(2);
  });

  test('judges only what it can: not electric, not too little driving, only last month', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const electric = (await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null })) as Row;
    await drove(electric, driver as Row, 800);
    const short = (await createVehicle({ depot })) as Row;
    await drove(short, driver as Row, 90);
    await fuelled(short, 200_000, 20_000);
    // Driven and fuelled this month, not last: not part of last month's reconciliation.
    const thisMonth = (await createVehicle({ depot })) as Row;
    await drove(thisMonth, driver as Row, 1000, month.to);
    await fuelled(thisMonth, 900_000, 90_000, new Date(month.to.getTime() + HOUR_MS));

    const result = await fuelReconciliation.run(job());

    expect(result).toMatchObject({ vehicles: 3, not_judged: 3, anomalies: 0 });
    expect(await publishedEvents('FuelAnomalyDetected')).toEqual([]);
  });

  test('the threshold comes from config (FUEL_VARIANCE_THRESHOLD_PCT)', async () => {
    config.fuel.varianceThresholdPct = 10;
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const vehicle = await vehicleWith(depot, driver as Row, 368_000);

    await fuelReconciliation.run(job());

    expect(await anomalies(vehicle)).toMatchObject([{ deviation_percentage: '15.00', severity: 'medium' }]);
  });

  test('the alert says how far off the month was', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    await vehicleWith(depot, driver as Row, 400_000);
    await fuelReconciliation.run(job());

    await deliverEvents();

    const alerts = await pool.query("SELECT severity, title, description FROM alert.alerts WHERE alert_type = 'fuel_anomaly'");
    const monthName = month.from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Addis_Ababa' });
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].severity).toBe('medium');
    expect(alerts.rows[0].description).toBe(`Fuel logged in ${monthName} was 25% more than its 1,000 km of trips needed. Check its fill-ups against its trips.`);
  });

  test('reconciles 200 vehicles over a month in under 60 seconds', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const tag = randomUUID().slice(0, 6);
    const ids = (
      await pool.query<{ id: string }>(
        `INSERT INTO fleet.vehicles (depot_id, registration_number, vehicle_type, fuel_type, fuel_efficiency_ml_per_km, make, model)
         SELECT $1, 'FR-' || $2 || '-' || g, 'truck', 'diesel', 320, 'Isuzu', 'FSR' FROM generate_series(1, 200) g
         RETURNING id`,
        [depot.id, tag],
      )
    ).rows.map((r) => r.id);
    // Each vehicle: 20 trips of 50 km over the month and 8 fill-ups; one in ten 25% over.
    await pool.query(
      `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_duration_seconds)
       SELECT v, $2, 'completed', t - interval '1 hour', t, t - interval '1 hour', t, 50, 3600
         FROM unnest($1::bigint[]) v, generate_series(1, 20) d, LATERAL (SELECT $3::timestamptz + d * interval '1 day' AS t) x`,
      [ids, driver.id, month.from],
    );
    await pool.query(
      `INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at)
       SELECT v, 'diesel', CASE WHEN o % 10 = 0 THEN 50000 ELSE 40000 END, 360000, $2::timestamptz + f * interval '3 days'
         FROM unnest($1::bigint[]) WITH ORDINALITY AS u(v, o), generate_series(1, 8) f`,
      [ids, month.from],
    );

    const started = Date.now();
    const result = await fuelReconciliation.run(job());
    const seconds = (Date.now() - started) / 1000;

    expect(result).toMatchObject({ vehicles: 200, within: 180, above: 20, anomalies: 20 });
    expect(seconds).toBeLessThan(60);
  }, 120_000);
});

describe('GET /fuel-reconciliation', () => {
  test("reconciles last month by default for the caller's depots, furthest from expected first, and writes nothing", async () => {
    const depot = await createDepot();
    const elsewhere = await createDepot();
    const { driver } = await createDriver({ depot });
    const fine = await vehicleWith(depot, driver as Row, 336_000);
    const over = await vehicleWith(depot, driver as Row, 400_000);
    const under = await vehicleWith(depot, driver as Row, 192_000);
    await vehicleWith(elsewhere, driver as Row, 400_000);
    const clerk = await signIn(['finance_clerk'], depot);

    const res = await get('/fuel-reconciliation', clerk);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { vehicle_id: string }) => r.vehicle_id)).toEqual([under.public_id, over.public_id, fine.public_id]);
    expect(res.body.data[1]).toEqual({
      vehicle_id: over.public_id,
      registration_number: over.registration_number,
      depot_id: depot.public_id,
      depot_name: depot.name,
      fuel_type: 'diesel',
      fuel_efficiency_ml_per_km: 320,
      distance_km: 1000,
      trips: 2,
      fuel_logs: 1,
      expected_ml: 320_000,
      actual_ml: 400_000,
      variance_ml: 80_000,
      variance_pct: 25,
      total_cost_cents: 40_000,
      status: 'above',
      reason: null,
      anomaly_id: null,
    });
    expect(res.body.meta).toMatchObject({
      from: month.from.toISOString(),
      to: month.to.toISOString(),
      threshold_pct: 20,
      total_items: 3,
      summary: { vehicles: 3, judged: 3, above: 1, below: 1, expected_ml: 960_000, actual_ml: 928_000, variance_pct: -3, total_cost_cents: 92_800 },
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM fuel.fuel_anomalies')).rows[0].n).toBe(0);
  });

  test('links the anomaly the monthly run raised, filters by status, vehicle, depot and dates', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const over = await vehicleWith(depot, driver as Row, 400_000);
    await vehicleWith(depot, driver as Row, 320_000);
    await fuelReconciliation.run(job());
    const [anomaly] = await anomalies(over);
    const owner = await signIn(['fleet_owner']);

    const above = await get('/fuel-reconciliation?status=above', owner);
    expect(above.body.data).toMatchObject([{ vehicle_id: over.public_id, anomaly_id: anomaly.public_id }]);
    expect(above.body.meta.summary.vehicles).toBe(2);

    const one = await get(`/fuel-reconciliation?vehicle_id=${over.public_id}`, owner);
    expect(one.body.data.map((r: { vehicle_id: string }) => r.vehicle_id)).toEqual([over.public_id]);

    const byDepot = await get(`/fuel-reconciliation?depot_id=${depot.public_id}`, owner);
    expect(byDepot.body.meta.total_items).toBe(2);

    // A period other than the month the anomaly is about: reconciled, but not linked.
    const from = addisDay(month.from);
    const to = addisDay(new Date(month.from.getTime() + 14 * DAY_MS));
    const half = await get(`/fuel-reconciliation?vehicle_id=${over.public_id}&from=${from}&to=${to}`, owner);
    expect(half.body.meta).toMatchObject({ from: month.from.toISOString(), to: new Date(month.from.getTime() + 15 * DAY_MS).toISOString() });
    expect(half.body.data).toMatchObject([{ distance_km: 1000, actual_ml: 400_000, anomaly_id: null }]);
  });

  test('a depot or vehicle outside the caller’s depots matches nothing', async () => {
    const depot = await createDepot();
    const elsewhere = await createDepot();
    const { driver } = await createDriver({ depot: elsewhere });
    const theirs = await vehicleWith(elsewhere, driver as Row, 400_000);
    const clerk = await signIn(['finance_clerk'], depot);

    expect((await get(`/fuel-reconciliation?depot_id=${elsewhere.public_id}`, clerk)).body).toMatchObject({ data: [], meta: { total_items: 0 } });
    expect((await get(`/fuel-reconciliation?vehicle_id=${theirs.public_id}`, clerk)).body.data).toEqual([]);
  });

  test('needs analytics:read and fuel:read: a driver and a dispatcher are refused', async () => {
    const depot = await createDepot();
    expect((await get('/fuel-reconciliation', await signIn(['driver'], depot))).status).toBe(403);
    expect((await get('/fuel-reconciliation', await signIn(['dispatcher'], depot))).status).toBe(403);
    expect((await get('/fuel-reconciliation', await signIn(['compliance_officer']))).status).toBe(200);
  });

  test('refuses a reversed or too long period', async () => {
    const owner = await signIn(['fleet_owner']);
    const reversed = await get('/fuel-reconciliation?from=2026-09-10&to=2026-09-01', owner);
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.details).toEqual([expect.objectContaining({ field: 'to', reason: 'before_from' })]);
    const long = await get('/fuel-reconciliation?from=2025-01-01&to=2026-06-30', owner);
    expect(long.body.error.details).toEqual([expect.objectContaining({ field: 'to', reason: 'period_too_long' })]);
    expect((await get('/fuel-reconciliation?status=bad', owner)).status).toBe(400);
  });
});

describe('GET /vehicles/{vehicle_id}/fuel-summary', () => {
  test('the period’s fuel, distance, efficiency and cost per km, with the open anomalies', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const vehicle = await vehicleWith(depot, driver as Row, 400_000);
    await fuelReconciliation.run(job());
    const manager = await signIn(['depot_admin'], depot);

    const res = await get(`/vehicles/${vehicle.public_id}/fuel-summary?from=${addisDay(month.from)}&to=${addisDay(new Date(month.to.getTime() - DAY_MS))}`, manager);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      vehicle_id: vehicle.public_id,
      from: month.from.toISOString(),
      to: month.to.toISOString(),
      fuel_logs: 1,
      actual_ml: 400_000,
      total_cost_cents: 40_000,
      trips: 2,
      distance_km: 1000,
      rated_efficiency_ml_per_km: 320,
      actual_efficiency_ml_per_km: 400,
      expected_ml: 320_000,
      variance_ml: 80_000,
      variance_pct: 25,
      status: 'above',
      reason: null,
      cost_per_km_cents: 40,
      average_price_cents_per_litre: 100,
      open_anomalies: 1,
      threshold_pct: 20,
    });
  });

  test('defaults to the 30 days to now; nothing logged reads as zeros, not judged', async () => {
    const depot = await createDepot();
    const vehicle = (await createVehicle({ depot })) as Row;
    const before = Date.now();

    const res = await get(`/vehicles/${vehicle.public_id}/fuel-summary`, await signIn(['fleet_manager']));

    expect(res.body.data).toMatchObject({ fuel_logs: 0, actual_ml: 0, distance_km: 0, status: 'not_judged', reason: 'too_little_distance', actual_efficiency_ml_per_km: null, cost_per_km_cents: null, average_price_cents_per_litre: null, open_anomalies: 0 });
    const span = new Date(res.body.data.to).getTime() - new Date(res.body.data.from).getTime();
    expect(span).toBe(30 * DAY_MS);
    expect(new Date(res.body.data.to).getTime()).toBeGreaterThanOrEqual(before);
  });

  test('404 for a vehicle outside the depots, an unknown or malformed id, and for a driver', async () => {
    const depot = await createDepot();
    const elsewhere = await createDepot();
    const theirs = (await createVehicle({ depot: elsewhere })) as Row;
    const mine = (await createVehicle({ depot })) as Row;
    const admin = await signIn(['depot_admin'], depot);

    expect((await get(`/vehicles/${theirs.public_id}/fuel-summary`, admin)).status).toBe(404);
    expect((await get(`/vehicles/${randomUUID()}/fuel-summary`, admin)).status).toBe(404);
    expect((await get('/vehicles/not-a-uuid/fuel-summary', admin)).status).toBe(404);
    expect((await get(`/vehicles/${mine.public_id}/fuel-summary`, await signIn(['driver'], depot))).status).toBe(404);
    expect((await get(`/vehicles/${mine.public_id}/fuel-summary`, await signIn(['dispatcher'], depot))).status).toBe(403);
  });
});
