import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { gpsDevices } from '../../src/modules/integration';
import { settings } from '../../src/modules/settings';
import { addisDate } from '../support/dates';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-80: settings an administrator tunes without a code change, and the telemetry rules' thresholds. Each test
// rolls its changes back; the settings' cached copy is dropped with them.

const app = createApp();
const PASSWORD = 'Settings-Test-2';
const SEC = 1000;
type Row = Record<string, unknown> & { id: string; public_id: string };

afterEach(() => settings.forget());

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = (cookie: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  patch: (path: string, body: object) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
});

const byKey = (data: { key: string }[]) => Object.fromEntries(data.map((s) => [s.key, s]));
const audits = async (table: string) =>
  (await pool.query(`SELECT action, old_values, new_values FROM audit.audit_logs WHERE entity_type = $1 ORDER BY id`, [table])).rows;

describe('GET and PATCH /settings', () => {
  test('anyone signed in reads the defaults; an admin changes them, audited, and null goes back to the default', async () => {
    const driver = api(await signIn(['driver']));
    const read = await driver.get('/settings');
    expect(read.status).toBe(200);
    expect(byKey(read.body.data)).toMatchObject({
      fuel_variance_threshold_pct: { value: 20, default_value: 20, is_default: true, unit: 'percent', min: 1, max: 100, updated_by: null },
      health_alert_below: { value: 75, default_value: 75, is_default: true, unit: 'score', min: 50, max: 84 },
      expiry_warning_days: { value: 30, default_value: 30, is_default: true, unit: 'days', min: 8, max: 180 },
    });

    const admin = api(await signIn(['admin']));
    const changed = await admin.patch('/settings', { fuel_variance_threshold_pct: 15, expiry_warning_days: 45 });
    expect(changed.status).toBe(200);
    expect(byKey(changed.body.data)).toMatchObject({
      fuel_variance_threshold_pct: { value: 15, is_default: false, updated_by: expect.any(String), updated_by_name: expect.any(String), updated_at: expect.any(String) },
      expiry_warning_days: { value: 45, is_default: false },
      health_alert_below: { value: 75, is_default: true },
    });
    expect(await settings.values()).toEqual({ fuel_variance_threshold_pct: 15, health_alert_below: 75, expiry_warning_days: 45 });

    // Back to the default: stored as NULL, so it follows the code's default.
    const reset = await admin.patch('/settings', { fuel_variance_threshold_pct: null, expiry_warning_days: 30 });
    expect(byKey(reset.body.data)).toMatchObject({ fuel_variance_threshold_pct: { value: 20, is_default: true }, expiry_warning_days: { value: 30, is_default: true } });
    expect(await settings.value('expiry_warning_days')).toBe(30);

    const trail = await audits('settings.settings');
    expect(trail.map((a) => [a.action, a.old_values?.value ?? null, a.new_values.value])).toEqual([
      ['INSERT', null, 15],
      ['INSERT', null, 45],
      ['UPDATE', 15, null],
      ['UPDATE', 45, null],
    ]);
  });

  test('only settings:write changes them; values outside their range, unknown keys and empty bodies are 400', async () => {
    for (const roles of [['driver'], ['fleet_owner'], ['fleet_manager']] as RoleName[][]) {
      expect((await api(await signIn(roles)).patch('/settings', { health_alert_below: 70 })).status).toBe(403);
    }
    const admin = api(await signIn(['admin']));
    const out = await admin.patch('/settings', { health_alert_below: 85, expiry_warning_days: 7 });
    expect(out.status).toBe(400);
    expect(out.body.error.details).toEqual([
      { field: 'health_alert_below', reason: 'out_of_range' },
      { field: 'expiry_warning_days', reason: 'out_of_range' },
    ]);
    expect((await admin.patch('/settings', { session_minutes: 10 })).status).toBe(400);
    expect((await admin.patch('/settings', { health_alert_below: 70.5 })).status).toBe(400);
    expect((await admin.patch('/settings', {})).status).toBe(400);
    // Nothing was written.
    expect(await audits('settings.settings')).toEqual([]);
  });
});

describe('the settings take effect', () => {
  test('health_alert_below moves the at-risk band of GET /vehicles', async () => {
    const depot = (await createDepot()) as Row;
    const vehicle = (await createVehicle({ depot })) as Row;
    await pool.query('UPDATE fleet.vehicles SET health_score = 78, health_score_updated_at = now() WHERE id = $1', [vehicle.id]);
    const admin = api(await signIn(['admin']));
    const atRisk = async () => (await admin.get(`/vehicles?depot_id=${depot.public_id}&health=at_risk`)).body.data.map((v: { id: string }) => v.id);

    expect(await atRisk()).toEqual([]);
    expect((await admin.patch('/settings', { health_alert_below: 80 })).status).toBe(200);
    expect(await atRisk()).toEqual([vehicle.public_id]);
  });

  test('expiry_warning_days moves the first licence warning', async () => {
    const depot = await createDepot();
    const in45 = await createDriver({ depot, license_expiry: addisDate(45) });
    const run = () => fleetModule.jobs!.find((j) => j.name === 'licence-expiry-check')!.run({ now: new Date(), correlationId: randomUUID(), runKey: 't' });
    const mine = async () => (await publishedEvents('LicenceExpiring')).filter((e) => e.payload.driver_id === in45.driver.public_id);

    await run();
    expect(await mine()).toEqual([]);
    expect((await api(await signIn(['admin'])).patch('/settings', { expiry_warning_days: 60 })).status).toBe(200);
    await run();
    expect((await mine()).map((e) => e.payload)).toEqual([expect.objectContaining({ days_left: 45, level: 'amber' })]);
  });
});

describe('the telemetry rules thresholds', () => {
  const FLEET = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5 };

  test('anyone signed in reads them; an admin sets the fleet’s and a depot’s own, and removes the depot’s, each audited', async () => {
    const depot = (await createDepot()) as Row;
    const reader = api(await signIn(['dispatcher'], depot));
    const before = await reader.get('/settings/telemetry-rules');
    expect(before.status).toBe(200);
    expect(before.body.data.fleet).toMatchObject(FLEET);

    const admin = api(await signIn(['admin']));
    expect((await admin.put('/settings/telemetry-rules/fleet', { ...FLEET, idle_minutes: 8 })).body.data.fleet).toMatchObject({
      idle_minutes: 8,
      updated_by_name: expect.any(String),
    });
    const own = await admin.put(`/settings/telemetry-rules/depots/${depot.public_id}`, { speed_limit_kmh: 60, speeding_pings: 2, clear_pings: 3, idle_minutes: 10 });
    expect(own.status).toBe(200);
    expect(own.body.data.depots).toEqual([expect.objectContaining({ depot_id: depot.public_id, speed_limit_kmh: 60, speeding_pings: 2, idle_minutes: 10 })]);
    // The same again changes nothing.
    await admin.put(`/settings/telemetry-rules/depots/${depot.public_id}`, { speed_limit_kmh: 60, speeding_pings: 2, clear_pings: 3, idle_minutes: 10 });

    expect((await admin.delete(`/settings/telemetry-rules/depots/${depot.public_id}`)).status).toBe(204);
    expect((await reader.get('/settings/telemetry-rules')).body.data.depots).toEqual([]);
    expect((await admin.delete(`/settings/telemetry-rules/depots/${depot.public_id}`)).status).toBe(404);

    expect((await audits('tracking.rule_thresholds')).map((a) => a.action)).toEqual(['UPDATE', 'INSERT', 'DELETE']);
  });

  test('only settings:write changes them; out of range is 400, an unknown depot 404', async () => {
    const depot = (await createDepot()) as Row;
    expect((await api(await signIn(['fleet_manager'], depot)).put('/settings/telemetry-rules/fleet', FLEET)).status).toBe(403);
    const admin = api(await signIn(['admin']));
    expect((await admin.put('/settings/telemetry-rules/fleet', { ...FLEET, speed_limit_kmh: 10 })).status).toBe(400);
    expect((await admin.put('/settings/telemetry-rules/fleet', { speed_limit_kmh: 70 })).status).toBe(400);
    expect((await admin.put(`/settings/telemetry-rules/depots/${randomUUID()}`, FLEET)).status).toBe(404);
    expect((await admin.delete('/settings/telemetry-rules/depots/not-a-depot')).status).toBe(404);
  });

  test('a new speeding threshold applies from the next ping, without waiting for the cache', async () => {
    const depot = (await createDepot()) as Row;
    const vehicle = (await createVehicle({ depot })) as Row;
    const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
    const report = async (speeds: number[], endAgo: number) => {
      for (const [i, speed_kmh] of speeds.entries()) {
        const recorded_at = new Date(Date.now() - endAgo - (speeds.length - 1 - i) * 10 * SEC).toISOString();
        const res = await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: [{ recorded_at, lat: 9.0108, lng: 38.7613, speed_kmh, ignition_on: true }] });
        expect(res.status).toBe(202);
      }
      await deliverEvents();
    };
    const flags = async () => (await pool.query('SELECT details FROM tracking.telemetry_flags WHERE vehicle_id = $1', [vehicle.id])).rows;

    // 70 km/h under the fleet's 80: nothing, and the thresholds are now cached.
    await report([70, 70, 70], 60 * SEC);
    expect(await flags()).toEqual([]);

    const admin = api(await signIn(['admin']));
    expect((await admin.put(`/settings/telemetry-rules/depots/${depot.public_id}`, { speed_limit_kmh: 60, speeding_pings: 2, clear_pings: 3, idle_minutes: 5 })).status).toBe(200);
    await report([70, 70], 0);
    expect(await flags()).toEqual([{ details: expect.objectContaining({ speed_limit_kmh: 60, consecutive_pings: 2 }) }]);
  });
});
