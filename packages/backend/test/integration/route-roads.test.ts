// FMS-84: routes follow the road. The routing engine is a recorded OSRM answer (Bole to Megenagna, Addis Ababa)
// served by a stand-in gateway client, so these tests need no OSRM. Each test uses its own waypoints, so a road
// cached in Redis by another test is never the one asked for.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { provideRoutingClient, tripModule } from '../../src/modules/trip';
import { createDepot, createUser, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Route-Roads-1';
const recorded = JSON.parse(readFileSync(join(__dirname, '../fixtures/osrm/bole-megenagna.json'), 'utf8'));
/** The recorded road: 8,748.2 m and 570.5 s. */
const ROAD = { distance_km: 8.748, estimated_duration_seconds: 571 };

type Depot = Awaited<ReturnType<typeof createDepot>>;

/** The engine as the gateway reaches it: answers with the recorded road, or fails as an unreachable one does. */
const engine = {
  calls: 0,
  down: false,
  connect() {
    provideRoutingClient(() => ({
      call: async <T>() => {
        engine.calls += 1;
        if (engine.down) throw Object.assign(new Error('GET /route/v1/driving/... could not reach the provider.'), { status: undefined });
        return { body: recorded as T };
      },
    }));
  },
};

afterEach(() => {
  provideRoutingClient(null);
  engine.calls = 0;
  engine.down = false;
});

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** Waypoints of this test only (6 decimals, as the columns keep them). */
function ends() {
  const jitter = () => Math.round(Math.random() * 1e4) / 1e6;
  return {
    origin: { latitude: 8.9806 + jitter(), longitude: 38.7578 + jitter() },
    destination: { latitude: 9.0203 + jitter(), longitude: 38.8008 + jitter() },
  };
}

async function newRoute(cookie: string, depot: Depot, extra: Record<string, unknown> = {}) {
  const res = await api.post('/routes', { name: `Bole - Megenagna ${randomUUID().slice(0, 8)}`, depot_id: depot.public_id, ...ends(), ...extra }, cookie);
  expect(res.status).toBe(201);
  return res;
}

const runJob = () => tripModule.jobs!.find((j) => j.name === 'route-roads')!.run({ now: new Date(), correlationId: randomUUID(), runKey: 'test' });

describe('saving a route measures its road (FMS-84)', () => {
  test('both ends and no distance: the road fills distance and time, and its line is at /geometry', async () => {
    engine.connect();
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const res = await newRoute(cookie, depot);

    expect(res.body.data).toMatchObject({ ...ROAD, distance_source: 'road', measured_at: expect.any(String) });
    expect(engine.calls).toBe(1);
    const [event] = await publishedEvents('RouteCreated');
    expect(event.payload).toMatchObject({ route_id: res.body.data.id, distance_km: 8.748 });

    const line = await api.get(`/routes/${res.body.data.id}/geometry`, cookie);
    expect(line.status).toBe(200);
    expect(line.body.data.type).toBe('LineString');
    expect(line.body.data.coordinates.length).toBeGreaterThan(10);
    // Where OSRM joined the road near Bole, to 5 decimals.
    expect(line.body.data.coordinates[0]).toEqual([38.75769, 8.98045]);
  });

  test('a typed distance and time stay, marked manual; the road line is kept beside them', async () => {
    engine.connect();
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const res = await newRoute(cookie, depot, { distance_km: 9.5, estimated_duration_seconds: 900 });
    expect(res.body.data).toMatchObject({ distance_km: 9.5, estimated_duration_seconds: 900, distance_source: 'manual', measured_at: expect.any(String) });
    expect((await api.get(`/routes/${res.body.data.id}/geometry`, cookie)).body.data.type).toBe('LineString');

    // Clearing the typed distance gives the road's.
    const cleared = await api.patch(`/routes/${res.body.data.id}`, { distance_km: null, estimated_duration_seconds: null }, cookie);
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ ...ROAD, distance_source: 'road' });
  });

  test('moving an end measures the road again; a rename does not ask the engine', async () => {
    engine.connect();
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = (await newRoute(cookie, depot)).body.data;
    expect(engine.calls).toBe(1);

    const renamed = await api.patch(`/routes/${route.id}`, { name: `${route.name} (renamed)` }, cookie);
    expect(renamed.status).toBe(200);
    expect(engine.calls).toBe(1);

    const moved = await api.patch(`/routes/${route.id}`, { destination: ends().destination }, cookie);
    expect(moved.status).toBe(200);
    expect(engine.calls).toBe(2);
    expect(moved.body.data).toMatchObject({ ...ROAD, distance_source: 'road' });
    const [event] = (await publishedEvents('RouteUpdated')).filter((e) => e.payload.route_id === route.id).slice(-1);
    expect(event.payload.changed_fields).toEqual(['destination', 'geometry']);
  });

  test('with no routing engine set up, a route saves as before: the typed distance, no road', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const res = await newRoute(cookie, depot, { distance_km: 9.5 });
    expect(res.body.data).toMatchObject({ distance_km: 9.5, distance_source: 'manual', measured_at: null });
    expect((await api.get(`/routes/${res.body.data.id}/geometry`, cookie)).body.data).toBeNull();
  });
});

describe('the routing engine down (FMS-84)', () => {
  test('the route saves with the distance typed in and no road; the route-roads job adds the road later and keeps that distance', async () => {
    engine.connect();
    engine.down = true;
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const typed = (await newRoute(cookie, depot, { distance_km: 9.5 })).body.data;
    const blank = (await newRoute(cookie, depot)).body.data;
    expect(typed).toMatchObject({ distance_km: 9.5, distance_source: 'manual', measured_at: null });
    expect(blank).toMatchObject({ distance_km: null, distance_source: null, measured_at: null });

    // Still down: the job stops at the first failure and changes nothing.
    expect(await runJob()).toMatchObject({ measured: 0, failed: 1 });

    engine.down = false;
    const counts = await runJob();
    expect(counts).toMatchObject({ failed: 0 });
    expect((counts as { measured: number }).measured).toBeGreaterThanOrEqual(2);
    expect((await api.get(`/routes/${typed.id}`, cookie)).body.data).toMatchObject({ distance_km: 9.5, distance_source: 'manual', measured_at: expect.any(String) });
    expect((await api.get(`/routes/${blank.id}`, cookie)).body.data).toMatchObject({ ...ROAD, distance_source: 'road', measured_at: expect.any(String) });
    expect((await api.get(`/routes/${blank.id}/geometry`, cookie)).body.data.type).toBe('LineString');
    expect(await runJob()).toMatchObject({ measured: 0 });
  });
});

describe('GET /routes/{id}/geometry (FMS-84)', () => {
  test("route:read in the route's depot; another depot's route or an unknown id is 404; a technician is 403", async () => {
    engine.connect();
    const depot = await createDepot();
    const other = await createDepot();
    const route = (await newRoute(await signIn(['fleet_manager']), depot)).body.data;

    expect((await api.get(`/routes/${route.id}/geometry`, await signIn(['dispatcher'], depot))).status).toBe(200);
    expect((await api.get(`/routes/${route.id}/geometry`, await signIn(['dispatcher'], other))).status).toBe(404);
    const admin = await signIn(['admin']);
    expect((await api.get(`/routes/${randomUUID()}/geometry`, admin)).status).toBe(404);
    expect((await api.get('/routes/not-a-uuid/geometry', admin)).status).toBe(404);
    expect((await api.get(`/routes/${route.id}/geometry`, await signIn(['technician'], depot))).status).toBe(403);
  });
});
