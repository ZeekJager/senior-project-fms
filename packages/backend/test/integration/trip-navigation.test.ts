// FMS-166 (docs/driver-navigation.md): the driver's navigation of a trip under way. The routing engine is a stand-in
// gateway client answering a real OSRM v5.27.1 route with its steps (Bole to Megenagna, Addis Ababa).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { provideRoutingClient } from '../../src/modules/trip';
import { createDepot, createDriver, createVehicle } from '../support/factories';

const app = createApp();
const PASSWORD = 'Device-Test-1';
type Row = Record<string, unknown> & { id: string; public_id: string };

const recorded = JSON.parse(readFileSync(join(__dirname, '../fixtures/osrm/bole-megenagna-steps.json'), 'utf8'));
const BOLE = { lat: 8.9806, lng: 38.7578 };
const MEGENAGNA = { lat: 9.0203, lng: 38.8008 };

const engine = {
  calls: [] as { path: string; query?: Record<string, string> }[],
  down: false,
  connect() {
    provideRoutingClient(() => ({
      call: async <T>(req: { method: 'GET'; path: string; query?: Record<string, string> }) => {
        engine.calls.push(req);
        if (engine.down) throw Object.assign(new Error(`GET ${req.path} could not reach the provider.`), { status: undefined });
        return { body: recorded as T };
      },
    }));
  },
};

afterEach(() => {
  provideRoutingClient(null);
  engine.calls = [];
  engine.down = false;
});

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function driverWithLogin(depot: Row) {
  const { user, driver } = await createDriver({ depot, license_categories: ['dry_cargo_2'] });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { driver: driver as Row, cookie: await login(user.email) };
}

/** A trip under way to Megenagna with a completed stop and one still ahead, driven by a driver who can sign in. */
async function setup() {
  const depot = (await createDepot()) as Row;
  const vehicle = (await createVehicle({ depot })) as Row;
  const me = await driverWithLogin(depot);
  const route = (
    await pool.query<Row>(
      `INSERT INTO trip.routes (name, depot_id, origin_name, origin_latitude, origin_longitude, destination_name, destination_latitude, destination_longitude)
       VALUES ('Bole – Megenagna ' || gen_random_uuid(), $1, 'Bole', $2, $3, 'Megenagna depot', $4, $5) RETURNING id`,
      [depot.id, BOLE.lat, BOLE.lng, MEGENAGNA.lat, MEGENAGNA.lng],
    )
  ).rows[0];
  const now = Date.now();
  const trip = (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, origin, destination, scheduled_start, scheduled_end, actual_start)
       VALUES ($1, $2, $3, 'en_route', 'Bole', 'Megenagna depot', $4, $5, $4) RETURNING *`,
      [route.id, vehicle.id, me.driver.id, new Date(now - 3600_000), new Date(now + 3600_000)],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO trip.trip_stops (trip_id, sequence_number, name, stop_type, latitude, longitude, status, actual_arrival, completed_at) VALUES
       ($1, 1, 'Edna Mall', 'delivery', 8.9965, 38.7867, 'completed', now() - interval '20 minutes', now() - interval '15 minutes'),
       ($1, 2, 'Urael Church', 'delivery', 9.0105, 38.7792, 'planned', NULL, NULL)`,
    [trip.id],
  );
  return { depot, vehicle, trip, me };
}

const navigate = (cookie: string, trip: Row, from: string | null = `${BOLE.lat},${BOLE.lng}`) =>
  request(app).get(`/api/v1/trips/${trip.public_id}/navigation${from ? `?from=${from}` : ''}`).set('Cookie', cookie);

describe('GET /trips/{id}/navigation (FMS-166)', () => {
  test('the road from the phone through the stop left to the destination, with every turn in words', async () => {
    engine.connect();
    const s = await setup();
    const res = await navigate(s.me.cookie, s.trip);
    expect(res.status).toBe(200);
    const nav = res.body.data;
    expect(nav).toMatchObject({ trip_id: s.trip.public_id, status: 'en_route', origin: { lat: BOLE.lat, lng: BOLE.lng, source: 'phone' }, no_road: null });
    expect(nav.waypoints.map((w: { kind: string; name: string }) => [w.kind, w.name])).toEqual([
      ['stop', 'Urael Church'],
      ['destination', 'Megenagna depot'],
    ]);
    expect(nav.destination).toMatchObject({ kind: 'destination', name: 'Megenagna depot', lat: MEGENAGNA.lat, lng: MEGENAGNA.lng });

    // Asked with every turn, from the phone through the stop left (the completed one is not on the road) to the destination.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].path).toBe('/route/v1/driving/38.757800,8.980600;38.779200,9.010500;38.800800,9.020300');
    expect(engine.calls[0].query).toMatchObject({ steps: 'true', overview: 'full', geometries: 'geojson' });

    expect(nav.road).toMatchObject({ distance_km: 8.748, duration_seconds: 571, geometry: { type: 'LineString' } });
    expect(new Date(nav.road.arrival_at).getTime()).toBeGreaterThan(Date.now() + 560_000);
    const words = nav.road.steps.map((st: { instruction: string }) => st.instruction);
    expect(words.slice(0, 4)).toEqual(['Head off', 'Turn right', 'Turn right onto Dej Beyene Merid Street', 'Continue on Ethio-Chinese Friendship Road']);
    expect(words).toContain('At the roundabout, take the 3rd exit onto Gabon Avenue');
    expect(words.at(-1)).toBe('Arrive at Urael Church');
    expect(nav.straight_line).toMatchObject({ bearing_deg: expect.any(Number) });
    expect(nav.straight_line.distance_km).toBeGreaterThan(3);
  });

  test('without the routing engine, or with it down, the destination and the straight line still come back', async () => {
    const s = await setup();
    const off = (await navigate(s.me.cookie, s.trip)).body.data;
    expect(off).toMatchObject({ road: null, no_road: 'routing_not_configured', destination: { name: 'Megenagna depot' } });
    expect(off.straight_line.bearing_deg).toBeGreaterThan(0);

    engine.connect();
    engine.down = true;
    expect((await navigate(s.me.cookie, s.trip)).body.data).toMatchObject({ road: null, no_road: 'routing_unavailable' });
  });

  test('with no position sent and none stored, no road and no straight line; the waypoints are still listed', async () => {
    engine.connect();
    const s = await setup();
    const res = await navigate(s.me.cookie, s.trip, null);
    expect(res.body.data).toMatchObject({ origin: null, road: null, no_road: 'no_origin', straight_line: null });
    expect(res.body.data.waypoints).toHaveLength(2);
    expect(engine.calls).toHaveLength(0);
  });

  test("another driver's trip is 404; a position that is not lat,lng is 400", async () => {
    const s = await setup();
    const other = await driverWithLogin(s.depot);
    expect((await navigate(other.cookie, s.trip)).status).toBe(404);
    for (const bad of ['9.0', 'north', '91,38.7', '9.0,181']) {
      const res = await navigate(s.me.cookie, s.trip, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});
