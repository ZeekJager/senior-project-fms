import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { SIMULATED_PROVIDER, evDelivery, signEvDelivery, type SimSession } from '../../scripts/simulator/ev-charging';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { EV_EVENTS } from '../../src/modules/ev';
import type { EvChargingDelivery, EvSessionKind } from '../../src/modules/integration';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-97 (docs/ev.md#synthetic-data): the simulated charging provider's signed webhooks become charging sessions
// through the EV module, never twice; synthetic records say so.

const app = createApp();
const PASSWORD = 'Ev-Test-1';
const SECRET = process.env.INTEGRATION_SIMULATED_WEBHOOK_SECRET!;
type Row = Record<string, unknown> & { id: string };

function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}

async function signIn(roles: RoleName[] = ['fleet_manager']) {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  return {
    get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  };
}

/** The simulated provider, switched on as the simulator does (migration 084 adds it switched off), with a station. */
async function simulatedNetwork(): Promise<{ provider: Row; station: Row }> {
  const provider = (await pool.query("UPDATE integration.external_providers SET is_active = TRUE WHERE code = $1 RETURNING *", [SIMULATED_PROVIDER])).rows[0];
  const station = (
    await pool.query(
      "INSERT INTO ev.charging_stations (provider_id, external_station_id, name, latitude, longitude, connector_type, power_kw, source) VALUES ($1, 'SIM-ST-01', 'Bole Airport charging hub', 8.9897, 38.7887, 'CCS2', 120, 'synthetic') RETURNING *",
      [provider.id],
    )
  ).rows[0];
  return { provider, station };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function session(vehicle: Record<string, unknown>, extra: Partial<SimSession> = {}): SimSession {
  return { session_id: `sim-s-${Math.random().toString(36).slice(2)}`, vehicle_id: vehicle.public_id as string, station_id: 'SIM-ST-01', started_at: ago(20 * 60_000), start_soc: 18, ...extra };
}

const done = (s: SimSession): SimSession => ({ ...s, ended_at: ago(60_000), end_soc: 80, energy_kwh: 41.2, cost_cents: 59_740 });

/** Posts a delivery exactly as the simulator does. */
async function post(body: EvChargingDelivery) {
  const signed = signEvDelivery(SECRET, body);
  return request(app).post(`/api/v1/webhooks/ev/${SIMULATED_PROVIDER}`).set(signed.headers).send(signed.raw);
}

const deliver = (kind: EvSessionKind, s: SimSession, eventId?: string) => post(evDelivery(kind, s, new Date(), eventId));

const sessionsOf = async (externalId: string) =>
  (await pool.query('SELECT status, source, energy_kwh::float8 AS energy_kwh, cost_cents, start_soc::float8 AS start_soc, end_soc::float8 AS end_soc, station_id, started_at, ended_at FROM ev.charging_sessions WHERE external_session_id = $1', [externalId])).rows;

const ev = async () => createVehicle({ depot: await createDepot(), fuel_type: 'electric', vehicle_type: 'van' });

describe('the simulated charging provider (FMS-97)', () => {
  test('a session it reports appears on the vehicle within 5 seconds, synthetic, at its station; then completes', async () => {
    const { station } = await simulatedNetwork();
    const vehicle = await ev();
    const manager = await signIn();
    const s = session(vehicle);

    const started = Date.now();
    const res = await deliver('session_started', s);
    expect(res.status).toBe(202);
    expectContract(res, 'post', '/webhooks/ev/{provider}');
    await deliverEvents();
    const list = await manager.get(`/vehicles/${vehicle.public_id}/charging-sessions`);
    // The card: the simulated provider's sessions appear in the EV dashboard within 5 seconds. The relay delivers
    // every 200 ms when idle (docs/events.md); here it runs at once, so this bounds the API's own part.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(list.status).toBe(200);
    expectContract(list, 'get', '/vehicles/{vehicle_id}/charging-sessions');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      external_session_id: s.session_id,
      status: 'in_progress',
      source: 'synthetic',
      station: { id: station.public_id, name: 'Bole Airport charging hub' },
      start_soc: 18,
    });

    expect((await deliver('session_completed', done(s))).status).toBe(202);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ status: 'completed', source: 'synthetic', energy_kwh: 41.2, cost_cents: 59_740, end_soc: 80 }]);
    const events = await publishedEvents(EV_EVENTS.sessionStarted, EV_EVENTS.sessionCompleted);
    expect(events.map((e) => [e.type, e.actor, e.payload.source])).toEqual([
      [EV_EVENTS.sessionStarted, null, 'synthetic'],
      [EV_EVENTS.sessionCompleted, null, 'synthetic'],
    ]);
    // Audited with no user, as the receipt is.
    const audit = await pool.query("SELECT action, user_id FROM audit.audit_logs WHERE entity_type = 'ev.charging_sessions' ORDER BY id");
    expect(audit.rows).toEqual([{ action: 'INSERT', user_id: null }, { action: 'UPDATE', user_id: null }]);
  });

  test('a duplicate delivery (the same event id) creates no second session', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const s = session(vehicle);
    const body = evDelivery('session_started', s, new Date(), 'sim-e-dup');
    expect((await post(body)).status).toBe(202);
    const again = await post(body);
    expect(again.status).toBe(202);
    expect(again.body.data.duplicate).toBe(true);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toHaveLength(1);
    expect(await publishedEvents(EV_EVENTS.sessionStarted)).toHaveLength(1);
  });

  test('a replay under a new event id, and a start arriving after the end, change nothing', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const s = session(vehicle);
    await deliver('session_started', s);
    await deliver('session_started', s);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ status: 'in_progress' }]);
    expect(await publishedEvents(EV_EVENTS.sessionStarted)).toHaveLength(1);

    await deliver('session_completed', done(s));
    await deliver('session_completed', done(s));
    await deliver('session_started', s);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ status: 'completed', end_soc: 80 }]);
    expect(await publishedEvents(EV_EVENTS.sessionCompleted)).toHaveLength(1);
    // Every delivery was received and logged; the consumer settled each one.
    const pending = await pool.query("SELECT count(*)::int AS n FROM events.outbox WHERE event_type = 'IntegrationWebhookReceived' AND dispatched_at IS NULL");
    expect(pending.rows[0].n).toBe(0);
  });

  test('the end arriving first creates the session completed; its late start is ignored', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const s = session(vehicle);
    await deliver('session_failed', { ...s, ended_at: ago(15 * 60_000), end_soc: 19, energy_kwh: 0.5, cost_cents: 725 });
    await deliverEvents();
    await deliver('session_started', s);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ status: 'failed', start_soc: 18, end_soc: 19 }]);
    expect((await publishedEvents(EV_EVENTS.sessionFailed, EV_EVENTS.sessionStarted)).map((e) => e.type)).toEqual([EV_EVENTS.sessionFailed]);
  });

  test('start and end received before the consumer runs still make one session, completed', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const s = session(vehicle);
    // Both stored before either is applied (a short session, a busy relay): one relay pass handles them in order.
    expect((await deliver('session_started', s)).status).toBe(202);
    expect((await deliver('session_completed', done(s))).status).toBe(202);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ status: 'completed', end_soc: 80 }]);
    expect((await publishedEvents(EV_EVENTS.sessionStarted, EV_EVENTS.sessionCompleted)).map((e) => e.type)).toEqual([EV_EVENTS.sessionStarted, EV_EVENTS.sessionCompleted]);
  });

  test('a session for no vehicle, or a diesel one, is stored as received but makes no session', async () => {
    await simulatedNetwork();
    const diesel = await createVehicle({ depot: await createDepot(), fuel_type: 'diesel' });
    const ghost = session({ public_id: '5d0a8b4e-6f9c-4b0e-9a37-2f1c3e4d5a6b' });
    const wrong = session(diesel);
    expect((await deliver('session_started', ghost)).status).toBe(202);
    expect((await deliver('session_started', wrong)).status).toBe(202);
    await deliverEvents();
    expect(await sessionsOf(ghost.session_id)).toEqual([]);
    expect(await sessionsOf(wrong.session_id)).toEqual([]);
  });

  test('an unknown station leaves the session without one; a body it cannot read is refused naming the field', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const s = session(vehicle, { station_id: 'SIM-ST-99' });
    await deliver('session_started', s);
    await deliverEvents();
    expect(await sessionsOf(s.session_id)).toMatchObject([{ station_id: null }]);

    const bad = await post({ ...evDelivery('session_started', s, new Date()), session: { ...s, start_soc: 140 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([expect.objectContaining({ field: 'session.start_soc' })]);
  });

  test('a delivery not signed with the network’s secret is refused', async () => {
    await simulatedNetwork();
    const vehicle = await ev();
    const body = evDelivery('session_started', session(vehicle), new Date());
    const signed = signEvDelivery('another-secret-that-is-long-enough-000001', body);
    const res = await request(app).post(`/api/v1/webhooks/ev/${SIMULATED_PROVIDER}`).set(signed.headers).send(signed.raw);
    expect(res.status).toBe(401);
  });
});

describe('synthetic records through the EV API (FMS-97)', () => {
  test('a battery log and a session may say they are synthetic, with the energy used per km; provider is the webhook’s', async () => {
    const vehicle = await ev();
    const manager = await signIn();
    const log = await manager.post('/ev/battery-logs', { vehicle_id: vehicle.public_id, state_of_charge: 64, battery_health: 95.5, energy_wh_per_km: 182.4, source: 'synthetic' });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    expectContract(log, 'post', '/ev/battery-logs');
    expect(log.body.data).toMatchObject({ source: 'synthetic', energy_wh_per_km: 182.4 });
    const [logged] = await publishedEvents(EV_EVENTS.batteryLogged);
    expect(logged.payload.source).toBe('synthetic');

    const manual = await manager.post('/ev/battery-logs', { vehicle_id: vehicle.public_id, state_of_charge: 60 });
    expect(manual.body.data).toMatchObject({ source: 'manual', energy_wh_per_km: null });
    const refused = await manager.post('/ev/battery-logs', { vehicle_id: vehicle.public_id, state_of_charge: 60, source: 'provider' });
    expect(refused.status).toBe(400);

    const created = await manager.post('/ev/charging-sessions', { vehicle_id: vehicle.public_id, status: 'in_progress', start_soc: 20, source: 'synthetic' });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/ev/charging-sessions');
    expect(created.body.data.source).toBe('synthetic');
    const stations = await manager.get('/ev/charging-stations');
    expectContract(stations, 'get', '/ev/charging-stations');
  });
});
