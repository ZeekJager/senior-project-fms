import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { DIAGNOSTIC_EVENTS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration';
import { signedDeliveries, type ProviderDiagnostic, type ProviderPosition } from '../../scripts/simulator/delivery';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-132 (docs/diagnostic-codes.md): diagnostic trouble codes through the signed telematics webhook. An active code
// makes one record and one vehicle fault alert; repeats count; a clear closes the record at its time and the alert.

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
  };
}

/** A depot's vehicle with a simulator device linked to it. */
async function vehicleWithDevice(identifier: string, depot?: Row) {
  const admin = await signIn();
  const provider = (await pool.query('UPDATE integration.external_providers SET is_active = TRUE WHERE code = $1 RETURNING public_id', [SIMULATOR])).rows[0];
  const home = depot ?? (await createDepot());
  const vehicle = await createVehicle({ depot: home });
  const linked = await admin.post('/integrations/devices', { provider_id: provider.public_id, device_identifier: identifier, vehicle_id: vehicle.public_id });
  expect(linked.status).toBe(201);
  return { vehicle, depot: home };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const obd = (deviceId: string, code: string, status: 'active' | 'cleared', observedAt: string): ProviderDiagnostic => ({ device_id: deviceId, protocol: 'obd2', code, status, observed_at: observedAt });

/** Posts the codes (and positions) as the simulator does, signed, then lets the consumers run. */
async function report(codes: ProviderDiagnostic[], positions: ProviderPosition[] = []) {
  const responses = [];
  for (const d of signedDeliveries(SECRET, positions, Date.now(), codes)) {
    responses.push(await request(app).post(`/api/v1/webhooks/telematics/${SIMULATOR}`).set(d.headers).send(d.raw));
  }
  await deliverEvents();
  return responses;
}

const codesOf = async (vehicle: Row) =>
  (
    await pool.query(
      `SELECT protocol::text, code, spn, fmi, description, severity, first_seen_at, last_seen_at, occurrences, cleared_at
         FROM tracking.diagnostic_codes WHERE vehicle_id = $1 ORDER BY id`,
      [vehicle.id],
    )
  ).rows;
const alertsOf = async (vehicle: Row) =>
  (await pool.query("SELECT alert_type, severity, status, title, occurrence_count, resolved_by FROM alert.alerts WHERE vehicle_id = $1 AND alert_type = 'vehicle_fault' ORDER BY id", [vehicle.id])).rows;

describe('diagnostic trouble codes from telematics (FMS-132)', () => {
  test('an active code makes one record and one vehicle fault alert; repeats count; a clear closes both at its time', async () => {
    const { vehicle } = await vehicleWithDevice('DTC-0001');
    const [first] = await report([obd('DTC-0001', 'P0217', 'active', ago(30))]);
    expect(first.status).toBe(202);
    expect(await codesOf(vehicle)).toEqual([
      expect.objectContaining({ protocol: 'obd2', code: 'P0217', description: 'Engine overheating', severity: 'critical', occurrences: 1, cleared_at: null }),
    ]);
    expect(await alertsOf(vehicle)).toEqual([expect.objectContaining({ severity: 'critical', status: 'open', title: `Fault code P0217 on ${vehicle.registration_number}`, occurrence_count: 1 })]);
    const raised = (await publishedEvents(DIAGNOSTIC_EVENTS.faultDetected)).filter((e) => e.payload.vehicle_id === vehicle.public_id);
    expect(raised).toHaveLength(1);
    expect(raised[0].payload).toMatchObject({ source: 'telematics', protocol: 'obd2', code: 'P0217', severity: 'critical', provider: SIMULATOR });

    // Repeats: later reports move last seen and count; the same report again counts once; still one alert.
    const later = ago(20);
    await report([obd('DTC-0001', 'P0217', 'active', ago(25)), obd('DTC-0001', 'P0217', 'active', later)]);
    await report([obd('DTC-0001', 'P0217', 'active', later)]);
    const [repeated] = await codesOf(vehicle);
    expect(repeated).toMatchObject({ occurrences: 3, last_seen_at: new Date(later), cleared_at: null });
    expect(await alertsOf(vehicle)).toHaveLength(1);
    expect((await publishedEvents(DIAGNOSTIC_EVENTS.faultDetected)).filter((e) => e.payload.vehicle_id === vehicle.public_id)).toHaveLength(1);

    // A clear older than the last report is not believed; one after it closes the record at its time, and the alert.
    await report([obd('DTC-0001', 'P0217', 'cleared', ago(22))]);
    expect((await codesOf(vehicle))[0].cleared_at).toBeNull();
    const clearedAt = ago(10);
    await report([obd('DTC-0001', 'P0217', 'cleared', clearedAt)]);
    expect((await codesOf(vehicle))[0]).toMatchObject({ cleared_at: new Date(clearedAt), occurrences: 3 });
    expect(await alertsOf(vehicle)).toEqual([expect.objectContaining({ status: 'resolved', resolved_by: null })]);

    // A report from before the clear changes nothing; the code coming back later is a new record and a new alert.
    await report([obd('DTC-0001', 'P0217', 'active', ago(15))]);
    expect(await codesOf(vehicle)).toHaveLength(1);
    await report([obd('DTC-0001', 'P0217', 'active', ago(5))]);
    expect((await codesOf(vehicle)).map((c) => c.cleared_at === null)).toEqual([false, true]);
    expect((await alertsOf(vehicle)).map((a) => a.status)).toEqual(['resolved', 'open']);

    // The batch is audited as the webhook's, by no user.
    const audit = await pool.query("SELECT user_id, details FROM audit.audit_logs WHERE action = 'tracking.diagnostics_ingested' AND details->>'raised' = '1' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({ user_id: null, details: expect.objectContaining({ provider: SIMULATOR, raised: 1 }) });
  });

  test('codes ride with positions; J1939 by SPN and FMI; each code its own alert; a code the dictionary does not name by its class', async () => {
    const { vehicle } = await vehicleWithDevice('DTC-0002');
    const position: ProviderPosition = { device_id: 'DTC-0002', recorded_at: ago(1), lat: 9.0108, lng: 38.7613, speed_kmh: 30 };
    const [res] = await report(
      [
        { device_id: 'DTC-0002', protocol: 'j1939', spn: 110, fmi: 0, status: 'active', observed_at: ago(2) },
        obd('DTC-0002', 'P1234', 'active', ago(2)),
      ],
      [position],
    );
    expect(res.status).toBe(202);
    expect((await pool.query('SELECT count(*)::int AS n FROM tracking.gps_pings WHERE vehicle_id = $1', [vehicle.id])).rows[0].n).toBe(1);
    expect(await codesOf(vehicle)).toEqual([
      expect.objectContaining({ protocol: 'j1939', code: '110-0', spn: 110, fmi: 0, description: 'Engine coolant temperature: above normal, most severe', severity: 'critical' }),
      expect.objectContaining({ protocol: 'obd2', code: 'P1234', description: null, severity: 'medium' }),
    ]);
    expect((await alertsOf(vehicle)).map((a) => a.severity).sort()).toEqual(['critical', 'medium']);
  });

  test('a code from a device no vehicle has is counted as unknown; a malformed code refuses the delivery, naming it', async () => {
    await vehicleWithDevice('DTC-0003');
    const before = (await pool.query("SELECT count(*)::int AS n FROM tracking.diagnostic_codes")).rows[0].n;
    await report([obd('NOT-LINKED-9', 'P0300', 'active', ago(1))]);
    expect((await pool.query('SELECT count(*)::int AS n FROM tracking.diagnostic_codes')).rows[0].n).toBe(before);
    expect((await pool.query("SELECT device_identifier FROM integration.unknown_devices WHERE device_identifier = 'NOT-LINKED-9'")).rows).toHaveLength(1);

    const raw = JSON.stringify({ event_id: 'bad-dtc-1', diagnostics: [{ device_id: 'DTC-0003', protocol: 'obd2', code: 'p0300', status: 'active', observed_at: ago(1) }] });
    const ts = Math.floor(Date.now() / 1000);
    const refused = await request(app)
      .post(`/api/v1/webhooks/telematics/${SIMULATOR}`)
      .set({ 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signWebhook(SECRET, ts, raw) })
      .send(raw);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: 'diagnostics.0.code', reason: 'invalid_format' }]);

    const empty = JSON.stringify({ event_id: 'bad-dtc-2' });
    const none = await request(app)
      .post(`/api/v1/webhooks/telematics/${SIMULATOR}`)
      .set({ 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signWebhook(SECRET, ts, empty) })
      .send(empty);
    expect(none.status).toBe(400);
    expect(none.body.error.details).toEqual([{ field: 'positions', reason: 'required' }]);
  });

  test('GET /vehicles/{id}/diagnostic-codes: active first, by status, in the caller’s depots, tracking:read only', async () => {
    const { vehicle, depot } = await vehicleWithDevice('DTC-0004');
    await report([obd('DTC-0004', 'P0420', 'active', ago(40)), obd('DTC-0004', 'P0300', 'active', ago(30))]);
    await report([obd('DTC-0004', 'P0420', 'cleared', ago(20))]);
    const path = `/vehicles/${vehicle.public_id}/diagnostic-codes`;

    const dispatcher = await signIn(['dispatcher'], depot);
    const all = await dispatcher.get(path);
    expect(all.status).toBe(200);
    expectContract(all, 'get', '/vehicles/{vehicle_id}/diagnostic-codes');
    expect(all.body.data.map((c: { code: string; status: string }) => `${c.code} ${c.status}`)).toEqual(['P0300 active', 'P0420 cleared']);
    expect(all.body.data[0]).toMatchObject({ vehicle_id: vehicle.public_id, protocol: 'obd2', severity: 'high', occurrences: 1, cleared_at: null, provider: SIMULATOR });
    expect((await dispatcher.get(`${path}?status=cleared`)).body.data.map((c: { code: string }) => c.code)).toEqual(['P0420']);
    const invalid = await dispatcher.get(`${path}?status=open`);
    expect(invalid.status).toBe(400);
    expectContract(invalid, 'get', '/vehicles/{vehicle_id}/diagnostic-codes');

    const elsewhere = await signIn(['dispatcher'], await createDepot());
    const hidden = await elsewhere.get(path);
    expect(hidden.status).toBe(404);
    expectContract(hidden, 'get', '/vehicles/{vehicle_id}/diagnostic-codes');
    const driver = await signIn(['driver'], depot);
    const forbidden = await driver.get(path);
    expect(forbidden.status).toBe(403);
    expectContract(forbidden, 'get', '/vehicles/{vehicle_id}/diagnostic-codes');
  });
});
