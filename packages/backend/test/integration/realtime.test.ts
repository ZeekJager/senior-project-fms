import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { redis } from '../../src/shared/cache';
import { logger } from '../../src/shared/logging/logger';
import { RedisEventBroadcaster } from '../../src/shared/events/broadcaster';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventChannel } from '../../src/shared/events/event-bus';
import { hashPassword } from '../../src/modules/auth';
import { legacyLocationIngest } from '../../src/modules/integration';
import { attachRealtime, SOCKET_PATH, type LegacyLocation, type RealtimeOptions } from '../../src/modules/realtime';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents } from '../support/events';

type Row = Awaited<ReturnType<typeof createDepot>>;
/** A row's public id. */
const pid = (row: Row) => String(row.public_id);

const app = createApp();
const PASSWORD = 'Realtime-test-pass-1';
const ALLOWED = 'http://localhost:5173';

const open: { close(): Promise<void> }[] = [];
const sockets: ClientSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await Promise.all(open.splice(0).map((o) => o.close()));
});

/** The API with sockets on a free port, as src/server.ts runs it. Without Redis unless given one. */
async function start(options: RealtimeOptions = {}) {
  const server = createServer(createApp());
  const realtime = attachRealtime(server, { redis: null, allowedOrigins: [ALLOWED], ...options });
  open.push(realtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await realtime.ready;
  return { realtime, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function socket(url: string, headers: { cookie?: string; origin?: string } = {}): ClientSocket {
  const s = connect(url, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: headers as Record<string, string> });
  sockets.push(s);
  return s;
}

const connected = (s: ClientSocket) =>
  new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });

const refused = (s: ClientSocket) =>
  new Promise<Error & { data?: { code: string } }>((resolve, reject) => {
    s.once('connect', () => reject(new Error('the socket connected')));
    s.once('connect_error', resolve);
  });

/** Everything a socket receives, by event name. */
function inbox(s: ClientSocket) {
  const got: { event: string; payload: Record<string, unknown>; at: number }[] = [];
  s.onAny((event: string, payload: Record<string, unknown>) => got.push({ event, payload, at: Date.now() }));
  return {
    got,
    of: (event: string) => got.filter((g) => g.event === event),
    async next(event: string, ms = 2000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = got.find((g) => g.event === event);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${event} within ${ms} ms`);
    },
  };
}

/**
 * A connected socket's inbox. Waits for the handshake: each test runs in one
 * database transaction, so a handshake still querying must not overlap the
 * next sign-in's transaction.
 */
async function watch(url: string, cookie: string) {
  const s = socket(url, { cookie });
  const box = inbox(s);
  await connected(s);
  return box;
}

const quiet = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Row | null): Promise<{ cookie: string; user: Row }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return { cookie: await login(user.email), user };
}

/** A driver who can sign in. */
async function driverWithLogin(depot: Row) {
  const made = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), made.user.id]);
  return made;
}

const envelope = (type: string, payload: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  occurred_at: new Date().toISOString(),
  actor: null,
  correlation_id: null,
  payload,
});

describe('real-time gateway (FMS-43)', () => {
  test('a socket without a valid session is refused: no cookie, a forged one, a revoked one', async () => {
    const { url } = await start();
    expect((await refused(socket(url))).message).toBe('AUTH_TOKEN_INVALID');
    expect((await refused(socket(url, { cookie: 'fms_access=not.a.jwt' }))).data).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });

    const depot = await createDepot();
    const { cookie } = await signIn(['dispatcher'], depot);
    await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect((await refused(socket(url, { cookie }))).message).toBe('AUTH_TOKEN_REVOKED');
  });

  test('opening and closing a socket is logged, with why it closed: a closed tab says goodbye (FMS-45)', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const { url } = await start();
      const { cookie } = await signIn(['dispatcher'], await createDepot());
      const s = socket(url, { cookie });
      await connected(s);
      const id = s.id;
      // What socket.io-client does on a page unload with closeOnBeforeunload (the web app sets it).
      s.disconnect();
      await quiet(200);
      const logged = info.mock.calls.map(([fields, message]) => ({ fields, message }));
      expect(logged).toContainEqual({ fields: expect.objectContaining({ socket_id: id }), message: 'socket connected' });
      expect(logged).toContainEqual({ fields: expect.objectContaining({ socket_id: id, reason: 'client namespace disconnect' }), message: 'socket disconnected' });
    } finally {
      info.mockRestore();
    }
  });

  test('only the API host and allow-listed origins may open a socket', async () => {
    const { url } = await start();
    const depot = await createDepot();
    const { cookie } = await signIn(['dispatcher'], depot);
    await refused(socket(url, { cookie, origin: 'https://evil.example' }));
    await connected(socket(url, { cookie, origin: ALLOWED }));
    await connected(socket(url, { cookie, origin: url }));
  });

  test("a depot A dispatcher never receives depot B's events; an admin receives both", async () => {
    const { url, realtime } = await start();
    const [a, b] = [await createDepot(), await createDepot()];
    const dispatcherA = await watch(url, (await signIn(['dispatcher'], a)).cookie);
    const dispatcherB = await watch(url, (await signIn(['dispatcher'], b)).cookie);
    const admin = await watch(url, (await signIn(['admin'], null)).cookie);
    await quiet();

    await realtime.gateway.deliver(envelope('VehicleLocationUpdated', { vehicle_id: crypto.randomUUID(), depot_id: pid(b), lat: 9.03, lng: 38.74, speed: 40, heading: 180 }));
    await realtime.gateway.deliver(envelope('VehicleStatusChanged', { vehicle_id: crypto.randomUUID(), depot_id: pid(a), previous_status: 'active', new_status: 'inactive', reason: 'x' }));
    await dispatcherB.next('vehicle.location.updated');
    await admin.next('vehicle_position');
    await dispatcherA.next('vehicle.status.changed');
    await quiet();
    expect(dispatcherA.of('vehicle.location.updated')).toEqual([]);
    expect(dispatcherA.of('vehicle_position')).toEqual([]);
    expect(dispatcherB.of('vehicle.status.changed')).toEqual([]);
    expect(admin.of('vehicle.status.changed')).toHaveLength(1);
  });

  test('a real change reaches the sockets: a status change, through the outbox, to vehicle.status.changed', async () => {
    const { url, realtime } = await start();
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const manager = await signIn(['depot_admin'], depot);
    const watcher = await watch(url, (await signIn(['dispatcher'], depot)).cookie);
    await quiet();

    const res = await request(app).post(`/api/v1/vehicles/${pid(vehicle)}/status`).set('Cookie', manager.cookie).send({ status: 'inactive', reason: 'Waiting for tyres' });
    expect(res.status).toBe(200);
    await deliverEvents({ broadcaster: realtime.localBroadcaster });
    const { payload } = await watcher.next('vehicle.status.changed');
    expect(payload).toMatchObject({ vehicle_id: pid(vehicle), status: 'inactive', previous_status: 'active', reason: 'Waiting for tyres', source: 'manual' });
  });

  test("trip.updated: the trip's depot and its own driver; another driver never", async () => {
    const { url, realtime } = await start();
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const mine = await driverWithLogin(depot);
    const other = await driverWithLogin(depot);
    const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Realtime ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
    const start1 = new Date(Date.now() + 3_600_000);
    const trip = (
      await pool.query<Row>(
        `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end) VALUES ($1, $2, $3, 'assigned', $4, $5) RETURNING public_id`,
        [route.id, vehicle.id, mine.driver.id, start1, new Date(start1.getTime() + 7_200_000)],
      )
    ).rows[0];

    const driver = await watch(url, await login(mine.user.email));
    const stranger = await watch(url, await login(other.user.email));
    const dispatcher = await watch(url, (await signIn(['dispatcher'], depot)).cookie);
    await quiet();

    await realtime.gateway.deliver(envelope('TripAssigned', { trip_id: pid(trip) }));
    const { payload } = await driver.next('trip.updated');
    expect(payload).toMatchObject({ trip_id: pid(trip), status: 'assigned', depot_id: pid(depot), driver_id: pid(mine.driver), vehicle_id: pid(vehicle), change: 'TripAssigned' });
    await dispatcher.next('trip.updated');
    await quiet();
    expect(stranger.of('trip.updated')).toEqual([]);
    // Drivers have no tracking:read: no positions, not even their depot's.
    await realtime.gateway.deliver(envelope('VehicleLocationUpdated', { vehicle_id: pid(vehicle), depot_id: pid(depot), lat: 9, lng: 38 }));
    await dispatcher.next('vehicle.location.updated');
    await quiet();
    expect(driver.of('vehicle.location.updated')).toEqual([]);
  });

  test("a deactivated or changed account's sockets are closed, and the access token's expiry closes them too", async () => {
    const { url, realtime } = await start();
    const depot = await createDepot();
    const { cookie, user } = await signIn(['dispatcher'], depot);
    const s = socket(url, { cookie });
    await connected(s);
    const closed = new Promise<string>((resolve) => s.once('disconnect', resolve));
    await realtime.gateway.deliver(envelope('UserDeactivated', { user_id: pid(user) }));
    expect(await closed).toBe('io server disconnect');

    // A gateway whose clock is 300 ms before the token's 15 minutes are up.
    const late = await start({ now: () => Date.now() + 15 * 60_000 - 300 });
    const t = socket(late.url, { cookie });
    // Listening first: the token may have under 300 ms left by the time the handshake ends.
    const expired = new Promise<string>((resolve) => t.once('disconnect', resolve));
    await connected(t);
    expect(await expired).toBe('io server disconnect');
  });

  test('client -> server: the legacy location_update is off unless enabled, validated, and rate limited', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['dispatcher'], depot);
    const ask = (s: ClientSocket, body: unknown) => s.timeout(2000).emitWithAck('location_update', body) as Promise<{ ok: boolean; error?: { code: string } }>;
    const location = { tripId: crypto.randomUUID(), lat: 9.03, lng: 38.74, speedKmh: 40 };

    const off = await start();
    const s = socket(off.url, { cookie });
    await connected(s);
    expect(await ask(s, location)).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });

    const received: LegacyLocation[] = [];
    const on = await start({ legacyLocation: { enabled: true, ingest: async (_who, l) => void received.push(l) } });
    const t = socket(on.url, { cookie });
    await connected(t);
    expect(await ask(t, { ...location, lat: 120 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await ask(t, location)).toEqual({ ok: true });
    expect(received).toEqual([location]);

    // 5 at once, then 1 a second: a flood is refused, and a socket that keeps at it is dropped.
    const dropped = new Promise<string>((resolve) => t.once('disconnect', resolve));
    const answers = await Promise.all(Array.from({ length: 25 }, () => ask(t, location).catch(() => ({ ok: false, error: { code: 'NO_ANSWER' } }))));
    expect(answers.filter((a) => a.error?.code === 'RATE_LIMITED').length).toBeGreaterThan(10);
    expect(await dropped).toBe('io server disconnect');
  });

  test("the legacy location_update goes into GPS ingestion (FMS-88): stored for the driver's trip under way, refused for another", async () => {
    const { url } = await start({ legacyLocation: { enabled: true, ingest: legacyLocationIngest } });
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const made = await driverWithLogin(depot);
    const since = new Date(Date.now() - 60_000);
    const trip = await createTrip({ vehicle, driver: made.driver, status: 'en_route', actual_start: since, scheduled_start: since });
    const s = socket(url, { cookie: await login(made.user.email) });
    await connected(s);
    const ask = (body: unknown) => s.timeout(2000).emitWithAck('location_update', body) as Promise<{ ok: boolean; error?: { code: string } }>;

    expect(await ask({ tripId: pid(trip), lat: 9.03, lng: 38.74, speedKmh: 40.6, bearing: 180 })).toEqual({ ok: true });
    const stored = await pool.query('SELECT trip_id, source, speed_kmh FROM tracking.gps_pings WHERE vehicle_id = $1', [vehicle.id]);
    expect(stored.rows).toEqual([{ trip_id: trip.id, source: 'phone', speed_kmh: 41 }]);

    expect(await ask({ tripId: crypto.randomUUID(), lat: 9.03, lng: 38.74 })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_INSUFFICIENT_ROLE' } });
  });

  // Needs Redis (CI sets REDIS_HOST; locally, set it): two instances, as in production.
  test.skipIf(!config.redis)('an event published from instance A reaches a client on instance B, once, within 500 ms', async () => {
    const instanceA = await start({ redis });
    const instanceB = await start({ redis });
    const depot = await createDepot();
    const { cookie } = await signIn(['dispatcher'], depot);
    const onB = await watch(instanceB.url, cookie);
    const onA = await watch(instanceA.url, cookie);
    await quiet(300);

    // What the outbox relay on instance A does after a commit.
    const event = createEvent('VehicleStatusChanged', { vehicle_id: crypto.randomUUID(), depot_id: pid(depot), previous_status: 'active', new_status: 'maintenance', reason: 'x' }, { actor: null, correlationId: 'realtime-test' });
    const sent = Date.now();
    await new RedisEventBroadcaster(redis!, eventChannel).publish(event);
    const hit = await onB.next('vehicle.status.changed', 1000);
    expect(hit.at - sent).toBeLessThan(500);
    await onA.next('vehicle.status.changed', 1000);
    await quiet(300);
    expect(onB.of('vehicle.status.changed')).toHaveLength(1);
    expect(onA.of('vehicle.status.changed')).toHaveLength(1);
  });
});
