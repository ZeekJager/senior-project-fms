// FMS-139: flexible dispatch. Trips nobody planned (a one-off route), an end from the route's estimate, an
// en-route trip's end moved, and a time change that runs into the next trip: refused naming it, or with
// shift_following that trip (and the ones it then runs into) moved later. Never two trips at once for a
// driver or a vehicle.
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Flexible-Dispatch-1';

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
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** A time on one fixed day, `h:mm`, in UTC. */
const at = (hhmm: string) => `2031-03-04T${hhmm}:00.000Z`;

/** A planned route in the depot, straight into the table (its API is tested in routes.test.ts). */
async function insertRoute(depot: Depot, extra: Record<string, unknown> = {}) {
  const values = { name: `Route ${Math.random().toString(36).slice(2, 8)}`, depot_id: depot.id, ...extra };
  const keys = Object.keys(values);
  const res = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO trip.routes (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, public_id`,
    Object.values(values),
  );
  return res.rows[0];
}

/** A driver's and a vehicle's trip on the fixed day, with a route in the depot. */
async function staffedTrip(depot: Depot, who: { driver: { id: string }; vehicle: { id: string } }, start: string, end: string, extra: Record<string, unknown> = {}) {
  const route = await insertRoute(depot);
  return createTrip({ ...who, route_id: route.id, scheduled_start: at(start), scheduled_end: at(end), ...extra });
}

async function timesOf(publicId: unknown) {
  const res = await pool.query<{ scheduled_start: Date; scheduled_end: Date }>('SELECT scheduled_start, scheduled_end FROM trip.trips WHERE public_id = $1', [publicId]);
  return { start: res.rows[0].scheduled_start.toISOString(), end: res.rows[0].scheduled_end.toISOString() };
}

describe('a trip nobody planned (FMS-139)', () => {
  test('POST /trips with a route instead of route_id: a one-off route of the depot, kept out of the route lists', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const res = await api.post(
      '/trips',
      {
        route: { origin_name: 'Bole depot', origin: { latitude: 8.98, longitude: 38.79 }, destination_name: 'Kality customs', destination: { latitude: 8.9, longitude: 38.77 } },
        scheduled_start: at('09:00'),
        scheduled_end: at('10:30'),
      },
      cookie,
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'scheduled', origin: 'Bole depot', destination: 'Kality customs', depot_id: depot.public_id, scheduled_end: at('10:30') });

    const route = await api.get(`/routes/${res.body.data.route_id}`, cookie);
    expect(route.body.data).toMatchObject({ name: 'Bole depot → Kality customs', is_adhoc: true, is_active: true, destination: { latitude: 8.9, longitude: 38.77 } });
    expect((await api.get('/routes?status=all', cookie)).body.data.map((r: { id: string }) => r.id)).not.toContain(res.body.data.route_id);
    // A second one-off trip to the same place is fine: one-off routes do not take a name.
    expect((await api.post('/trips', { route: { origin_name: 'Bole depot', destination_name: 'Kality customs' }, scheduled_start: at('11:00'), scheduled_end: at('12:00') }, cookie)).status).toBe(201);
  });

  test('the depot: a depot user’s own by default; anyone else names one of theirs', async () => {
    const depot = await createDepot();
    const route = { origin_name: 'Adama', destination_name: 'Modjo' };
    const admin = await signIn(['admin']);
    const missing = await api.post('/trips', { route, scheduled_start: at('09:00'), scheduled_end: at('10:00') }, admin);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ field: 'depot_id', reason: 'required' }]);
    const named = await api.post('/trips', { route, depot_id: depot.public_id, scheduled_start: at('09:00'), scheduled_end: at('10:00') }, admin);
    expect(named.body.data.depot_id).toBe(depot.public_id);

    const other = await createDepot();
    const dispatcher = await signIn(['dispatcher'], depot);
    const elsewhere = await api.post('/trips', { route, depot_id: other.public_id, scheduled_start: at('09:00'), scheduled_end: at('10:00') }, dispatcher);
    expect(elsewhere.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
  });

  test('without an end, the route’s estimated time; none to go by is 400; route_id and route together are 400', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const timed = await insertRoute(depot, { estimated_duration_seconds: 5400 });
    const res = await api.post('/trips', { route_id: timed.public_id, scheduled_start: at('09:00') }, cookie);
    expect(res.status).toBe(201);
    expect(res.body.data.scheduled_end).toBe(at('10:30'));

    const untimed = await api.post('/trips', { route: { origin_name: 'Bole', destination_name: 'Piassa' }, scheduled_start: at('09:00') }, cookie);
    expect(untimed.status).toBe(400);
    expect(untimed.body.error.details).toEqual([{ field: 'scheduled_end', reason: 'required' }]);
    const both = await api.post('/trips', { route_id: timed.public_id, route: { origin_name: 'Bole', destination_name: 'Piassa' }, scheduled_start: at('09:00') }, cookie);
    expect(both.status).toBe(400);
  });
});

describe('moving times once a driver waits on them (FMS-139)', () => {
  test('an en-route trip running late: its end moves, with a reason kept on the change; its start never does', async () => {
    const depot = await createDepot();
    const who = { driver: (await createDriver({ depot })).driver, vehicle: await createVehicle({ depot }) };
    const trip = await staffedTrip(depot, who, '08:00', '10:00', { status: 'en_route', actual_start: at('08:05') });
    const cookie = await signIn(['dispatcher'], depot);

    expect((await api.patch(`/trips/${trip.public_id}`, { scheduled_end: at('11:00') }, cookie)).body.error.details).toEqual([{ field: 'reason', reason: 'required' }]);
    expect((await api.patch(`/trips/${trip.public_id}`, { scheduled_start: at('08:30'), reason: 'Late' }, cookie)).body.error.details).toEqual([
      { field: 'scheduled_start', reason: 'trip_under_way' },
    ]);
    expect((await api.patch(`/trips/${trip.public_id}`, { scheduled_end: at('08:00'), reason: 'Back early' }, cookie)).status).toBe(400);

    const res = await api.patch(`/trips/${trip.public_id}`, { scheduled_end: at('11:00'), reason: 'Road works at Modjo' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'en_route', scheduled_end: at('11:00') });
    expect(res.body.meta.shifted).toEqual([]);
    const [event] = (await publishedEvents('TripUpdated')).filter((e) => e.payload.trip_id === trip.public_id);
    expect(event.payload).toMatchObject({ changed_fields: ['scheduled_end'], status: 'en_route', reason: 'Road works at Modjo' });
  });

  test('a scheduled trip, nobody on it yet, moves without a reason; an assigned one needs it', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await insertRoute(depot);
    const open = await api.post('/trips', { route_id: route.public_id, scheduled_start: at('09:00'), scheduled_end: at('10:00') }, cookie);
    expect((await api.patch(`/trips/${open.body.data.id}`, { scheduled_end: at('10:30') }, cookie)).status).toBe(200);

    const who = { driver: (await createDriver({ depot })).driver, vehicle: await createVehicle({ depot }) };
    const assigned = await staffedTrip(depot, who, '12:00', '13:00');
    expect((await api.patch(`/trips/${assigned.public_id}`, { scheduled_end: at('13:30') }, cookie)).status).toBe(400);
    expect((await api.patch(`/trips/${assigned.public_id}`, { scheduled_end: at('13:30'), reason: 'Customer asked' }, cookie)).status).toBe(200);
  });
});

describe('a change that runs into the next trip (FMS-139)', () => {
  test('refused naming the trip and the minutes it would move; with shift_following it moves, and so does the trip it then runs into', async () => {
    const depot = await createDepot();
    const driver = (await createDriver({ depot })).driver;
    const [truck, van] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const otherDriver = (await createDriver({ depot })).driver;
    // A runs late into B (same driver); B, moved, runs into C (same van, another driver).
    const a = await staffedTrip(depot, { driver, vehicle: truck }, '08:00', '10:00', { status: 'en_route', actual_start: at('08:00') });
    const b = await staffedTrip(depot, { driver, vehicle: van }, '10:30', '12:00');
    const c = await staffedTrip(depot, { driver: otherDriver, vehicle: van }, '12:15', '13:00');
    const later = await staffedTrip(depot, { driver: otherDriver, vehicle: truck }, '18:00', '19:00');
    const cookie = await signIn(['dispatcher'], depot);

    const refused = await api.patch(`/trips/${a.public_id}`, { scheduled_end: at('11:00'), reason: 'Puncture' }, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_DRIVER_OVERLAP');
    expect(refused.body.error.details).toEqual([{ field: 'driver_id', reason: 'overlapping_trip', record_id: b.public_id, shiftable: true, shift_minutes: 31 }]);
    expect(await timesOf(b.public_id)).toEqual({ start: at('10:30'), end: at('12:00') });

    const res = await api.patch(`/trips/${a.public_id}`, { scheduled_end: at('11:00'), reason: 'Puncture', shift_following: true }, cookie);
    expect(res.status).toBe(200);
    // B starts a minute after A now ends; C a minute after B now ends; each keeps its length.
    expect(res.body.meta.shifted).toEqual([
      { trip_id: b.public_id, scheduled_start: at('11:01'), scheduled_end: at('12:31') },
      { trip_id: c.public_id, scheduled_start: at('12:32'), scheduled_end: at('13:17') },
    ]);
    expect(await timesOf(b.public_id)).toEqual({ start: at('11:01'), end: at('12:31') });
    expect(await timesOf(c.public_id)).toEqual({ start: at('12:32'), end: at('13:17') });
    expect(await timesOf(later.public_id)).toEqual({ start: at('18:00'), end: at('19:00') });

    const moved = (await publishedEvents('TripUpdated')).filter((e) => e.payload.shifted_by_trip_id === a.public_id).map((e) => e.payload.trip_id);
    expect(moved.sort()).toEqual([b.public_id, c.public_id].sort());
  });

  test('a trip under way, or one that starts earlier, is never moved: refused even with shift_following', async () => {
    const depot = await createDepot();
    const who = { driver: (await createDriver({ depot })).driver, vehicle: await createVehicle({ depot }) };
    const underWay = await staffedTrip(depot, who, '08:00', '10:00', { status: 'en_route', actual_start: at('08:00') });
    const next = await staffedTrip(depot, who, '10:30', '12:00');
    const cookie = await signIn(['dispatcher'], depot);

    // Moving the next trip earlier runs into the one under way.
    const res = await api.patch(`/trips/${next.public_id}`, { scheduled_start: at('09:30'), reason: 'Earlier slot', shift_following: true }, cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([{ field: 'driver_id', reason: 'overlapping_trip', record_id: underWay.public_id, shiftable: false }]);
    expect(await timesOf(underWay.public_id)).toEqual({ start: at('08:00'), end: at('10:00') });
  });
});
