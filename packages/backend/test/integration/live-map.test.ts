import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-45: GET /tracking/vehicles/current, the live map's snapshot.

const app = createApp();
const PASSWORD = 'Live-Map-Test-1';
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

/** Pings posted as an admin (tracking:ingest), as a device would send them. */
async function report(admin: string, vehicle: Row, pings: { at: number; speed: number; lat?: number; lng?: number }[]) {
  const res = await request(app)
    .post('/api/v1/tracking/gps-pings')
    .set('Cookie', admin)
    .send({
      pings: pings.map((p) => ({ vehicle_id: vehicle.public_id, recorded_at: ago(p.at), lat: p.lat ?? 9.0108, lng: p.lng ?? 38.7613, speed_kmh: p.speed, heading: 45, accuracy_m: 5, ignition_on: true })),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
}

const current = (cookie: string, query = '') => request(app).get(`/api/v1/tracking/vehicles/current${query}`).set('Cookie', cookie);
const byId = (body: { data: { vehicle_id: string }[] }) => new Map(body.data.map((v) => [v.vehicle_id, v]));

describe('GET /tracking/vehicles/current', () => {
  test("a dispatcher sees their depot's vehicles that report or are on a trip, with position, trip, driver and flags", async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const admin = await signIn(['admin']);
    const dispatcher = await signIn(['dispatcher'], depot);

    const moving = await createVehicle({ depot, registration_number: 'AA 3-10001' });
    const onTripSilent = await createVehicle({ depot, registration_number: 'AA 3-10002' });
    const parked = await createVehicle({ depot, registration_number: 'AA 3-10003' });
    const retired = await createVehicle({ depot, status: 'retired' });
    const elsewhere = await createVehicle({ depot: other });

    const { driver } = await createDriver({ depot });
    await pool.query("UPDATE fleet.driver_accounts SET full_name = 'Abebe Kebede' WHERE user_id = $1", [driver.user_id]);
    const route = (
      await pool.query("INSERT INTO trip.routes (name, depot_id) VALUES ('Bole - Adama', $1) RETURNING id", [depot.id])
    ).rows[0] as { id: string };
    const trip = await createTrip({ vehicle: moving, driver, status: 'en_route', actual_start: ago(30 * MIN), route_id: route.id, origin: 'Bole', destination: 'Adama' });
    const { driver: second } = await createDriver({ depot });
    await createTrip({ vehicle: onTripSilent, driver: second, status: 'en_route', actual_start: ago(5 * MIN) });

    await report(admin, moving, [{ at: 20_000, speed: 40 }, { at: 0, speed: 87, lat: 9.02, lng: 38.77 }]);
    await report(admin, retired, [{ at: 0, speed: 10 }]);
    await report(admin, elsewhere, [{ at: 0, speed: 10 }]);
    await pool.query(
      `INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, severity, observed_at) VALUES ($1, 'speeding', 'high', now() - interval '20 seconds')`,
      [moving.id],
    );
    // A resolved flag is history, not a state.
    await pool.query(
      `INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, observed_at, resolved_at) VALUES ($1, 'idling', now() - interval '1 hour', now() - interval '50 minutes')`,
      [moving.id],
    );

    const res = await current(dispatcher);
    expect(res.status).toBe(200);
    const vehicles = byId(res.body);
    // Not the parked vehicle (no position, no trip), the retired one, or another depot's.
    expect([...vehicles.keys()].sort()).toEqual([moving.public_id, onTripSilent.public_id].sort());
    expect(vehicles.has(parked.public_id as string)).toBe(false);

    expect(vehicles.get(moving.public_id as string)).toEqual({
      vehicle_id: moving.public_id,
      registration_number: 'AA 3-10001',
      vehicle_type: 'truck',
      vehicle_status: 'active',
      maintenance_flag: false,
      depot_id: depot.public_id,
      position: {
        lat: 9.02,
        lng: 38.77,
        speed_kmh: 87,
        heading: 45,
        accuracy_m: 5,
        ignition_on: true,
        recorded_at: expect.any(String),
        stopped_since: null,
      },
      trip: {
        trip_id: trip.public_id,
        route_name: 'Bole - Adama',
        origin: 'Bole',
        destination: 'Adama',
        started_at: expect.any(String),
        scheduled_end: expect.any(String),
        driver: { driver_id: driver.public_id, full_name: 'Abebe Kebede' },
      },
      flags: [{ flag_type: 'speeding', severity: 'high', observed_at: expect.any(String) }],
    });
    // On a trip but not reporting yet: listed, with no position.
    expect(vehicles.get(onTripSilent.public_id as string)).toMatchObject({ position: null, trip: { driver: { driver_id: second.public_id } }, flags: [] });
  });

  test('a stopped vehicle says since when: the first of its 0 km/h pings after it last moved', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const vehicle = await createVehicle({ depot });
    await report(admin, vehicle, [
      { at: 12 * MIN, speed: 35 },
      { at: 9 * MIN, speed: 0 },
      { at: 4 * MIN, speed: 0 },
      { at: 0, speed: 0 },
    ]);
    const [row] = (await current(await signIn(['fleet_manager']), `?depot_id=${depot.public_id}`)).body.data;
    const stopped = Date.parse(row.position.stopped_since);
    expect(Math.abs(stopped - (Date.now() - 9 * MIN))).toBeLessThan(5_000);
  });

  test('scope: a fleet manager sees every depot or one; a dispatcher naming another depot gets nothing', async () => {
    const a = await createDepot();
    const b = await createDepot();
    const admin = await signIn(['admin']);
    const inA = await createVehicle({ depot: a });
    const inB = await createVehicle({ depot: b });
    await report(admin, inA, [{ at: 0, speed: 20 }]);
    await report(admin, inB, [{ at: 0, speed: 20 }]);

    const manager = await signIn(['fleet_manager']);
    const all = byId((await current(manager)).body);
    expect(all.has(inA.public_id as string) && all.has(inB.public_id as string)).toBe(true);
    expect([...byId((await current(manager, `?depot_id=${b.public_id}`)).body).keys()]).toEqual([inB.public_id]);

    const dispatcherA = await signIn(['dispatcher'], a);
    expect((await current(dispatcherA, `?depot_id=${b.public_id}`)).body.data).toEqual([]);
    expect([...byId((await current(dispatcherA)).body).keys()]).toEqual([inA.public_id]);
  });

  test('tracking:read is required; the query is checked', async () => {
    const depot = await createDepot();
    expect((await current(await signIn(['driver'], depot))).status).toBe(403);
    expect((await current(await signIn(['technician'], depot))).status).toBe(403);
    expect((await request(app).get('/api/v1/tracking/vehicles/current')).status).toBe(401);

    const bad = await current(await signIn(['fleet_manager']), '?depot_id=nope&page=2');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
});
