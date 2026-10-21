import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, TRACKING_EVENTS, gpsDevices, signWebhook } from '../../src/modules/integration';
import { createDepot, createDriver, createProvider, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-88: positions from devices, drivers' phones, users and telematics webhooks into tracking.gps_pings.

const app = createApp();
const PASSWORD = 'Gps-Test-1';
const ctx = () => ({ userId: null, correlationId: randomUUID() });
type Row = Record<string, unknown> & { id: string };

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}
const signIn = async (roles: RoleName[]) => login((await createUser({ roles, password: PASSWORD })).email as string);

/** A vehicle with a device installed, and the device's token. */
async function withDevice(depot?: Row) {
  const vehicle = await createVehicle({ depot: depot ?? (await createDepot()) });
  const { deviceId, token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, ctx());
  return { vehicle, deviceId, token };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ping = (offsetMs = 0, extra: Record<string, unknown> = {}) => ({ recorded_at: ago(-offsetMs), lat: 9.0108, lng: 38.7613, speed_kmh: 42.6, heading: 90, accuracy_m: 6, ...extra });
const postPings = (pings: unknown[], auth: { token?: string; cookie?: string }) => {
  const req = request(app).post('/api/v1/tracking/gps-pings');
  if (auth.token) req.set('Authorization', `Bearer ${auth.token}`);
  if (auth.cookie) req.set('Cookie', auth.cookie);
  return req.send({ pings });
};
const pingsOf = async (vehicle: Row) =>
  (
    await pool.query(
      'SELECT speed_kmh, source, trip_id, gps_device_id, recorded_at FROM tracking.gps_pings WHERE vehicle_id = $1 ORDER BY recorded_at',
      [vehicle.id],
    )
  ).rows;
const locationEvents = async (vehicle: Row) => (await publishedEvents(TRACKING_EVENTS.locationUpdated)).filter((e) => e.payload.vehicle_id === vehicle.public_id);

describe('POST /tracking/gps-pings from a device', () => {
  test('stores the batch for its vehicle, with whole km/h, and moves the current location', async () => {
    const { vehicle, token } = await withDevice();
    const batch = [ping(-20_000), ping(-10_000), ping(0, { lat: 9.02, lng: 38.77, speed_kmh: 30.4 })];
    const res = await postPings(batch, { token });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accepted: 3, duplicates: 0, rejected: [] });

    const rows = await pingsOf(vehicle);
    expect(rows.map((r) => [r.speed_kmh, r.source])).toEqual([
      [43, 'device'],
      [43, 'device'],
      [30, 'device'],
    ]);
    const current = await pool.query('SELECT latitude::float8 AS lat, longitude::float8 AS lng, speed_kmh FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id]);
    expect(current.rows).toEqual([{ lat: 9.02, lng: 38.77, speed_kmh: 30 }]);
    const device = await pool.query('SELECT last_seen_at FROM integration.gps_devices WHERE vehicle_id = $1', [vehicle.id]);
    expect(device.rows[0].last_seen_at).not.toBeNull();

    // One audit entry for the batch, as machine traffic.
    const audit = await pool.query(
      "SELECT action, user_id, details, request_source->>'channel' AS channel FROM audit.audit_logs WHERE correlation_id = $1",
      [res.headers['x-request-id']],
    );
    expect(audit.rows).toEqual([
      { action: 'tracking.pings_ingested', user_id: null, channel: 'webhook', details: expect.objectContaining({ source: 'device', received: 3, accepted: 3, duplicates: 0, rejected: 0 }) },
    ]);
  });

  test('a retried batch inserts no duplicates and announces nothing again', async () => {
    const { vehicle, token } = await withDevice();
    const batch = [ping(-10_000), ping(0)];
    await postPings(batch, { token });
    const events = (await locationEvents(vehicle)).length;

    const retry = await postPings(batch, { token });
    expect(retry.status).toBe(202);
    expect(retry.body.data).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    expect(await pingsOf(vehicle)).toHaveLength(2);
    expect(await locationEvents(vehicle)).toHaveLength(events);
  });

  test('a device reporting for another vehicle gets 403, and nothing of the batch is stored', async () => {
    const { vehicle, token } = await withDevice();
    const other = await createVehicle({ depot: await createDepot() });
    const res = await postPings([ping(-5_000), ping(0, { vehicle_id: other.public_id })], { token });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN_INSUFFICIENT_ROLE', details: [{ field: 'vehicle_id', reason: 'not_your_vehicle' }] });
    expect(await pingsOf(vehicle)).toEqual([]);
    expect(await pingsOf(other)).toEqual([]);
    // Naming its own vehicle is fine.
    expect((await postPings([ping(0, { vehicle_id: vehicle.public_id })], { token })).status).toBe(202);
  });

  test('refuses an unknown token, and a request with no credentials', async () => {
    const res = await postPings([ping()], { token: 'fmsd_not-a-real-token' });
    expect([res.status, res.body.error.code]).toEqual([401, 'AUTH_TOKEN_INVALID']);
    expect((await postPings([ping()], {})).status).toBe(401);
  });

  test('refuses single pings it cannot use and keeps the rest', async () => {
    const { vehicle, token } = await withDevice();
    const res = await postPings([ping(-1_000), ping(10 * 60_000), ping(0, { accuracy_m: 900 }), ping(-8 * 24 * 3_600_000)], { token });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        { index: 1, reason: 'future_timestamp' },
        { index: 2, reason: 'low_accuracy' },
        { index: 3, reason: 'too_old' },
      ],
    });
    expect(await pingsOf(vehicle)).toHaveLength(1);

    await pool.query('UPDATE fleet.vehicles SET is_active = FALSE WHERE id = $1', [vehicle.id]);
    expect((await postPings([ping(5_000)], { token })).body.data.rejected).toEqual([{ index: 0, reason: 'vehicle_retired' }]);
  });

  test('a batch out of range is refused whole, naming the field', async () => {
    const { token } = await withDevice();
    const res = await postPings([ping(), ping(0, { lat: 91 })], { token });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'pings.1.lat', reason: 'too_big' }]);
    expect((await postPings([], { token })).status).toBe(400);
  });

  test("stores the vehicle's trip under way with each ping", async () => {
    const depot = await createDepot();
    const { vehicle, token } = await withDevice(depot);
    const { driver } = await createDriver({ depot });
    const trip = await createTrip({ vehicle, driver, status: 'en_route', actual_start: ago(30 * 60_000), scheduled_start: ago(30 * 60_000) });
    await postPings([ping()], { token });
    expect((await pingsOf(vehicle))[0].trip_id).toBe(trip.id);
  });
});

describe('VehicleLocationUpdated', () => {
  test("announces each vehicle's newest position at most once per 5 s of its pings, as the real-time gateway reads it", async () => {
    const depot = await createDepot();
    const { vehicle, token } = await withDevice(depot);
    await postPings([ping(-12_000), ping(-8_000), ping(-4_000, { lat: 9.03, speed_kmh: 55 })], { token });
    let events = await locationEvents(vehicle);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregate: `vehicle:${vehicle.public_id}`,
      payload: { vehicle_id: vehicle.public_id, depot_id: depot.public_id, trip_id: null, lat: 9.03, lng: 38.7613, speed: 55, heading: 90 },
    });

    await postPings([ping(-2_000)], { token }); // 2 s later: too soon
    expect(await locationEvents(vehicle)).toHaveLength(1);
    await postPings([ping(2_000)], { token }); // 6 s after the one announced
    events = await locationEvents(vehicle);
    expect(events).toHaveLength(2);

    // A late ping (older than the current position) is stored but announces nothing.
    await postPings([ping(-60_000)], { token });
    expect(await locationEvents(vehicle)).toHaveLength(2);
  });
});

describe("a driver's phone", () => {
  async function driverOnTrip(status: 'en_route' | 'assigned') {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { user, driver } = await createDriver({ depot });
    await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
    const trip = await createTrip({ vehicle, driver, status, ...(status === 'en_route' ? { actual_start: ago(60_000), scheduled_start: ago(60_000) } : {}) });
    return { vehicle, trip, cookie: await login(user.email as string) };
  }

  test('reports for the vehicle of its trip under way, without naming it', async () => {
    const { vehicle, trip, cookie } = await driverOnTrip('en_route');
    const res = await postPings([ping()], { cookie });
    expect(res.status).toBe(202);
    expect(await pingsOf(vehicle)).toEqual([expect.objectContaining({ source: 'phone', trip_id: trip.id, gps_device_id: null })]);
  });

  test('gets 403 for another vehicle, or with no trip under way', async () => {
    const onTrip = await driverOnTrip('en_route');
    const other = await createVehicle({ depot: await createDepot() });
    const res = await postPings([ping(0, { vehicle_id: other.public_id })], { cookie: onTrip.cookie });
    expect([res.status, res.body.error.details[0].reason]).toEqual([403, 'not_your_vehicle']);

    const waiting = await driverOnTrip('assigned');
    const idle = await postPings([ping()], { cookie: waiting.cookie });
    expect([idle.status, idle.body.error.details[0].reason]).toEqual([403, 'no_trip_under_way']);
    expect(await pingsOf(waiting.vehicle)).toEqual([]);
  });
});

describe('a user with tracking:ingest', () => {
  test('names the vehicle of each ping; an unknown one is refused alone', async () => {
    const cookie = await signIn(['admin']);
    const vehicle = await createVehicle({ depot: await createDepot() });
    const missing = await postPings([ping()], { cookie });
    expect([missing.status, missing.body.error.details]).toEqual([400, [{ field: 'pings.0.vehicle_id', reason: 'required' }]]);

    const res = await postPings([ping(0, { vehicle_id: vehicle.public_id }), ping(0, { vehicle_id: randomUUID() })], { cookie });
    expect(res.body.data).toEqual({ accepted: 1, duplicates: 0, rejected: [{ index: 1, reason: 'unknown_vehicle' }] });
    expect(await pingsOf(vehicle)).toEqual([expect.objectContaining({ source: 'api' })]);
  });

  test('without tracking:ingest or trip:execute, 403', async () => {
    const res = await postPings([ping()], { cookie: await signIn(['technician']) });
    expect(res.status).toBe(403);
  });
});

describe('the telematics webhook', () => {
  const SECRET = process.env.INTEGRATION_MOCK_TELEMATICS_WEBHOOK_SECRET!;
  function deliver(body: unknown) {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return request(app)
      .post('/api/v1/webhooks/telematics/mock-telematics')
      .set('Content-Type', 'application/json')
      .set(TIMESTAMP_HEADER, String(ts))
      .set(SIGNATURE_HEADER, signWebhook(SECRET, ts, raw))
      .send(raw);
  }

  test("stores a provider's positions for its own devices' vehicles, once", async () => {
    // No adapter is registered for this code here: telematics providers get the FMS telematics format.
    const provider = await createProvider({ code: 'mock-telematics' });
    const vehicle = await createVehicle({ depot: await createDepot() });
    await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: 'GT-1001', providerId: provider.id }, ctx());
    const positions = [
      { device_id: 'GT-1001', recorded_at: ago(5_000), lat: 9.01, lng: 38.76, speed_kmh: 64.7 },
      { device_id: 'GT-UNKNOWN', recorded_at: ago(5_000), lat: 9.02, lng: 38.77, speed_kmh: 10 },
    ];

    const res = await deliver({ event_id: 'batch-1', positions });
    expect(res.status).toBe(202);
    expect(await pingsOf(vehicle)).toEqual([]); // processed after the receipt commits
    await deliverEvents();
    expect(await pingsOf(vehicle)).toEqual([expect.objectContaining({ speed_kmh: 65, source: 'telematics' })]);
    expect(await locationEvents(vehicle)).toHaveLength(1);

    // The same positions under another delivery id: the pings' own key makes them a no-op.
    expect((await deliver({ event_id: 'batch-2', positions })).status).toBe(202);
    await deliverEvents();
    expect(await pingsOf(vehicle)).toHaveLength(1);
  });

  test("another provider's device identifiers are not this provider's", async () => {
    const provider = await createProvider({ code: 'mock-telematics' });
    const otherProvider = await createProvider({ code: 'other-telematics' });
    const vehicle = await createVehicle({ depot: await createDepot() });
    await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: 'OT-1', providerId: otherProvider.id }, ctx());
    expect(provider.id).not.toBe(otherProvider.id);
    await deliver({ event_id: 'batch-x', positions: [{ device_id: 'OT-1', recorded_at: ago(1_000), lat: 9, lng: 38, speed_kmh: 5 }] });
    await deliverEvents();
    expect(await pingsOf(vehicle)).toEqual([]);
  });
});

describe('device registration', () => {
  test('a new token for the same device stops the old one; a second device in the vehicle replaces the first', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    const first = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: 'TR-1' }, ctx());
    const again = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: 'TR-1' }, ctx());
    expect(again.deviceId).toBe(first.deviceId);
    expect((await postPings([ping()], { token: first.token })).status).toBe(401);
    expect((await postPings([ping()], { token: again.token })).status).toBe(202);

    const replacement = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: 'TR-2' }, ctx());
    expect((await postPings([ping(1_000)], { token: again.token })).status).toBe(401);
    expect((await postPings([ping(2_000)], { token: replacement.token })).status).toBe(202);
    const stored = await pool.query("SELECT token_hash FROM integration.gps_devices WHERE device_identifier = 'TR-2'");
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(replacement.token);
  });
});
