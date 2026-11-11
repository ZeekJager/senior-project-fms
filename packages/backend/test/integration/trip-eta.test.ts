// FMS-86: live arrival times and stop-order optimisation. The routing engine is a stand-in gateway client that
// measures the road as 1.25 times the straight line, driven at 45 km/h, so the expected times are worked out
// here the same way. Pings go in through the API as a device sends them; the relay delivers
// VehicleLocationUpdated to the estimate, as in production.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { gpsDevices } from '../../src/modules/integration';
import { provideRoutingClient } from '../../src/modules/trip';
import { createDepot, createDriver, createProvider, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Trip-Eta-Test-1';
const SEC = 1000;
type Row = Record<string, unknown> & { id: string };
type Point = { latitude: number; longitude: number };

/** km due north of a base near Bole (0.009° of latitude is about 1 km). */
const north = (km: number): Point => ({ latitude: 9 + km * 0.008993, longitude: 38.75 });

/** The stand-in's road between two points: 1.25 times the straight line, in metres to 0.1, at 12.5 m/s. */
function roadMetres(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)) * 1.25 * 10) / 10;
}
const SPEED_MS = 12.5;
const lngLat = (p: Point): [number, number] => [Number(p.longitude.toFixed(6)), Number(p.latitude.toFixed(6))];

/** Seconds along consecutive points, as the planner rounds each leg. */
const legSeconds = (points: Point[]) => points.slice(1).map((p, i) => Math.round(roadMetres(lngLat(points[i]), lngLat(p)) / SPEED_MS));

const engine = {
  calls: [] as string[],
  down: false,
  connect() {
    provideRoutingClient(() => ({
      call: async <T>({ path }: { method: 'GET'; path: string }) => {
        engine.calls.push(path);
        if (engine.down) throw Object.assign(new Error(`GET ${path} could not reach the provider.`), { status: undefined });
        const points = path
          .split('/')
          .at(-1)!
          .split(';')
          .map((p) => p.split(',').map(Number) as [number, number]);
        if (path.startsWith('/table/')) {
          const distances = points.map((a) => points.map((b) => roadMetres(a, b)));
          return { body: { code: 'Ok', distances, durations: distances.map((row) => row.map((m) => m / SPEED_MS)) } as T };
        }
        const legs = points.slice(1).map((b, i) => ({ distance: roadMetres(points[i], b), duration: roadMetres(points[i], b) / SPEED_MS }));
        return { body: { code: 'Ok', routes: [{ legs }] } as T };
      },
    }));
  },
};

afterEach(() => {
  provideRoutingClient(null);
  engine.calls = [];
  engine.down = false;
});

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A route of the depot: origin, stops and destination, as given. */
async function insertRoute(depot: Row, origin: Point, stops: (Point & { name: string })[], destination: Point | null): Promise<Row> {
  const res = await pool.query(
    `INSERT INTO trip.routes (name, depot_id, origin_name, origin_latitude, origin_longitude, destination_name, destination_latitude, destination_longitude, stops)
     VALUES ($1, $2, 'Depot', $3, $4, 'Customer', $5, $6, $7::jsonb) RETURNING *`,
    [`ETA ${randomUUID().slice(0, 8)}`, depot.id, origin.latitude, origin.longitude, destination?.latitude ?? null, destination?.longitude ?? null, JSON.stringify(stops)],
  );
  return res.rows[0];
}

/**
 * A trip under way since 20 minutes ago on a route north from the depot (stops A and B at 1 and 2 km, the
 * destination at 3 km), with its stops copied as a trip copies them, and a device in the vehicle.
 */
async function tripUnderWay(options: { destination?: Point | null } = {}) {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot });
  const { driver } = await createDriver({ depot });
  const stops = [
    { name: 'Stop A', ...north(1) },
    { name: 'Stop B', ...north(2) },
  ];
  const destination = options.destination === undefined ? north(3) : options.destination;
  const route = await insertRoute(depot, north(0), stops, destination);
  const started = new Date(Date.now() - 20 * 60 * SEC).toISOString();
  const trip = await createTrip({ vehicle, driver, route_id: route.id, status: 'en_route', scheduled_start: started, actual_start: started, origin: 'Depot', destination: 'Customer' });
  for (const [i, s] of stops.entries()) {
    await pool.query('INSERT INTO trip.trip_stops (trip_id, sequence_number, name, stop_type, latitude, longitude) VALUES ($1, $2, $3, $4, $5, $6)', [
      trip.id,
      i + 1,
      s.name,
      'waypoint',
      s.latitude,
      s.longitude,
    ]);
  }
  const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `eta-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
  return { depot, vehicle, trip, route, token, destination };
}

/** One ping from the device at `point`, recorded `msAgo` ago, then the relay delivers. */
async function ping(token: string, point: Point, recordedAt: Date) {
  const res = await request(app)
    .post('/api/v1/tracking/gps-pings')
    .set('Authorization', `Bearer ${token}`)
    .send({ pings: [{ recorded_at: recordedAt.toISOString(), lat: point.latitude, lng: point.longitude, speed_kmh: 45, ignition_on: true }] });
  expect(res.status).toBe(202);
  await deliverEvents();
}

const stopsOf = async (trip: Row) =>
  (await pool.query('SELECT public_id, name, status, actual_arrival, eta FROM trip.trip_stops WHERE trip_id = $1 ORDER BY sequence_number', [trip.id])).rows as Row[];
const etaEvents = async (trip: Row) => (await publishedEvents('TripEtaUpdated')).filter((e) => e.payload.trip_id === trip.public_id);
const plus = (at: Date, seconds: number) => new Date(at.getTime() + seconds * SEC);

describe('live arrival times (FMS-86)', () => {
  test('a position on a trip under way gives each stop and the destination an arrival time, in the API, the event and the live map', async () => {
    engine.connect();
    const { depot, vehicle, trip, token, destination } = await tripUnderWay();
    const position = north(0.5);
    const at = new Date(Date.now() - 60 * SEC);
    await ping(token, position, at);

    const [toA, toB, toEnd] = legSeconds([position, north(1), north(2), destination!]);
    const stops = await stopsOf(trip);
    expect(stops.map((s) => (s.eta as Date).toISOString())).toEqual([plus(at, toA).toISOString(), plus(at, toA + toB).toISOString()]);
    expect(stops.map((s) => s.status)).toEqual(['planned', 'planned']);

    const [event, ...more] = await etaEvents(trip);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor: null,
      aggregate: `trip:${trip.public_id}`,
      payload: {
        trip_id: trip.public_id,
        arrival_at: plus(at, toA + toB + toEnd).toISOString(),
        remaining_seconds: toA + toB + toEnd,
        position_at: at.toISOString(),
        stops: stops.map((s) => ({ stop_id: s.public_id, eta: (s.eta as Date).toISOString() })),
        reached_stop_ids: [],
      },
    });
    expect(event.payload.remaining_km).toBeCloseTo(3.125, 2);

    const cookie = await signIn(['dispatcher'], depot);
    const res = await request(app).get(`/api/v1/trips/${trip.public_id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.eta).toMatchObject({
      arrival_at: plus(at, toA + toB + toEnd).toISOString(),
      remaining_seconds: toA + toB + toEnd,
      next_stop: { stop_id: stops[0].public_id, name: 'Stop A', eta: plus(at, toA).toISOString() },
      position_at: at.toISOString(),
    });
    expect(res.body.data.stops.map((s: { eta: string }) => s.eta)).toEqual([plus(at, toA).toISOString(), plus(at, toA + toB).toISOString()]);

    const live = await request(app).get(`/api/v1/tracking/vehicles/current?depot_id=${depot.public_id}`).set('Cookie', cookie);
    expect(live.status).toBe(200);
    const mine = live.body.data.find((v: { vehicle_id: string }) => v.vehicle_id === vehicle.public_id);
    expect(mine.trip.eta).toMatchObject({ arrival_at: plus(at, toA + toB + toEnd).toISOString(), next_stop: { name: 'Stop A', eta: plus(at, toA).toISOString() } });
  });

  test('at most one estimate per 30 seconds of position time per trip', async () => {
    engine.connect();
    const { trip, token } = await tripUnderWay();
    const t0 = new Date(Date.now() - 3 * 60 * SEC);
    // Every 10 s: each ping is announced (one per vehicle per 5 s), but only every third one is estimated.
    for (const [i, seconds] of [0, 10, 20, 30, 40, 50, 60].entries()) await ping(token, north(0.1 + i * 0.05), plus(t0, seconds));

    const events = await etaEvents(trip);
    expect(events.map((e) => e.payload.position_at)).toEqual([t0, plus(t0, 30), plus(t0, 60)].map((d) => d.toISOString()));
    expect(engine.calls.filter((p) => p.startsWith('/route/'))).toHaveLength(3);
  });

  test('reaching a stop marks it arrived at the position time; only the stops ahead keep a time', async () => {
    engine.connect();
    const { trip, token, destination } = await tripUnderWay();
    const t0 = new Date(Date.now() - 2 * 60 * SEC);
    await ping(token, north(0.5), t0);
    // About 50 m past Stop A: within the 150 m radius.
    const nearA = north(1.05);
    await ping(token, nearA, plus(t0, 40));

    const [a, b] = await stopsOf(trip);
    expect(a).toMatchObject({ status: 'arrived', eta: null });
    expect((a.actual_arrival as Date).toISOString()).toBe(plus(t0, 40).toISOString());
    const [toB, toEnd] = legSeconds([nearA, north(2), destination!]);
    expect((b.eta as Date).toISOString()).toBe(plus(t0, 40 + toB).toISOString());

    const [, second] = await etaEvents(trip);
    expect(second.payload).toMatchObject({ reached_stop_ids: [a.public_id], arrival_at: plus(t0, 40 + toB + toEnd).toISOString() });
  });

  test('the routing engine down: the last estimate stays, the event is not retried, and the next position asks again', async () => {
    engine.connect();
    const { trip, token } = await tripUnderWay();
    const t0 = new Date(Date.now() - 2 * 60 * SEC);
    await ping(token, north(0.5), t0);
    const before = await stopsOf(trip);

    engine.down = true;
    await ping(token, north(0.8), plus(t0, 30));
    expect(await etaEvents(trip)).toHaveLength(1);
    expect((await stopsOf(trip)).map((s) => s.eta)).toEqual(before.map((s) => s.eta));
    const failed = await pool.query("SELECT count(*)::int AS n FROM events.outbox WHERE event_type = 'VehicleLocationUpdated' AND dispatched_at IS NULL");
    expect(failed.rows[0].n).toBe(0);

    engine.down = false;
    await ping(token, north(0.9), plus(t0, 60));
    expect(await etaEvents(trip)).toHaveLength(2);
  });

  test('without destination coordinates the stops are estimated and the trip has no arrival time', async () => {
    engine.connect();
    const { trip, token } = await tripUnderWay({ destination: null });
    const at = new Date(Date.now() - 60 * SEC);
    await ping(token, north(0.5), at);
    const [event] = await etaEvents(trip);
    const [toA, toB] = legSeconds([north(0.5), north(1), north(2)]);
    expect(event.payload).toMatchObject({ arrival_at: null, remaining_seconds: toA + toB });
  });

  test('a trip that is not under way, or a vehicle on no trip, gets no estimate', async () => {
    engine.connect();
    const { trip, token } = await tripUnderWay();
    await pool.query("UPDATE trip.trips SET status = 'completed', actual_end = now() WHERE id = $1", [trip.id]);
    await ping(token, north(0.5), new Date(Date.now() - 30 * SEC));
    expect(await etaEvents(trip)).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM trip.trip_etas WHERE trip_id = $1', [trip.id])).rows[0].n).toBe(0);
  });
});

describe('the trip delay alert (FMS-147)', () => {
  /** When the trip from tripUnderWay is expected at its destination, for a ping at north(0.5) recorded `at`. */
  const arrivalFrom = (at: Date, destination: Point) => plus(at, legSeconds([north(0.5), north(1), north(2), destination]).reduce((a, b) => a + b, 0));
  /** Moves the scheduled end so the trip is expected `minutes` after it, for a ping recorded `at`. */
  const lateBy = (trip: Row, at: Date, destination: Point, minutes: number) =>
    pool.query('UPDATE trip.trips SET scheduled_start = least(scheduled_start, $2), scheduled_end = $2 WHERE id = $1', [trip.id, new Date(arrivalFrom(at, destination).getTime() - minutes * 60 * SEC)]);
  const delayAlerts = async (trip: Row) =>
    (
      await pool.query(
        `SELECT id, alert_type, severity, title, description AS message, entity_type, entity_id, depot_id::text, source_module, occurrence_count
           FROM alert.alerts WHERE trip_id = $1 ORDER BY id`,
        [trip.id],
      )
    ).rows as Row[];
  const notified = async (alert: Row) =>
    (await pool.query('SELECT recipient_user_id::text AS recipient, channel FROM alert.notifications WHERE alert_id = $1 ORDER BY id', [alert.id])).rows as {
      recipient: string;
      channel: string;
    }[];
  const delayedEvents = async (trip: Row) => (await publishedEvents('TripDelayed')).filter((e) => e.payload.trip_id === trip.public_id);

  test('an estimate past the margin raises one alert for the depot’s dispatchers; a second update past it raises none', async () => {
    engine.connect();
    const { depot, vehicle, trip, token, destination } = await tripUnderWay();
    const dispatcher = await createUser({ roles: ['dispatcher'], depot });
    const elsewhere = await createUser({ roles: ['dispatcher'], depot: await createDepot() });
    const at = new Date(Date.now() - 120 * SEC);
    await lateBy(trip, at, destination!, 20);
    await ping(token, north(0.5), at);

    const [alert, ...more] = await delayAlerts(trip);
    expect(more).toEqual([]);
    expect(alert).toMatchObject({
      alert_type: 'trip_delayed',
      severity: 'medium',
      source_module: 'trip',
      entity_type: 'trip',
      entity_id: trip.public_id,
      depot_id: String(depot.id),
      title: `Trip running late: ${vehicle.registration_number}`,
      occurrence_count: 1,
    });
    expect(alert.message).toMatch(new RegExp(`^${vehicle.registration_number} is expected at Customer at \\d\\d:\\d\\d, 20 minutes after the trip's scheduled end at \\d\\d:\\d\\d\\.`));
    const told = await notified(alert);
    expect(told).toContainEqual({ recipient: String(dispatcher.id), channel: 'in_app' });
    expect(told.map((n) => n.recipient)).not.toContain(String(elsewhere.id));

    const [event] = await delayedEvents(trip);
    expect(event.payload).toMatchObject({ level: 'late', episode: 1, late_minutes: 20, margin_minutes: 15, depot_id: depot.public_id, vehicle_id: vehicle.public_id });

    // Thirty seconds on, still past the margin: the estimate moves, nobody is told again.
    const next = plus(at, 30);
    await lateBy(trip, next, destination!, 25);
    await ping(token, north(0.5), next);
    expect(await etaEvents(trip)).toHaveLength(2);
    expect(await delayedEvents(trip)).toHaveLength(1);
    expect(await delayAlerts(trip)).toEqual([expect.objectContaining({ id: alert.id, occurrence_count: 1 })]);
    expect(await notified(alert)).toEqual(told);
  });

  test('past the second margin the same alert becomes critical and the dispatchers are told again, on the urgent channels', async () => {
    engine.connect();
    await createProvider({ code: `delay-smtp-${randomUUID().slice(0, 8)}`, provider_type: 'notification', configuration: { channel: 'email', host: '127.0.0.1', port: 2525, tls: 'none', from: 'FMS <alerts@fleet.test>' } });
    const { depot, vehicle, trip, token, destination } = await tripUnderWay();
    const dispatcher = await createUser({ roles: ['dispatcher'], depot });
    const at = new Date(Date.now() - 120 * SEC);
    await lateBy(trip, at, destination!, 20);
    await ping(token, north(0.5), at);
    const [late] = await delayAlerts(trip);
    expect((await notified(late)).filter((n) => n.recipient === String(dispatcher.id))).toEqual([{ recipient: String(dispatcher.id), channel: 'in_app' }]);

    const next = plus(at, 30);
    await lateBy(trip, next, destination!, 75);
    await ping(token, north(0.5), next);
    const [urgent, ...more] = await delayAlerts(trip);
    expect(more).toEqual([]);
    expect(urgent).toMatchObject({ id: late.id, severity: 'critical', title: `Trip far behind schedule: ${vehicle.registration_number}`, occurrence_count: 2 });
    expect(urgent.message).toContain('75 minutes after');
    expect((await notified(urgent)).filter((n) => n.recipient === String(dispatcher.id))).toEqual([
      { recipient: String(dispatcher.id), channel: 'in_app' },
      { recipient: String(dispatcher.id), channel: 'in_app' },
      { recipient: String(dispatcher.id), channel: 'email' },
    ]);
    expect((await delayedEvents(trip)).map((e) => e.payload.level)).toEqual(['late', 'urgent']);
  });

  test('a trip that recovers within the margin is alerted again only when it falls late again, as a new alert', async () => {
    engine.connect();
    const { trip, token, destination } = await tripUnderWay();
    const at = new Date(Date.now() - 150 * SEC);
    await lateBy(trip, at, destination!, 20);
    await ping(token, north(0.5), at);
    await lateBy(trip, plus(at, 30), destination!, 5);
    await ping(token, north(0.5), plus(at, 30));
    expect((await pool.query('SELECT delay_level, delay_episode FROM trip.trip_etas WHERE trip_id = $1', [trip.id])).rows[0]).toEqual({ delay_level: null, delay_episode: 1 });
    expect(await delayAlerts(trip)).toHaveLength(1);

    await lateBy(trip, plus(at, 60), destination!, 30);
    await ping(token, north(0.5), plus(at, 60));
    const alerts = await delayAlerts(trip);
    expect(alerts.map((a) => a.severity)).toEqual(['medium', 'medium']);
    expect((await delayedEvents(trip)).map((e) => e.payload.episode)).toEqual([1, 2]);
  });

  test('a stale position is no delay, and a depot’s own margin replaces the fleet’s', async () => {
    engine.connect();
    const stale = await tripUnderWay();
    const old = new Date(Date.now() - 6 * 60 * SEC);
    await lateBy(stale.trip, old, stale.destination!, 90);
    await ping(stale.token, north(0.5), old);
    expect(await etaEvents(stale.trip)).toEqual([]);
    expect(await delayAlerts(stale.trip)).toEqual([]);

    const patient = await tripUnderWay();
    await pool.query('INSERT INTO tracking.rule_thresholds (depot_id, trip_delay_minutes, trip_delay_urgent_minutes) VALUES ($1, 30, 90)', [patient.depot.id]);
    const at = new Date(Date.now() - 60 * SEC);
    await lateBy(patient.trip, at, patient.destination!, 20);
    await ping(patient.token, north(0.5), at);
    expect(await etaEvents(patient.trip)).toHaveLength(1);
    expect(await delayAlerts(patient.trip)).toEqual([]);
  });

  test('the margins are telemetry rule thresholds: 15 and 60 to start with, the urgent one above the other', async () => {
    const cookie = await signIn(['admin']);
    const fleet = (await request(app).get('/api/v1/settings/telemetry-rules').set('Cookie', cookie)).body.data.fleet;
    expect(fleet).toMatchObject({ trip_delay_minutes: 15, trip_delay_urgent_minutes: 60 });
    const body = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5 };
    const depot = await createDepot();

    const refused = await request(app).put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`).set('Cookie', cookie).send({ ...body, trip_delay_minutes: 60 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: 'trip_delay_urgent_minutes', reason: 'not_above_late' })]);
    const tooLong = await request(app).put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`).set('Cookie', cookie).send({ ...body, trip_delay_minutes: 4 });
    expect(tooLong.status).toBe(400);

    const saved = await request(app)
      .put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`)
      .set('Cookie', cookie)
      .send({ ...body, trip_delay_minutes: 20, trip_delay_urgent_minutes: 45 });
    expect(saved.status).toBe(200);
    expect(saved.body.data.depots.find((d: Row) => d.depot_id === depot.public_id)).toMatchObject({ trip_delay_minutes: 20, trip_delay_urgent_minutes: 45 });
    // Left out, they keep the row's.
    await request(app).put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`).set('Cookie', cookie).send({ ...body, speed_limit_kmh: 70 }).expect(200);
    expect((await pool.query('SELECT trip_delay_minutes, trip_delay_urgent_minutes FROM tracking.rule_thresholds WHERE depot_id = $1', [depot.id])).rows[0]).toEqual({
      trip_delay_minutes: 20,
      trip_delay_urgent_minutes: 45,
    });
  });
});

describe('POST /routes/{id}/optimise (FMS-86)', () => {
  /** A route of the depot through the API, stops along the road north saved at 3, 1 and 2 km. */
  async function shuffledRoute(depot: Row, cookie: string, stops = [3, 1, 2]) {
    const res = await request(app)
      .post('/api/v1/routes')
      .set('Cookie', cookie)
      .send({
        name: `Shuffled ${randomUUID().slice(0, 8)}`,
        depot_id: depot.public_id,
        origin: north(0),
        destination: north(4),
        stops: stops.map((km) => ({ name: `Km ${km}`, ...north(km) })),
      });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  test('suggests the stops in road order, shorter than the saved order and never longer; nothing is saved until PATCH', async () => {
    engine.connect();
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const route = await shuffledRoute(depot, cookie);

    const res = await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(s).toMatchObject({ route_id: route.id, version: route.version, changed: true, order: [1, 2, 0] });
    expect(s.stops.map((x: { name: string }) => x.name)).toEqual(['Km 1', 'Km 2', 'Km 3']);
    expect(s.optimised.distance_km).toBeLessThan(s.original.distance_km);
    expect(s.optimised.distance_km).toBeCloseTo(5, 1); // 4 km of straight road at 1.25
    expect(s.optimised.duration_seconds).toBeLessThan(s.original.duration_seconds);
    expect(engine.calls.at(-1)).toMatch(/^\/table\/v1\/driving\//);

    // Nothing saved yet; saving the suggestion is an ordinary edit.
    const saved = await request(app).get(`/api/v1/routes/${route.id}`).set('Cookie', cookie);
    expect(saved.body.data.stops.map((x: { name: string }) => x.name)).toEqual(['Km 3', 'Km 1', 'Km 2']);
    const patched = await request(app).patch(`/api/v1/routes/${route.id}`).set('Cookie', cookie).set('If-Match', `"${s.version}"`).send({ stops: s.stops });
    expect(patched.status).toBe(200);
    const again = await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', cookie);
    expect(again.body.data).toMatchObject({ changed: false, order: [0, 1, 2] });
    expect(again.body.data.optimised).toEqual(again.body.data.original);
  });

  test('a stop or an end without coordinates is 400; no routing engine is 503', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const route = await shuffledRoute(depot, cookie);
    expect((await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', cookie)).status).toBe(503);

    engine.connect();
    const noCoords = await request(app)
      .patch(`/api/v1/routes/${route.id}`)
      .set('Cookie', cookie)
      .set('If-Match', `"${route.version}"`)
      .send({ stops: [...route.stops, { name: 'Somewhere' }] });
    expect(noCoords.status).toBe(200);
    const bad = await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ field: 'stops', reason: 'stop_without_coordinates' }]);

    const open = await request(app)
      .patch(`/api/v1/routes/${route.id}`)
      .set('Cookie', cookie)
      .set('If-Match', `"${noCoords.body.data.version}"`)
      .send({ destination: null, stops: route.stops });
    expect(open.status).toBe(200);
    const noEnd = await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', cookie);
    expect(noEnd.status).toBe(400);
    expect(noEnd.body.error.details).toEqual([{ field: 'destination', reason: 'route_without_ends' }]);
  });

  test('route:write only, within the depot scope', async () => {
    engine.connect();
    const depot = await createDepot();
    const route = await shuffledRoute(depot, await signIn(['dispatcher'], depot));
    expect((await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', await signIn(['compliance_officer']))).status).toBe(403);
    expect((await request(app).post(`/api/v1/routes/${route.id}/optimise`).set('Cookie', await signIn(['dispatcher'], await createDepot()))).status).toBe(404);
  });
});
