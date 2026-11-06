import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, TRACKING_EVENTS, gpsDevices, signWebhook } from '../../src/modules/integration';
import { signedDeliveries, type ProviderPosition } from '../../scripts/simulator/delivery';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createProvider, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-138: the telematics provider slot. The GPS simulator's provider (migration 061) posts signed webhooks to the
// path a real provider uses; the device registry links its device ids to vehicles; the status shows today's traffic.

const app = createApp();
const PASSWORD = 'Device-Test-1';
const SIMULATOR = 'fms-simulator';
const SECRET = process.env.INTEGRATION_FMS_SIMULATOR_WEBHOOK_SECRET!;
type Row = Record<string, unknown> & { id: string };

function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}

async function signIn(roles: RoleName[] = ['admin'], depot: Row | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  return {
    user,
    get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
    delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
  };
}

/** The simulator's provider, switched on as the simulator does (it is added switched off). */
async function simulatorProvider(): Promise<Row> {
  const res = await pool.query("UPDATE integration.external_providers SET is_active = TRUE WHERE code = $1 RETURNING *", [SIMULATOR]);
  return res.rows[0];
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const position = (deviceId: string, extra: Partial<ProviderPosition> = {}): ProviderPosition => ({
  device_id: deviceId,
  recorded_at: ago(5_000),
  lat: 9.0108,
  lng: 38.7613,
  speed_kmh: 41.6,
  ...extra,
});

/** Posts the positions exactly as the simulator does, then lets the consumer run. */
async function simulate(positions: ProviderPosition[]) {
  const responses = [];
  for (const d of signedDeliveries(SECRET, positions)) {
    responses.push(await request(app).post(`/api/v1/webhooks/telematics/${SIMULATOR}`).set(d.headers).send(d.raw));
  }
  await deliverEvents();
  return responses;
}

const pingsOf = async (vehicle: Row) =>
  (await pool.query('SELECT speed_kmh, source, gps_device_id FROM tracking.gps_pings WHERE vehicle_id = $1 ORDER BY recorded_at', [vehicle.id])).rows;

const providerStatus = async (admin: Awaited<ReturnType<typeof signIn>>, code = SIMULATOR) => {
  const res = await admin.get('/integrations/providers');
  expect(res.status).toBe(200);
  expectContract(res, 'get', '/integrations/providers');
  return res.body.data.find((p: { code: string }) => p.code === code);
};

describe('the simulator through the provider slot', () => {
  test('a device linked in the registry: the simulator’s signed webhook lands as pings on the vehicle, and the status counts it', async () => {
    const admin = await signIn();
    const provider = await simulatorProvider();
    const vehicle = await createVehicle({ depot: await createDepot() });

    const linked = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'SIM-0001', vehicle_id: vehicle.public_id, device_model: 'Teltonika FMB920' });
    expect(linked.status).toBe(201);
    expectContract(linked, 'post', '/integrations/devices');
    expect(linked.body.data).toMatchObject({
      device_identifier: 'SIM-0001',
      device_model: 'Teltonika FMB920',
      provider: { id: provider.public_id, code: SIMULATOR },
      credential: 'provider',
      vehicle: { id: vehicle.public_id, registration_number: vehicle.registration_number },
      status: 'active',
      last_seen_at: null,
      last_error: null,
    });

    const [answer] = await simulate([position('SIM-0001')]);
    expect(answer.status).toBe(202);
    expect(await pingsOf(vehicle)).toEqual([expect.objectContaining({ speed_kmh: 42, source: 'telematics' })]);
    // On the live map: the vehicle's position is announced.
    expect((await publishedEvents(TRACKING_EVENTS.locationUpdated)).filter((e) => e.payload.vehicle_id === vehicle.public_id)).toHaveLength(1);

    const list = await admin.get(`/integrations/devices?provider_id=${provider.public_id}`);
    expectContract(list, 'get', '/integrations/devices');
    expect(list.body.data).toEqual([expect.objectContaining({ device_identifier: 'SIM-0001', last_seen_at: expect.any(String) })]);
    expect(await providerStatus(admin)).toMatchObject({
      is_active: true,
      webhook_secret_configured: true,
      last_delivery_at: expect.any(String),
      today: { deliveries: 1, deliveries_rejected: 0, positions_accepted: 1, positions_rejected: 0 },
      devices: { linked: 1, unknown: 0 },
      circuit: null,
    });

    // The link is audited with who made it.
    const audit = await pool.query("SELECT action, user_id FROM audit.audit_logs WHERE entity_type = 'integration.gps_devices' AND correlation_id = $1", [linked.headers['x-request-id']]);
    expect(audit.rows).toEqual([{ action: 'INSERT', user_id: admin.user.id }]);
  });

  test('an unlinked device is refused and counted, listed as unknown, and lands once linked', async () => {
    const admin = await signIn();
    const provider = await simulatorProvider();
    const vehicle = await createVehicle({ depot: await createDepot() });

    await simulate([position('GT-NEW', { recorded_at: ago(9_000) }), position('GT-NEW', { recorded_at: ago(8_000) }), position('GT-OTHER')]);
    expect(await pingsOf(vehicle)).toEqual([]);
    expect(await providerStatus(admin)).toMatchObject({ today: { deliveries: 1, positions_accepted: 0, positions_rejected: 3 }, devices: { linked: 0, unknown: 2 } });
    const unknown = await admin.get('/integrations/devices/unknown');
    expectContract(unknown, 'get', '/integrations/devices/unknown');
    expect(unknown.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: expect.objectContaining({ code: SIMULATOR }), device_identifier: 'GT-NEW', positions: 2 }),
        expect.objectContaining({ device_identifier: 'GT-OTHER', positions: 1 }),
      ]),
    );

    // Linking it from the unknown list: no longer unknown, and its next positions are the vehicle's.
    expect((await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'GT-NEW', vehicle_id: vehicle.public_id })).status).toBe(201);
    expect((await admin.get('/integrations/devices/unknown')).body.data.map((d: { device_identifier: string }) => d.device_identifier)).toEqual(['GT-OTHER']);
    await simulate([position('GT-NEW', { recorded_at: ago(1_000) })]);
    expect(await pingsOf(vehicle)).toHaveLength(1);
  });

  test('a delivery with a wrong signature or a replayed one is refused, counted, and stores nothing', async () => {
    const admin = await signIn();
    await simulatorProvider();
    const [good] = signedDeliveries(SECRET, [position('SIM-X')]);
    const forged = await request(app)
      .post(`/api/v1/webhooks/telematics/${SIMULATOR}`)
      .set({ ...good.headers, [SIGNATURE_HEADER]: signWebhook('not-the-simulator-secret-at-all-0000', Number(good.headers[TIMESTAMP_HEADER]), good.raw) })
      .send(good.raw);
    expect(forged.status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 600;
    const replayed = await request(app)
      .post(`/api/v1/webhooks/telematics/${SIMULATOR}`)
      .set({ ...good.headers, [TIMESTAMP_HEADER]: String(old), [SIGNATURE_HEADER]: signWebhook(SECRET, old, good.raw) })
      .send(good.raw);
    expect(replayed.status).toBe(401);
    expect(await providerStatus(admin)).toMatchObject({ last_delivery_at: null, today: { deliveries: 0, deliveries_rejected: 2, positions_accepted: 0, positions_rejected: 0 } });
  });

  test('switched off (as migration 061 adds it), the simulator’s webhook URL answers 404', async () => {
    await pool.query('UPDATE integration.external_providers SET is_active = FALSE WHERE code = $1', [SIMULATOR]);
    const [d] = signedDeliveries(SECRET, [position('SIM-0001')]);
    expect((await request(app).post(`/api/v1/webhooks/telematics/${SIMULATOR}`).set(d.headers).send(d.raw)).status).toBe(404);
  });
});

describe('the device registry', () => {
  test('a vehicle with a device is refused another unless replace; another provider’s id, a non-telematics provider and a retired vehicle are refused', async () => {
    const admin = await signIn();
    const provider = await simulatorProvider();
    const other = await createProvider({ code: 'other-telematics', name: 'Other telematics' });
    const weather = await createProvider({ code: 'weather-x', name: 'Weather', provider_type: 'weather' });
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const first = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI-1', vehicle_id: vehicle.public_id });

    const clash = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI-2', vehicle_id: vehicle.public_id });
    expect(clash.status).toBe(409);
    expectContract(clash, 'post', '/integrations/devices');
    expect(clash.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_has_device', record_id: first.body.data.id }]);
    const replaced = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI-2', vehicle_id: vehicle.public_id, replace: true });
    expect(replaced.status).toBe(201);
    const all = (await admin.get('/integrations/devices')).body.data.filter((d: { vehicle: { id: string } }) => d.vehicle.id === vehicle.public_id);
    expect(all.map((d: { device_identifier: string; status: string }) => [d.device_identifier, d.status])).toEqual([
      ['IMEI-2', 'active'],
      ['IMEI-1', 'removed'],
    ]);

    // Moving a device to another vehicle keeps its record: the same id, active on the new vehicle.
    const second = await createVehicle({ depot });
    const moved = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI-1', vehicle_id: second.public_id });
    expect(moved.body.data).toMatchObject({ id: first.body.data.id, status: 'active', vehicle: { id: second.public_id } });

    const taken = await admin.post('/integrations/devices', { provider_id: other.public_id, device_identifier: 'IMEI-1', vehicle_id: (await createVehicle({ depot })).public_id });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details).toEqual([{ field: 'device_identifier', reason: 'already_exists' }]);
    const notTelematics = await admin.post('/integrations/devices', { provider_id: weather.public_id, device_identifier: 'W-1', vehicle_id: second.public_id });
    expect(notTelematics.status).toBe(400);
    expect(notTelematics.body.error.details).toEqual([{ field: 'provider_id', reason: 'not_telematics' }]);
    const retired = await createVehicle({ depot, is_active: false, status: 'retired' });
    const toRetired = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI-9', vehicle_id: retired.public_id });
    expect(toRetired.status).toBe(400);
    expect(toRetired.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_retired' }]);
    const spaced = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'IMEI 9', vehicle_id: second.public_id });
    expect(spaced.status).toBe(400);
    expectContract(spaced, 'post', '/integrations/devices');
  });

  test('unlinking: audited, the device kept as removed, its positions refused from then on; again changes nothing', async () => {
    const admin = await signIn();
    const provider = await simulatorProvider();
    const vehicle = await createVehicle({ depot: await createDepot() });
    const linked = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'UNL-1', vehicle_id: vehicle.public_id });

    const unlinked = await admin.delete(`/integrations/devices/${linked.body.data.id}`);
    expect(unlinked.status).toBe(204);
    expectContract(unlinked, 'delete', '/integrations/devices/{device_id}');
    const audit = await pool.query("SELECT action, user_id FROM audit.audit_logs WHERE entity_type = 'integration.gps_devices' AND correlation_id = $1", [unlinked.headers['x-request-id']]);
    expect(audit.rows).toEqual([{ action: 'UPDATE', user_id: admin.user.id }]);
    expect((await admin.get('/integrations/devices?status=removed')).body.data).toEqual([expect.objectContaining({ device_identifier: 'UNL-1', status: 'removed', removed_at: expect.any(String) })]);
    expect((await admin.get('/integrations/devices?status=active')).body.data).toEqual([]);

    await simulate([position('UNL-1')]);
    expect(await pingsOf(vehicle)).toEqual([]);
    expect(await providerStatus(admin)).toMatchObject({ today: { positions_rejected: 1 }, devices: { linked: 0, unknown: 1 } });

    expect((await admin.delete(`/integrations/devices/${linked.body.data.id}`)).status).toBe(204);
    const missing = await admin.delete('/integrations/devices/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expectContract(missing, 'delete', '/integrations/devices/{device_id}');
  });

  test('a linked device’s refused position is its last error', async () => {
    const admin = await signIn();
    const provider = await simulatorProvider();
    const vehicle = await createVehicle({ depot: await createDepot() });
    await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'OLD-1', vehicle_id: vehicle.public_id });
    await simulate([position('OLD-1', { recorded_at: ago(8 * 24 * 3600_000) })]);
    const [device] = (await admin.get('/integrations/devices')).body.data;
    expect(device).toMatchObject({ device_identifier: 'OLD-1', last_seen_at: null, last_error: { reason: 'too_old', at: expect.any(String) } });
  });

  test('token devices are listed too, never their token; a fleet manager (every depot) links; a dispatcher may not', async () => {
    const provider = await simulatorProvider();
    const mine = await createDepot();
    const own = await createVehicle({ depot: mine });
    const foreign = await createVehicle({ depot: await createDepot() });
    const { token } = await gpsDevices.register({ vehicleId: own.public_id as string, identifier: 'TOKEN-1' }, { userId: null, correlationId: 'c0ffee00-0000-4000-8000-000000000001' });

    const manager = await signIn(['fleet_manager'], mine);
    expect((await manager.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'MGR-1', vehicle_id: foreign.public_id })).status).toBe(201);
    const seen = await manager.get('/integrations/devices');
    expect(seen.status).toBe(200);
    expect(seen.body.data).toEqual([
      expect.objectContaining({ device_identifier: 'MGR-1', credential: 'provider' }),
      expect.objectContaining({ device_identifier: 'TOKEN-1', credential: 'token', provider: null }),
    ]);
    expect(JSON.stringify(seen.body)).not.toContain(token);
    expect(JSON.stringify(seen.body)).not.toMatch(/token_hash/);

    const dispatcher = await signIn(['dispatcher'], mine);
    const refused = await dispatcher.get('/integrations/devices');
    expect(refused.status).toBe(403);
    expectContract(refused, 'get', '/integrations/devices');
    expect((await dispatcher.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: 'D-1', vehicle_id: own.public_id })).status).toBe(403);
  });
});
