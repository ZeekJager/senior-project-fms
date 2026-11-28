import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { metresBetween } from '../../src/modules/trip/domain/eta';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createDriver, createVehicle } from '../support/factories';

// FMS-165 (docs/meter-readings.md): a trip records the odometer at its start and end, typed by the driver or, at the
// end, estimated from the vehicle's reading at the start plus the GPS distance; the vehicle's odometer follows.

const app = createApp();
const PASSWORD = 'Odometer-Test-1';
type Row = Record<string, unknown> & { id: string; public_id: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DEG_PER_KM = 1 / metresBetween({ latitude: 9, longitude: 38.7 }, { latitude: 9, longitude: 38.701 });

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A depot, a truck at `odometer` km, its driver (signed in) and an assigned trip of theirs. */
async function setup(odometer = 50_000) {
  const depot = await createDepot();
  const vehicle = (await createVehicle({ depot })) as Row;
  await pool.query('UPDATE fleet.vehicles SET odometer_km = $2 WHERE id = $1', [vehicle.id, odometer]);
  const { user, driver } = await createDriver({ depot, license_categories: ['dry_cargo_2'] });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Odometer ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
  const start = new Date(Date.now() + HOUR);
  const trip = (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end)
       VALUES ($1, $2, $3, 'assigned', $4, $5) RETURNING *`,
      [route.id, vehicle.id, driver.id, start, new Date(start.getTime() + 2 * HOUR)],
    )
  ).rows[0];
  return { vehicle, trip, cookie: await login(user.email) };
}

const command = (cookie: string, trip: Row, path: 'start' | 'end', body: object = {}) =>
  request(app).post(`/api/v1/trips/${trip.public_id}/${path}`).set('Cookie', cookie).send(body);

async function readings(vehicle: Row) {
  const res = await pool.query<{ value: number; source: string; source_ref: string | null; suspect: boolean }>(
    "SELECT value::float8 AS value, source, source_ref, suspect FROM fleet.meter_readings WHERE vehicle_id = $1 AND meter = 'odometer' AND source <> 'manual' ORDER BY recorded_at, id",
    [vehicle.id],
  );
  return res.rows;
}
const odometer = async (vehicle: Row) => (await pool.query<{ km: number }>('SELECT odometer_km::float8 AS km FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].km;

/** The trip started an hour ago, with a phone position a minute east at 40 km/h since: 58 minutes, about 38.7 km. */
async function droveAnHour(vehicle: Row, trip: Row) {
  await pool.query('UPDATE trip.trips SET actual_start = $2 WHERE id = $1', [trip.id, new Date(Date.now() - HOUR)]);
  for (let i = 0; i <= 58; i++) {
    await pool.query(
      `INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh, source, recorded_at)
       VALUES ($1, $2, 9, $3, 40, 'phone', $4)`,
      [vehicle.id, trip.id, 38.7 + ((40 * i) / 60) * DEG_PER_KM, new Date(Date.now() - (59 - i) * MIN)],
    );
  }
}

describe('POST /trips/{id}/start and /end with the odometer (FMS-165)', () => {
  test('typed at both ends: kept on the trip, in the events, recorded as trip readings once, and the vehicle follows', async () => {
    const s = await setup(50_000);
    const started = await command(s.cookie, s.trip, 'start', { odometer_km: 50_012.4 });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({ start_odometer_km: 50_012.4, end_odometer_km: null });
    const [startEvent] = (await publishedEvents('TripStarted')).filter((e) => e.payload.trip_id === s.trip.public_id);
    expect(startEvent.payload).toMatchObject({ start_odometer_km: 50_012.4, start_odometer_typed: true });

    const ended = await command(s.cookie, s.trip, 'end', { odometer_km: 50_140 });
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({ start_odometer_km: 50_012.4, end_odometer_km: 50_140 });

    await deliverEvents();
    await deliverEvents(); // redelivered: nothing twice
    expect(await readings(s.vehicle)).toEqual([
      { value: 50_012.4, source: 'trip', source_ref: `${s.trip.public_id}:start`, suspect: false },
      { value: 50_140, source: 'trip', source_ref: `${s.trip.public_id}:end`, suspect: false },
    ]);
    expect(await odometer(s.vehicle)).toBe(50_140);
  });

  test("none typed: the start keeps the vehicle's reading, and the end records the start plus the GPS distance as an estimate", async () => {
    const s = await setup(50_000);
    const started = await command(s.cookie, s.trip, 'start');
    expect(started.body.data.start_odometer_km).toBe(50_000);
    await droveAnHour(s.vehicle, s.trip);
    const ended = await command(s.cookie, s.trip, 'end');
    expect(ended.body.data).toMatchObject({ actual_distance_source: 'gps', end_odometer_km: null });
    const km = ended.body.data.actual_distance_km as number;
    expect(km).toBeCloseTo((40 * 58) / 60, 1);

    await deliverEvents();
    const expected = Math.floor((50_000 + km) * 10) / 10;
    expect(await readings(s.vehicle)).toEqual([{ value: expected, source: 'gps_derived', source_ref: `${s.trip.public_id}:end`, suspect: false }]);
    expect(await odometer(s.vehicle)).toBe(expected);
  });

  test("a reading below the vehicle's, or below the trip's start, is refused with the floor; nothing changes", async () => {
    const s = await setup(50_000);
    const low = await command(s.cookie, s.trip, 'start', { odometer_km: 49_990 });
    expect(low.status).toBe(409);
    expect(low.body.error).toMatchObject({ code: 'CONFLICT_ODOMETER_REGRESSION', details: [{ field: 'odometer_km', reason: 'below_vehicle_odometer' }] });
    expect(low.body.error.message).toContain('50000');
    expect((await pool.query('SELECT status FROM trip.trips WHERE id = $1', [s.trip.id])).rows[0].status).toBe('assigned');

    expect((await command(s.cookie, s.trip, 'start', { odometer_km: 50_100 })).status).toBe(200);
    const below = await command(s.cookie, s.trip, 'end', { odometer_km: 50_050 });
    expect(below.status).toBe(409);
    expect(below.body.error.details).toEqual([{ field: 'odometer_km', reason: 'below_start_odometer' }]);
    expect((await pool.query('SELECT status FROM trip.trips WHERE id = $1', [s.trip.id])).rows[0].status).toBe('en_route');
  });

  test('anything but an optional non-negative number is a validation error', async () => {
    const s = await setup();
    for (const body of [{ odometer_km: -1 }, { odometer_km: '50000' }, { odometer: 1 }]) {
      const res = await command(s.cookie, s.trip, 'start', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});
