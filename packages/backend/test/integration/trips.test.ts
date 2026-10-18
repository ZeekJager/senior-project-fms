import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Trips-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return login(user.email as string);
}

/** A driver who can sign in, with their fleet.drivers row. */
async function driverWithLogin(depot: Depot) {
  const { user, driver } = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { driver, cookie: await login(user.email as string) };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string, key?: string) => {
    const req = request(app).post(`/api/v1${path}`).set('Cookie', cookie);
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  },
  patch: (path: string, body: object, cookie: string, ifMatch?: string) => {
    const req = request(app).patch(`/api/v1${path}`).set('Cookie', cookie);
    return (ifMatch ? req.set('If-Match', ifMatch) : req).send(body);
  },
};

/** A route in the depot, straight into the table (its API is tested in routes.test.ts). */
async function insertRoute(depot: Depot, extra: Record<string, unknown> = {}) {
  const values = { name: `Route ${Math.random().toString(36).slice(2, 8)}`, depot_id: depot.id, ...extra };
  const keys = Object.keys(values);
  const res = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO trip.routes (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, public_id`,
    Object.values(values),
  );
  return res.rows[0];
}

const START = '2026-11-02T06:00:00Z';
const END = '2026-11-02T09:00:00Z';

async function newTrip(cookie: string, routePublicId: string, start = START, end = END) {
  const res = await api.post('/trips', { route_id: routePublicId, scheduled_start: start, scheduled_end: end }, cookie);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number; status: string };
}

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

describe('POST /trips', () => {
  test("creates a scheduled trip from a route, copying the route's plan and stops; no driver or vehicle yet", async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot, {
      origin_name: 'Addis Ababa',
      destination_name: 'Adama',
      distance_km: 99.5,
      estimated_duration_seconds: 9000,
      stops: JSON.stringify([{ name: 'Bishoftu', latitude: 8.75, longitude: 38.98 }, { name: 'Mojo', latitude: null, longitude: null }]),
    });
    const cookie = await signIn(['dispatcher'], depot);
    const res = await api.post('/trips', { route_id: route.public_id, scheduled_start: START, scheduled_end: END }, cookie);

    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(res.headers.location).toBe(`/api/v1/trips/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      route_id: route.public_id,
      depot_id: depot.public_id,
      vehicle_id: null,
      driver_id: null,
      status: 'scheduled',
      origin: 'Addis Ababa',
      destination: 'Adama',
      planned_distance_km: 99.5,
      planned_duration_seconds: 9000,
      scheduled_start: '2026-11-02T06:00:00.000Z',
      scheduled_end: '2026-11-02T09:00:00.000Z',
      actual_start: null,
      version: 0,
      stops: [
        expect.objectContaining({ sequence_number: 1, name: 'Bishoftu', latitude: 8.75, longitude: 38.98, status: 'planned' }),
        expect.objectContaining({ sequence_number: 2, name: 'Mojo', latitude: null, longitude: null }),
      ],
    });
    expect(await auditRows(res)).toEqual(['INSERT trip.trips', 'INSERT trip.trip_stops', 'INSERT trip.trip_stops']);
    const [event] = await publishedEvents('TripCreated');
    expect(event.payload).toEqual({ trip_id: res.body.data.id, route_id: route.public_id, depot_id: depot.public_id, scheduled_start: '2026-11-02T06:00:00.000Z', scheduled_end: '2026-11-02T09:00:00.000Z' });
    expect(event.aggregate).toBe(`trip:${res.body.data.id}`);

    // Editing the route later does not rewrite the trip's copy.
    await pool.query("UPDATE trip.routes SET distance_km = 120, destination_name = 'Nazret' WHERE id = $1", [route.id]);
    expect((await api.get(`/trips/${res.body.data.id}`, cookie)).body.data).toMatchObject({ destination: 'Adama', planned_distance_km: 99.5 });
  });

  test('end before start returns 400 VALIDATION_INVALID_DATE_RANGE and saves nothing; so does end equal to start', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const cookie = await signIn(['dispatcher'], depot);
    for (const end of ['2026-11-02T05:59:59Z', START]) {
      const res = await api.post('/trips', { route_id: route.public_id, scheduled_start: START, scheduled_end: end }, cookie);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_INVALID_DATE_RANGE', details: [{ field: 'scheduled_end', reason: 'end_before_start' }] });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM trip.trips WHERE route_id = $1', [route.id])).rows[0].n).toBe(0);
    expect(await publishedEvents('TripCreated')).toEqual([]);
  });

  test('the route must exist, be in your depots and be active; times need an offset', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const elsewhere = await insertRoute(await createDepot());
    const retired = await insertRoute(depot, { is_active: false });
    const post = (body: Record<string, unknown>) => api.post('/trips', { scheduled_start: START, scheduled_end: END, ...body }, cookie);

    expect((await post({ route_id: '00000000-0000-4000-8000-000000000000' })).body.error.details).toEqual([{ field: 'route_id', reason: 'references_missing_record' }]);
    expect((await post({ route_id: elsewhere.public_id })).body.error.details).toEqual([{ field: 'route_id', reason: 'references_missing_record' }]);
    expect((await post({ route_id: retired.public_id })).body.error.details).toEqual([{ field: 'route_id', reason: 'route_retired' }]);
    expect((await post({})).status).toBe(400);
    expect((await post({ route_id: (await insertRoute(depot)).public_id, scheduled_start: '2026-11-02T06:00:00' })).body.error.details).toEqual([
      expect.objectContaining({ field: 'scheduled_start' }),
    ]);
    // Driver and vehicle are assigned later (FMS-31), not here.
    expect((await post({ route_id: (await insertRoute(depot)).public_id, driver_id: '00000000-0000-4000-8000-000000000000' })).body.error.details).toEqual([
      { field: 'driver_id', reason: 'not_writable' },
    ]);
  });

  test('an Idempotency-Key makes a retried create return the same trip, not a second one', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const cookie = await signIn(['dispatcher'], depot);
    const key = randomUUID();
    const body = { route_id: route.public_id, scheduled_start: START, scheduled_end: END };

    const first = await api.post('/trips', body, cookie, key);
    const retry = await api.post('/trips', body, cookie, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM trip.trips WHERE route_id = $1', [route.id])).rows[0].n).toBe(1);

    const other = await api.post('/trips', { ...body, scheduled_end: '2026-11-02T10:00:00Z' }, cookie, key);
    expect(other.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSED');
  });

  test('trip:write is needed: a driver gets 403, as does a technician on reads', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const { cookie } = await driverWithLogin(depot);
    expect((await api.post('/trips', { route_id: route.public_id, scheduled_start: START, scheduled_end: END }, cookie)).status).toBe(403);
    expect((await api.get('/trips', await signIn(['technician'], depot))).status).toBe(403);
  });
});

describe('PATCH /trips/{id}', () => {
  test('reschedules with If-Match: the version goes up and TripUpdated says what changed', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const cookie = await signIn(['dispatcher'], depot);
    const trip = await newTrip(cookie, route.public_id);

    const res = await api.patch(`/trips/${trip.id}`, { scheduled_start: '2026-11-02T07:00:00Z', scheduled_end: '2026-11-02T10:00:00Z' }, cookie, '"0"');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.data).toMatchObject({ scheduled_start: '2026-11-02T07:00:00.000Z', version: 1, status: 'scheduled' });
    expect(await auditRows(res)).toEqual(['UPDATE trip.trips']);
    const [event] = await publishedEvents('TripUpdated');
    expect(event.payload).toEqual({ trip_id: trip.id, changed_fields: ['scheduled_end', 'scheduled_start'], status: 'scheduled' });

    const stale = await api.patch(`/trips/${trip.id}`, { scheduled_end: '2026-11-02T11:00:00Z' }, cookie, '"0"');
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
  });

  test('a new end before the current start is 400 VALIDATION_INVALID_DATE_RANGE', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const trip = await newTrip(cookie, (await insertRoute(depot)).public_id);
    const res = await api.patch(`/trips/${trip.id}`, { scheduled_end: '2026-11-02T05:00:00Z' }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
  });

  test('a draft that gets both times becomes scheduled', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const draft = await pool.query<{ public_id: string }>("INSERT INTO trip.trips (route_id, status) VALUES ($1, 'draft') RETURNING public_id", [route.id]);
    const cookie = await signIn(['fleet_manager']);
    const res = await api.patch(`/trips/${draft.rows[0].public_id}`, { scheduled_start: START, scheduled_end: END }, cookie);
    expect(res.body.data).toMatchObject({ status: 'scheduled', scheduled_start: '2026-11-02T06:00:00.000Z' });
  });
});

describe('cancelling', () => {
  test('cancelling keeps the row with status cancelled, and it stays in the history', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const cookie = await signIn(['dispatcher'], depot);
    const trip = await newTrip(cookie, route.public_id);

    const res = await api.patch(`/trips/${trip.id}`, { status: 'cancelled' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: trip.id, status: 'cancelled', version: 1 });
    const row = await pool.query('SELECT status FROM trip.trips WHERE public_id = $1', [trip.id]);
    expect(row.rows).toEqual([{ status: 'cancelled' }]);
    expect((await api.get(`/trips/${trip.id}`, cookie)).body.data.status).toBe('cancelled');
    expect((await api.get(`/trips?status=cancelled&route_id=${route.public_id}`, cookie)).body.data.map((t: { id: string }) => t.id)).toEqual([trip.id]);

    const [event] = await publishedEvents('TripCancelled');
    expect(event.payload).toEqual({ trip_id: trip.id, previous_status: 'scheduled', route_id: route.public_id, driver_id: null, vehicle_id: null });

    // A cancelled trip never changes again.
    const again = await api.patch(`/trips/${trip.id}`, { scheduled_end: '2026-11-02T12:00:00Z' }, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'trip_cancelled' }] });
  });

  test('an assigned trip can be cancelled; one under way or completed cannot', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const cookie = await signIn(['dispatcher'], depot);
    const trip = (status: string, hours: number) =>
      createTrip({
        vehicle,
        driver,
        route_id: route.id,
        status,
        scheduled_start: new Date(Date.UTC(2026, 10, 10, hours)).toISOString(),
        scheduled_end: new Date(Date.UTC(2026, 10, 10, hours + 1)).toISOString(),
      });
    const assigned = await trip('assigned', 6);
    const enRoute = await trip('en_route', 9);
    const completed = await trip('completed', 12);

    const cancelled = await api.patch(`/trips/${assigned.public_id}`, { status: 'cancelled' }, cookie);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await publishedEvents('TripCancelled'))[0].payload).toMatchObject({ previous_status: 'assigned', driver_id: expect.any(String), vehicle_id: expect.any(String) });

    const underWay = await api.patch(`/trips/${enRoute.public_id}`, { status: 'cancelled' }, cookie);
    expect(underWay.status).toBe(409);
    expect(underWay.body.error.details).toEqual([{ field: 'status', reason: 'trip_en_route' }]);
    expect((await api.patch(`/trips/${completed.public_id}`, { status: 'cancelled' }, cookie)).body.error.details).toEqual([{ field: 'status', reason: 'trip_completed' }]);
    expect((await api.patch(`/trips/${assigned.public_id}`, { status: 'completed' }, cookie)).status).toBe(400);
  });
});

describe('who sees which trips', () => {
  test('a driver only receives their own trips', async () => {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const vehicle = await createVehicle({ depot });
    const me = await driverWithLogin(depot);
    const { driver: other } = await createDriver({ depot });
    const mine = await createTrip({ vehicle, driver: me.driver, route_id: route.id, scheduled_start: '2026-11-03T06:00:00Z', scheduled_end: '2026-11-03T08:00:00Z' });
    const theirs = await createTrip({ vehicle, driver: other, route_id: route.id, scheduled_start: '2026-11-04T06:00:00Z', scheduled_end: '2026-11-04T08:00:00Z' });

    const list = await api.get('/trips', me.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([mine.public_id]);
    expect(list.body.data[0]).toMatchObject({ driver_id: me.driver.public_id, version: expect.any(Number) });

    // Asking for someone else's trips is an empty list, not 403.
    const asked = await api.get(`/trips?driver_id=${other.public_id}`, me.cookie);
    expect(asked.status).toBe(200);
    expect(asked.body.data).toEqual([]);
    expect((await api.get(`/trips/${theirs.public_id}`, me.cookie)).status).toBe(404);
    expect((await api.get(`/trips/${mine.public_id}`, me.cookie)).status).toBe(200);
  });

  test("a depot's dispatcher sees only trips on their depot's routes", async () => {
    const depotA = await createDepot();
    const depotB = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const tripA = await newTrip(manager, (await insertRoute(depotA)).public_id);
    const tripB = await newTrip(manager, (await insertRoute(depotB)).public_id);

    const dispatcherA = await signIn(['dispatcher'], depotA);
    const ids = (await api.get('/trips?page_size=100', dispatcherA)).body.data.map((t: { id: string }) => t.id);
    expect(ids).toContain(tripA.id);
    expect(ids).not.toContain(tripB.id);
    expect((await api.get(`/trips/${tripB.id}`, dispatcherA)).status).toBe(404);
    expect((await api.patch(`/trips/${tripB.id}`, { status: 'cancelled' }, dispatcherA)).status).toBe(404);
    expect((await api.get(`/trips?depot_id=${depotB.public_id}`, dispatcherA)).body.data).toEqual([]);
  });
});

describe('GET /trips (history)', () => {
  async function history() {
    const depot = await createDepot();
    const route = await insertRoute(depot);
    const otherRoute = await insertRoute(depot);
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const cookie = await signIn(['fleet_manager']);
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    const trips = [];
    for (const [i, day] of days.entries()) {
      const status = i % 2 === 0 ? 'completed' : 'cancelled';
      trips.push(
        await createTrip({ vehicle, driver, route_id: i === 4 ? otherRoute.id : route.id, status, scheduled_start: `${day}T06:00:00Z`, scheduled_end: `${day}T08:00:00Z`, ...(status === 'completed' ? { actual_start: `${day}T06:05:00Z`, actual_end: `${day}T07:55:00Z` } : {}) }),
      );
    }
    return { depot, route, otherRoute, vehicle, driver, cookie, ids: trips.map((t) => t.public_id as string) };
  }

  test('pages newest first by keyset: each page follows on, with no repeats, until next_cursor is null', async () => {
    const h = await history();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await api.get(`/trips?vehicle_id=${h.vehicle.public_id}&page_size=2${cursor ? `&cursor=${cursor}` : ''}`, h.cookie);
      expect(res.status).toBe(200);
      expect(res.body.meta.page_size).toBe(2);
      seen.push(...res.body.data.map((t: { id: string }) => t.id));
      cursor = res.body.meta.next_cursor;
    } while (cursor);
    expect(seen).toEqual([...h.ids].reverse());

    const asc = await api.get(`/trips?vehicle_id=${h.vehicle.public_id}&sort_order=asc&page_size=3`, h.cookie);
    expect(asc.body.data.map((t: { id: string }) => t.id)).toEqual(h.ids.slice(0, 3));
    expect((await api.get('/trips?cursor=bm9wZQ', h.cookie)).body.error.details).toEqual([{ field: 'cursor', reason: 'invalid_cursor' }]);
  });

  test('filters combine: status (one or several), driver, vehicle, route, and a date range', async () => {
    const h = await history();
    const ids = async (q: string) => (await api.get(`/trips?vehicle_id=${h.vehicle.public_id}&sort_order=asc&${q}`, h.cookie)).body.data.map((t: { id: string }) => t.id);
    expect(await ids('status=completed')).toEqual([h.ids[0], h.ids[2], h.ids[4]]);
    expect(await ids('status=completed,cancelled')).toEqual(h.ids);
    expect(await ids(`status=completed&route_id=${h.route.public_id}`)).toEqual([h.ids[0], h.ids[2]]);
    expect(await ids(`driver_id=${h.driver.public_id}&route_id=${h.otherRoute.public_id}`)).toEqual([h.ids[4]]);
    // A date `to` covers the whole (Addis Ababa) day.
    expect(await ids('from=2026-09-02&to=2026-09-04')).toEqual([h.ids[1], h.ids[2], h.ids[3]]);
    expect(await ids('from=2026-09-02T00:00:00Z&to=2026-09-03T06:00:00Z')).toEqual([h.ids[1]]);
    expect(await ids('route_id=00000000-0000-4000-8000-000000000000')).toEqual([]);
  });

  test('a range that ends before it starts is 400 VALIDATION_INVALID_DATE_RANGE; a bad status is 400', async () => {
    const cookie = await signIn(['fleet_manager']);
    const res = await api.get('/trips?from=2026-09-05&to=2026-09-01', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
    expect((await api.get('/trips?status=finished', cookie)).status).toBe(400);
  });
});
