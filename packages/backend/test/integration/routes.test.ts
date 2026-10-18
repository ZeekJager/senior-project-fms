import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Routes-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string, ifMatch?: string) => {
    const req = request(app).patch(`/api/v1${path}`).set('Cookie', cookie);
    return (ifMatch ? req.set('If-Match', ifMatch) : req).send(body);
  },
};

const ADDIS = { latitude: 9.005401, longitude: 38.763611 };
const ADAMA = { latitude: 8.54, longitude: 39.27 };

async function newRoute(cookie: string, depot: Depot, extra: Record<string, unknown> = {}) {
  const res = await api.post('/routes', { name: `Addis Ababa - Adama ${Math.random().toString(36).slice(2, 7)}`, depot_id: depot.public_id, ...extra }, cookie);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string; version: number; is_active: boolean };
}

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

describe('POST /routes', () => {
  test('creates a route with origin, destination, stops and a manual distance; audited, with an ETag and RouteCreated', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const res = await api.post(
      '/routes',
      {
        name: '  Addis Ababa - Adama  ',
        depot_id: depot.public_id,
        origin_name: 'Addis Ababa depot',
        origin: ADDIS,
        destination_name: 'Adama',
        destination: ADAMA,
        stops: [{ name: 'Bishoftu', latitude: 8.75, longitude: 38.98 }, { name: 'Mojo' }],
        distance_km: 99.5,
        estimated_duration_seconds: 7200,
      },
      cookie,
    );
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(res.headers.location).toBe(`/api/v1/routes/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      name: 'Addis Ababa - Adama',
      depot_id: depot.public_id,
      origin_name: 'Addis Ababa depot',
      origin: ADDIS,
      destination_name: 'Adama',
      destination: ADAMA,
      stops: [
        { name: 'Bishoftu', latitude: 8.75, longitude: 38.98 },
        { name: 'Mojo', latitude: null, longitude: null },
      ],
      distance_km: 99.5,
      estimated_duration_seconds: 7200,
      is_active: true,
      version: 0,
    });
    expect(await auditRows(res)).toEqual(['INSERT trip.routes']);
    const [event] = await publishedEvents('RouteCreated');
    expect(event.payload).toEqual({ route_id: res.body.data.id, depot_id: depot.public_id, name: 'Addis Ababa - Adama', distance_km: 99.5 });
    expect(event.aggregate).toBe(`route:${res.body.data.id}`);
  });

  test('a route without a depot returns 400 and saves nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    for (const body of [{ name: 'No depot' }, { name: 'Null depot', depot_id: null }]) {
      const res = await api.post('/routes', body, cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'depot_id' })]);
    }
    const missing = await api.post('/routes', { name: 'Unknown depot', depot_id: '00000000-0000-4000-8000-000000000000' }, cookie);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
    expect((await api.get(`/routes?depot_id=${depot.public_id}`, cookie)).body.meta.total_items).toBe(0);
    expect(await publishedEvents('RouteCreated')).toEqual([]);
  });

  test("a depot-scoped dispatcher cannot create a route in another depot", async () => {
    const own = await createDepot();
    const other = await createDepot();
    const cookie = await signIn(['dispatcher'], own);
    const res = await api.post('/routes', { name: 'Elsewhere', depot_id: other.public_id }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
  });

  test('coordinates are validated: range, both parts of a stop, and the stored precision', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const bad = async (extra: Record<string, unknown>) => {
      const res = await api.post('/routes', { name: 'Bad', depot_id: depot.public_id, ...extra }, cookie);
      expect(res.status).toBe(400);
      return res.body.error.details as { field: string; reason: string }[];
    };
    expect(await bad({ origin: { latitude: 91, longitude: 38 } })).toEqual([expect.objectContaining({ field: 'origin.latitude' })]);
    expect(await bad({ destination: { latitude: 9, longitude: -181 } })).toEqual([expect.objectContaining({ field: 'destination.longitude' })]);
    expect(await bad({ origin: { latitude: 9 } })).toEqual([expect.objectContaining({ field: 'origin.longitude' })]);
    expect(await bad({ stops: [{ name: 'Mojo', latitude: 8.6 }] })).toEqual([{ field: 'stops.0', reason: 'incomplete_coordinates' }]);
    expect(await bad({ origin: { latitude: 9.1234567, longitude: 38 } })).toEqual([{ field: 'origin.latitude', reason: 'too_many_decimals' }]);
    expect(await bad({ distance_km: 12.3456 })).toEqual([{ field: 'distance_km', reason: 'too_many_decimals' }]);
    expect(await bad({ distance_km: -1 })).toEqual([expect.objectContaining({ field: 'distance_km' })]);
    expect(await bad({ stops: Array.from({ length: 26 }, (_, i) => ({ name: `Stop ${i}` })) })).toEqual([expect.objectContaining({ field: 'stops' })]);
  });

  test('active route names are unique within a depot, case-insensitively; another depot may reuse one', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    await newRoute(cookie, depot, { name: 'Addis Ababa - Hawassa' });
    const dup = await api.post('/routes', { name: 'ADDIS ABABA - HAWASSA', depot_id: depot.public_id }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: [{ field: 'name', reason: 'already_exists' }] });
    await newRoute(cookie, await createDepot(), { name: 'Addis Ababa - Hawassa' });
  });
});

describe('depot scope', () => {
  test('a depot A dispatcher cannot see depot B routes: not listed, not readable, not writable', async () => {
    const depotA = await createDepot();
    const depotB = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const routeA = await newRoute(manager, depotA, { name: 'A route' });
    const routeB = await newRoute(manager, depotB, { name: 'B route' });

    const dispatcherA = await signIn(['dispatcher'], depotA);
    const list = await api.get('/routes?page_size=100', dispatcherA);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(routeA.id);
    expect(ids).not.toContain(routeB.id);
    expect(list.body.data.every((r: { depot_id: string }) => r.depot_id === depotA.public_id)).toBe(true);

    expect((await api.get(`/routes?depot_id=${depotB.public_id}`, dispatcherA)).body).toMatchObject({ data: [], meta: { total_items: 0 } });
    expect((await api.get(`/routes/${routeB.id}`, dispatcherA)).status).toBe(404);
    expect((await api.patch(`/routes/${routeB.id}`, { name: 'Taken over' }, dispatcherA)).status).toBe(404);
    expect((await api.get(`/routes/${routeA.id}`, dispatcherA)).status).toBe(200);

    // A fleet-wide role sees both.
    const all = (await api.get('/routes?page_size=100', manager)).body.data.map((r: { id: string }) => r.id);
    expect(all).toEqual(expect.arrayContaining([routeA.id, routeB.id]));
  });

  test('route:read is needed to read and route:write to write', async () => {
    const depot = await createDepot();
    const route = await newRoute(await signIn(['fleet_manager']), depot);
    const driver = await signIn(['driver'], depot);
    expect((await api.get(`/routes/${route.id}`, driver)).status).toBe(200);
    expect((await api.post('/routes', { name: 'X', depot_id: depot.public_id }, driver)).status).toBe(403);
    expect((await api.patch(`/routes/${route.id}`, { name: 'X' }, driver)).status).toBe(403);
    expect((await api.get('/routes', await signIn(['finance_clerk'], depot))).status).toBe(403);
    expect((await request(app).get('/api/v1/routes')).status).toBe(401);
  });
});

describe('PATCH /routes/{id}', () => {
  test('updates the fields sent, bumps the version and publishes RouteUpdated with what changed', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await newRoute(cookie, depot, { origin: ADDIS, distance_km: 90 });

    const res = await api.patch(`/routes/${route.id}`, { distance_km: 99.5, destination: ADAMA, stops: [{ name: 'Mojo' }] }, cookie, '"0"');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.data).toMatchObject({ distance_km: 99.5, destination: ADAMA, origin: ADDIS, stops: [{ name: 'Mojo', latitude: null, longitude: null }], version: 1 });
    expect(await auditRows(res)).toEqual(['UPDATE trip.routes']);
    const [event] = await publishedEvents('RouteUpdated');
    expect(event.payload).toEqual({ route_id: route.id, depot_id: depot.public_id, changed_fields: ['destination', 'distance_km', 'stops'], is_active: true });

    // Clearing a point.
    const cleared = await api.patch(`/routes/${route.id}`, { origin: null }, cookie);
    expect(cleared.body.data.origin).toBeNull();
  });

  test('a PATCH that changes nothing writes and publishes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await newRoute(cookie, depot, { origin: ADDIS, distance_km: 90, stops: [{ name: 'Bishoftu', latitude: 8.75, longitude: 38.98 }] });
    const res = await api.patch(`/routes/${route.id}`, { origin: ADDIS, distance_km: 90, name: route.name, stops: [{ longitude: 38.98, latitude: 8.75, name: 'Bishoftu' }] }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(0);
    expect(await auditRows(res)).toEqual([]);
    expect(await publishedEvents('RouteUpdated')).toEqual([]);
  });

  test('a stale If-Match is 409 CONFLICT_CONCURRENT_MODIFICATION and changes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const route = await newRoute(cookie, depot);
    await api.patch(`/routes/${route.id}`, { distance_km: 10 }, cookie, '"0"');
    const stale = await api.patch(`/routes/${route.id}`, { distance_km: 20 }, cookie, '"0"');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
    expect((await api.get(`/routes/${route.id}`, cookie)).body.data.distance_km).toBe(10);
  });

  test('an empty body, an unknown field or a null depot is 400', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await newRoute(cookie, depot);
    expect((await api.patch(`/routes/${route.id}`, {}, cookie)).body.error.details).toEqual([expect.objectContaining({ reason: 'empty_update' })]);
    expect((await api.patch(`/routes/${route.id}`, { geometry: {} }, cookie)).body.error.details).toContainEqual({ field: 'geometry', reason: 'not_writable' });
    expect((await api.patch(`/routes/${route.id}`, { depot_id: null }, cookie)).status).toBe(400);
    expect((await api.get('/routes/not-a-uuid', cookie)).status).toBe(404);
  });
});

describe('retiring a route', () => {
  test('a route can be retired without breaking past trips', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await newRoute(cookie, depot, { name: 'Addis Ababa - Dire Dawa', distance_km: 453 });
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const trip = await createTrip({
      vehicle,
      driver,
      route_id: (await pool.query<{ id: string }>('SELECT id FROM trip.routes WHERE public_id = $1', [route.id])).rows[0].id,
      status: 'completed',
      scheduled_start: '2026-09-01T06:00:00Z',
      scheduled_end: '2026-09-01T14:00:00Z',
      actual_start: '2026-09-01T06:10:00Z',
      actual_end: '2026-09-01T13:50:00Z',
    });

    const retired = await api.patch(`/routes/${route.id}`, { is_active: false }, cookie);
    expect(retired.status).toBe(200);
    expect(retired.body.data.is_active).toBe(false);
    const [event] = await publishedEvents('RouteUpdated');
    expect(event.payload).toMatchObject({ changed_fields: ['is_active'], is_active: false });

    // The past trip still points at the route, and the route still reads.
    const after = await pool.query('SELECT t.status, r.public_id FROM trip.trips t JOIN trip.routes r ON r.id = t.route_id WHERE t.id = $1', [trip.id]);
    expect(after.rows).toEqual([{ status: 'completed', public_id: route.id }]);
    expect((await api.get(`/routes/${route.id}`, cookie)).body.data).toMatchObject({ is_active: false, distance_km: 453 });

    // Gone from the default list (offered for new trips), listed under retired.
    const ids = async (q: string) => (await api.get(`/routes?page_size=100${q}`, cookie)).body.data.map((r: { id: string }) => r.id);
    expect(await ids('')).not.toContain(route.id);
    expect(await ids('&status=retired')).toContain(route.id);
    expect(await ids('&status=all')).toContain(route.id);

    // Its name is free again; bringing the old one back then collides.
    const replacement = await newRoute(cookie, depot, { name: 'Addis Ababa - Dire Dawa' });
    expect(replacement.is_active).toBe(true);
    const back = await api.patch(`/routes/${route.id}`, { is_active: true }, cookie);
    expect(back.status).toBe(409);
    expect(back.body.error.details).toEqual([{ field: 'name', reason: 'already_exists' }]);
  });
});

describe('GET /routes', () => {
  test('searches name, origin and destination; sorts by distance; pages', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    await newRoute(cookie, depot, { name: 'Short hop', destination_name: 'Bishoftu', distance_km: 45 });
    await newRoute(cookie, depot, { name: 'Long haul', destination_name: 'Mekelle', distance_km: 780 });
    await newRoute(cookie, depot, { name: 'Middle run', origin_name: 'Adama', distance_km: 99 });

    const search = await api.get('/routes?search=mekelle', cookie);
    expect(search.body.data.map((r: { name: string }) => r.name)).toEqual(['Long haul']);
    expect((await api.get('/routes?search=ADAMA', cookie)).body.data.map((r: { name: string }) => r.name)).toEqual(['Middle run']);

    const sorted = await api.get('/routes?sort_by=distance_km&sort_order=desc&page_size=2', cookie);
    expect(sorted.body.data.map((r: { name: string }) => r.name)).toEqual(['Long haul', 'Middle run']);
    expect(sorted.body.meta).toMatchObject({ page: 1, page_size: 2, total_items: 3, total_pages: 2 });
    expect((await api.get('/routes?status=archived', cookie)).body.error.code).toBe('VALIDATION_INVALID_ENUM');
  });
});
