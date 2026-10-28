import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-136: a vehicle's GPS history, for the vehicle page's trip map. Pings are stored here directly; how they
// arrive is the ingestion's test (gps-ingestion.test.ts).

const app = createApp();
const PASSWORD = 'Tracking-Test-1';
const MIN = 60_000;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** `count` pings a minute apart from `start`, moving north-east; the trip when given. */
async function track(vehicle: Row, start: Date, count: number, trip: Row | null = null): Promise<string[]> {
  const times = Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * MIN).toISOString());
  await pool.query(
    `INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh, heading_degrees, source, recorded_at)
     SELECT $1, $2, 9 + i * 0.01, 38.7 + i * 0.01, 60, 45, 'phone', t FROM unnest($3::timestamptz[]) WITH ORDINALITY AS u(t, i)`,
    [vehicle.id, trip?.id ?? null, times],
  );
  return times;
}

const START = new Date('2026-10-20T06:00:00Z');

describe('GET /vehicles/{vehicle_id}/tracking', () => {
  test('the points oldest first, with the trip named, a page at a time to the last', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const trip = await createTrip({ vehicle, driver, status: 'completed' });
    const times = await track(vehicle, START, 5, trip);
    const manager = await signIn(['fleet_manager']);

    const first = await get(`/vehicles/${String(vehicle.public_id)}/tracking?limit=3`, manager);
    expect(first.status).toBe(200);
    expect(first.body.data.map((p: { recorded_at: string }) => p.recorded_at)).toEqual(times.slice(0, 3));
    expect(first.body.data[0]).toEqual({
      recorded_at: times[0],
      lat: 9.01,
      lng: 38.71,
      speed_kmh: 60,
      heading: 45,
      altitude_m: null,
      accuracy_m: null,
      ignition_on: null,
      odometer_km: null,
      source: 'phone',
      trip_id: trip.public_id,
    });
    expect(first.body.meta.next_cursor).toEqual(expect.any(String));

    const second = await get(`/vehicles/${String(vehicle.public_id)}/tracking?limit=3&cursor=${first.body.meta.next_cursor as string}`, manager);
    expect(second.body.data.map((p: { recorded_at: string }) => p.recorded_at)).toEqual(times.slice(3));
    expect(second.body.meta.next_cursor).toBeNull();
  });

  test('from and to bound recorded_at, both ends included: one trip\'s track', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const times = await track(vehicle, START, 10);
    const dispatcher = await signIn(['dispatcher'], depot);

    const res = await get(`/vehicles/${String(vehicle.public_id)}/tracking?from=${times[2]}&to=${times[5]}`, dispatcher);
    expect(res.body.data.map((p: { recorded_at: string }) => p.recorded_at)).toEqual(times.slice(2, 6));
    expect(res.body.meta.next_cursor).toBeNull();
  });

  test("another depot's vehicle or a bad id is not found; a technician may not read it; a bad cursor or range is refused", async () => {
    const [depot, other] = [await createDepot(), await createDepot()];
    const [mine, theirs] = [await createVehicle({ depot }), await createVehicle({ depot: other })];
    await track(theirs, START, 2);
    const dispatcher = await signIn(['dispatcher'], depot);

    expect((await get(`/vehicles/${String(theirs.public_id)}/tracking`, dispatcher)).status).toBe(404);
    expect((await get('/vehicles/not-a-uuid/tracking', dispatcher)).status).toBe(404);
    expect((await get(`/vehicles/${String(mine.public_id)}/tracking`, await signIn(['technician'], depot))).status).toBe(403);

    const badCursor = await get(`/vehicles/${String(mine.public_id)}/tracking?cursor=bm9wZQ`, dispatcher);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.details).toEqual([{ field: 'cursor', reason: 'invalid_cursor' }]);
    const backwards = await get(`/vehicles/${String(mine.public_id)}/tracking?from=2026-10-20T08:00:00Z&to=2026-10-20T07:00:00Z`, dispatcher);
    expect(backwards.status).toBe(400);
    expect((await get(`/vehicles/${String(mine.public_id)}/tracking?limit=1001`, dispatcher)).status).toBe(400);
  });

  test('a vehicle with no pings has an empty history', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    const res = await get(`/vehicles/${String(vehicle.public_id)}/tracking`, await signIn(['admin']));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], meta: { page_size: 500, next_cursor: null } });
  });
});
