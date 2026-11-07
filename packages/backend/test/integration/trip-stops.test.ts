// FMS-95: a trip's stops marked done, its live state, and the GPS history's 30-day limit and audit. Pings are stored
// here directly (the current position follows from its trigger); how they arrive is gps-ingestion.test.ts.
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';
import { responseProblems, type Method } from '../support/openapi';

const app = createApp();
const PASSWORD = 'Stops-Test-1';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
type Row = Record<string, unknown> & { id: string };

function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const signIn = async (roles: RoleName[], depot: Row | null = null) => login((await createUser({ roles, depot, password: PASSWORD })).email);

async function driverWithLogin(depot: Row) {
  const { user, driver } = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { user, driver, cookie: await login(user.email) };
}

/** A depot trip with three stops (the first already seen by GPS), in the given state; under way by default. */
async function tripWithStops(status = 'en_route') {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot });
  const driver = await driverWithLogin(depot);
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Stops ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
  const started = new Date(Date.now() - 30 * MIN);
  const trip = (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [route.id, vehicle.id, driver.driver.id, status, started, new Date(started.getTime() + 3 * 60 * MIN), status === 'en_route' ? started : null],
    )
  ).rows[0];
  const seen = new Date(Date.now() - 10 * MIN);
  const stops: Row[] = [];
  for (const [i, name] of ['Merkato', 'Piassa', 'Bole'].entries()) {
    const reached = i === 0;
    stops.push(
      (
        await pool.query<Row>(
          `INSERT INTO trip.trip_stops (trip_id, sequence_number, name, latitude, longitude, status, actual_arrival)
           VALUES ($1, $2, $3, $4, 38.75, $5, $6) RETURNING *`,
          [trip.id, i + 1, name, 9 + i * 0.01, reached ? 'arrived' : 'planned', reached ? seen : null],
        )
      ).rows[0],
    );
  }
  return { depot, vehicle, driver, trip, stops, seen };
}

const complete = (cookie: string, trip: Row, stop: Row | { public_id: string }, body: object = {}) =>
  request(app).post(`/api/v1/trips/${String(trip.public_id)}/stops/${String(stop.public_id)}/complete`).set('Cookie', cookie).send(body);
const live = (cookie: string, trip: Row) => request(app).get(`/api/v1/trips/${String(trip.public_id)}/live`).set('Cookie', cookie);
const COMPLETE = '/trips/{trip_id}/stops/{stop_id}/complete';
const LIVE = '/trips/{trip_id}/live';

async function ping(vehicle: Row, at: Date, trip: Row | null = null) {
  await pool.query(
    `INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh, heading_degrees, source, recorded_at)
     VALUES ($1, $2, 9.015, 38.75, 42, 90, 'phone', $3)`,
    [vehicle.id, trip?.id ?? null, at],
  );
}

describe('POST /trips/{trip_id}/stops/{stop_id}/complete', () => {
  test('the driver marks a stop done: completed, timed, audited, published; again is unchanged', async () => {
    const { trip, stops, driver, seen } = await tripWithStops();

    const res = await complete(driver.cookie, trip, stops[1], { notes: 'Left with the guard' });
    expectContract(res, 'post', COMPLETE);
    expect(res.status).toBe(200);
    expect(res.body.meta.changed).toBe(true);
    expect(res.body.data).toMatchObject({ id: stops[1].public_id, name: 'Piassa', status: 'completed', eta: null, completed_at: expect.any(String) });
    // GPS never saw it there: marking it done is its arrival, so the estimate counts it passed.
    expect(res.body.data.actual_arrival).toBe(res.body.data.completed_at);

    const row = (await pool.query('SELECT status, notes, completed_by, completed_at FROM trip.trip_stops WHERE id = $1', [stops[1].id])).rows[0];
    expect(row).toMatchObject({ status: 'completed', notes: 'Left with the guard', completed_by: driver.user.id });

    const audited = (await pool.query("SELECT action, user_id FROM audit.audit_logs WHERE entity_type = 'trip.trip_stops' AND entity_id = $1", [stops[1].id])).rows;
    expect(audited).toEqual([{ action: 'UPDATE', user_id: driver.user.id }]);

    const [event] = (await publishedEvents('TripStopCompleted')).filter((e) => e.payload.trip_id === trip.public_id);
    expect(event.payload).toMatchObject({ stop_id: stops[1].public_id, sequence_number: 2, name: 'Piassa', reached_by_gps: false, completed_at: res.body.data.completed_at });

    // A stop GPS reached keeps the time it was reached.
    const first = await complete(driver.cookie, trip, stops[0]);
    expect(first.body.data.actual_arrival).toBe(seen.toISOString());
    expect((await publishedEvents('TripStopCompleted')).filter((e) => e.payload.trip_id === trip.public_id).at(-1)!.payload.reached_by_gps).toBe(true);

    const again = await complete(driver.cookie, trip, stops[1]);
    expectContract(again, 'post', COMPLETE);
    expect(again.body.meta.changed).toBe(false);
    expect((await publishedEvents('TripStopCompleted')).filter((e) => e.payload.trip_id === trip.public_id)).toHaveLength(2);
  });

  test('dispatch of the depot may too; another driver, another depot or an unknown stop is not found', async () => {
    const { depot, trip, stops } = await tripWithStops();
    const other = await tripWithStops();

    expect((await complete(await signIn(['dispatcher'], depot), trip, stops[2])).status).toBe(200);
    const notFound = [
      await complete(other.driver.cookie, trip, stops[0]),
      await complete(await signIn(['dispatcher'], other.depot), trip, stops[0]),
      await complete(other.driver.cookie, other.trip, stops[0]),
      await complete(other.driver.cookie, other.trip, { public_id: 'not-a-uuid' }),
    ];
    for (const res of notFound) {
      expectContract(res, 'post', COMPLETE);
      expect(res.status).toBe(404);
    }
    expect((await complete(await signIn(['technician'], depot), trip, stops[0])).status).toBe(403);
  });

  test('a trip not under way is 409; a note too long or an unknown field is 400', async () => {
    const { trip, stops, driver } = await tripWithStops('assigned');
    const res = await complete(driver.cookie, trip, stops[1]);
    expectContract(res, 'post', COMPLETE);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION' });

    const under = await tripWithStops();
    expect((await complete(under.driver.cookie, under.trip, under.stops[1], { notes: 'x'.repeat(501) })).status).toBe(400);
    expect((await complete(under.driver.cookie, under.trip, under.stops[1], { status: 'skipped' })).status).toBe(400);
  });
});

describe('GET /trips/{trip_id}/live', () => {
  test('under way: the newest position, the next stop, the counts; stale after two minutes', async () => {
    const { trip, stops, vehicle, driver, depot } = await tripWithStops();
    await ping(vehicle, new Date(Date.now() - 20 * 1000), trip);
    await complete(driver.cookie, trip, stops[0]);

    const res = await live(await signIn(['dispatcher'], depot), trip);
    expectContract(res, 'get', LIVE);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      trip_id: trip.public_id,
      status: 'en_route',
      position: { lat: 9.015, lng: 38.75, speed_kmh: 42, heading: 90, stale: false },
      next_stop: { stop_id: stops[1].public_id, sequence_number: 2, name: 'Piassa' },
      stops: { total: 3, reached: 1, completed: 1 },
    });

    await pool.query('UPDATE tracking.vehicle_current_location SET recorded_at = $2 WHERE vehicle_id = $1', [vehicle.id, new Date(Date.now() - 3 * MIN)]);
    const stale = await live(driver.cookie, trip);
    expectContract(stale, 'get', LIVE);
    expect(stale.body.data.position.stale).toBe(true);
  });

  test('not under way there is no position; another driver is not found', async () => {
    const { trip, vehicle, driver } = await tripWithStops('assigned');
    await ping(vehicle, new Date());
    const res = await live(driver.cookie, trip);
    expectContract(res, 'get', LIVE);
    expect(res.body.data).toMatchObject({ status: 'assigned', position: null, stops: { total: 3, reached: 1, completed: 0 } });

    const other = await tripWithStops();
    const notFound = await live(other.driver.cookie, trip);
    expectContract(notFound, 'get', LIVE);
    expect(notFound.status).toBe(404);
  });
});

describe('GET /vehicles/{vehicle_id}/tracking: at most 30 days, audited (FMS-95)', () => {
  const TRACK = '/vehicles/{vehicle_id}/tracking';
  const track = (cookie: string, vehicle: Row, query: string) => request(app).get(`/api/v1/vehicles/${String(vehicle.public_id)}/tracking?${query}`).set('Cookie', cookie);

  test('31 days is refused; 30 days is read, a page at a time, and each page audited', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const from = new Date(Date.now() - 31 * DAY);
    for (let i = 0; i < 5; i++) await ping(vehicle, new Date(from.getTime() + DAY + i * MIN));
    const manager = await signIn(['fleet_manager']);

    const tooLong = await track(manager, vehicle, `from=${from.toISOString()}&to=${new Date(from.getTime() + 31 * DAY).toISOString()}`);
    expectContract(tooLong, 'get', TRACK);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatchObject({ code: 'VALIDATION_INVALID_DATE_RANGE', details: [{ field: 'to', reason: 'range_too_long' }] });

    const range = `from=${from.toISOString()}&to=${new Date(from.getTime() + 30 * DAY).toISOString()}`;
    const first = await track(manager, vehicle, `${range}&limit=3`);
    expectContract(first, 'get', TRACK);
    expect(first.body.data).toHaveLength(3);
    const second = await track(manager, vehicle, `${range}&limit=3&cursor=${first.body.meta.next_cursor as string}`);
    expect(second.body.data).toHaveLength(2);
    expect(second.body.meta.next_cursor).toBeNull();

    const audited = (
      await pool.query("SELECT details FROM audit.audit_logs WHERE action = 'tracking.history_read' AND entity_type = 'fleet.vehicles' AND entity_id = $1 ORDER BY id", [vehicle.id])
    ).rows.map((r) => r.details);
    expect(audited).toEqual([
      expect.objectContaining({ vehicle_id: vehicle.public_id, from: from.toISOString(), points: 3, continued: false }),
      expect.objectContaining({ points: 2, continued: true }),
    ]);
  });

  test('without from, the last 30 days: an older point is left out; from alone ends 30 days later', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle, new Date(Date.now() - 40 * DAY));
    await ping(vehicle, new Date(Date.now() - 2 * DAY));
    const admin = await signIn(['admin']);

    expect((await track(admin, vehicle, '')).body.data).toHaveLength(1);
    const fromOld = await track(admin, vehicle, `from=${new Date(Date.now() - 41 * DAY).toISOString()}`);
    expect(fromOld.status).toBe(200);
    expect(fromOld.body.data).toHaveLength(1);
  });
});
