import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents } from '../support/events';

// FMS-82: a fill-up is judged by the per-fill-up rules the moment it is logged.
const app = createApp();
const PASSWORD = 'Fuel-Test-1';
type Vehicle = Awaited<ReturnType<typeof createVehicle>>;

async function signIn(roles: RoleName[]) {
  const depot = await createDepot();
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  return { depot, cookie };
}
const post = (body: object, cookie: string) => request(app).post('/api/v1/fuel-logs').set('Cookie', cookie).send(body);
const pub = (row: Record<string, unknown>) => row.public_id as string;
const anomaliesOf = async (vehicle: Vehicle) =>
  (await pool.query('SELECT * FROM fuel.fuel_anomalies WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows;
const body = (vehicle: Vehicle, extra: Record<string, unknown> = {}) => ({
  vehicle_id: pub(vehicle), quantity_ml: 60_000, total_cost_cents: 510_000, odometer_km: 10_000, ...extra,
});

describe('per-fill-up fuel anomaly rules (FMS-82)', () => {
  test('a fill-up above the tank is flagged, with the figures, an event and an alert', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot, tank_capacity_ml: 200_000 });
    const res = await post(body(vehicle, { quantity_ml: 250_000, total_cost_cents: 2_125_000 }), cookie);
    expect(res.status).toBe(201);
    await deliverEvents();
    const rows = await anomaliesOf(vehicle);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ anomaly_type: 'tank_capacity_exceeded', severity: 'high', status: 'open' });
    expect(rows[0].details).toMatchObject({ tank_capacity_ml: 200_000, over_ml: 50_000 });
    const alerts = (await pool.query('SELECT * FROM alert.alerts WHERE vehicle_id = $1', [vehicle.id])).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain('Fill-up above the tank');
    expect(alerts[0].description).toContain('250.00 L');
  });

  test('a plausible fill-up, or a vehicle with no tank size, is not flagged', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot });
    expect((await post(body(vehicle, { quantity_ml: 900_000, total_cost_cents: 7_650_000 }), cookie)).status).toBe(201);
    await deliverEvents();
    expect(await anomaliesOf(vehicle)).toEqual([]);
  });

  test('a refuel too soon for the distance, and a price out of range, are flagged', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot });
    expect((await post(body(vehicle), cookie)).status).toBe(201);
    expect((await post(body(vehicle, { odometer_km: 10_010, total_cost_cents: 60_000 * 25 }), cookie)).status).toBe(201);
    await deliverEvents();
    const types = (await anomaliesOf(vehicle)).map((r) => r.anomaly_type).sort();
    expect(types).toEqual(['price_per_litre_out_of_range', 'refuel_interval_too_short']);
  });

  test('a redelivered FuelLogged adds no second anomaly or event', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot, tank_capacity_ml: 200_000 });
    await post(body(vehicle, { quantity_ml: 250_000, total_cost_cents: 2_125_000 }), cookie);
    await deliverEvents();
    // Forget that the rules consumer handled it, and deliver it again.
    const claimed = await pool.query("DELETE FROM events.processed_events WHERE consumer = 'fuel.fill-up-rules'");
    expect(claimed.rowCount).toBeGreaterThan(0);
    await pool.query("UPDATE events.outbox SET dispatched_at = NULL WHERE event_type = 'FuelLogged'");
    await deliverEvents();
    expect(await anomaliesOf(vehicle)).toHaveLength(1);
    // The redelivery succeeded (nothing to add), it did not fail on the unique index and wait for a retry.
    const open = await pool.query("SELECT last_error, dispatched_at FROM events.outbox WHERE event_type = 'FuelLogged'");
    expect(open.rows.every((r) => r.last_error === null && r.dispatched_at !== null)).toBe(true);
    const events = await pool.query("SELECT 1 FROM events.outbox WHERE event_type = 'FuelAnomalyDetected' AND payload->>'vehicle_id' = $1", [pub(vehicle)]);
    expect(events.rowCount).toBe(1);
  });

  test('a fill-up logged away from where the vehicle was is flagged; one close by is not', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot });
    const at = new Date();
    await pool.query(
      `INSERT INTO tracking.gps_pings (vehicle_id, latitude, longitude, speed_kmh, recorded_at) VALUES ($1, 9.0108, 38.7613, 0, $2)`,
      [vehicle.id, at],
    );
    const near = await post(body(vehicle, { latitude: 9.0118, longitude: 38.7613, fueled_at: at.toISOString() }), cookie);
    expect(near.status).toBe(201);
    const far = await post(body(vehicle, { odometer_km: 10_200, latitude: 9.2108, longitude: 38.7613, fueled_at: at.toISOString() }), cookie);
    expect(far.status).toBe(201);
    await deliverEvents();
    const away = (await anomaliesOf(vehicle)).filter((r) => r.anomaly_type === 'fill_up_away_from_vehicle');
    expect(away).toHaveLength(1);
    expect(away[0].details).toMatchObject({ max_km: 2 });
  });

  test('coordinates: both or neither, and in range', async () => {
    const { depot, cookie } = await signIn(['fleet_manager']);
    const vehicle = await createVehicle({ depot });
    expect((await post(body(vehicle, { latitude: 9 }), cookie)).status).toBe(400);
    expect((await post(body(vehicle, { latitude: 91, longitude: 38 }), cookie)).status).toBe(400);
    const ok = await post(body(vehicle, { latitude: 9.01, longitude: 38.76 }), cookie);
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ latitude: 9.01, longitude: 38.76 });
  });
});
