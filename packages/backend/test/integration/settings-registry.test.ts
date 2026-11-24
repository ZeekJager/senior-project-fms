import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { thresholdParameterStore } from '../../src/modules/integration/application/threshold-parameters';
import { trackingLookups } from '../../src/modules/integration';
import { settings } from '../../src/modules/settings';
import { settingDefinitions, settingParameters } from '../../src/modules/settings/domain/settings';
import { SettingsRepository } from '../../src/modules/settings/infrastructure/settings.repository';
import { publishedEvents } from '../support/events';
import { createUser, type RoleName } from '../support/factories';

// FMS-157: the settings registry. Each test rolls its changes back; the registry's cached copy is dropped with them.

const app = createApp();
const PASSWORD = 'Registry-Test-3';

afterEach(() => settings.forget());

async function signIn(roles: RoleName[]): Promise<string> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = (cookie: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, etag?: string) => {
    const r = request(app).patch(`/api/v1${path}`).set('Cookie', cookie);
    return (etag ? r.set('If-Match', etag) : r).send(body);
  },
  put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string, etag?: string) => {
    const r = request(app).delete(`/api/v1${path}`).set('Cookie', cookie);
    return etag ? r.set('If-Match', etag) : r;
  },
});

const audits = async (table: string) =>
  (await pool.query(`SELECT action, old_values, new_values FROM audit.audit_logs WHERE entity_type = $1 ORDER BY id`, [table])).rows;

const REPORT_DETAIL = {
  key: 'report_detail',
  label: 'Report detail',
  category: 'Reports',
  description: 'How much the monthly report shows.',
  type: 'dropdown',
  default_value: 'standard',
  rules: {
    options: [
      { value: 'summary', label: 'Summary' },
      { value: 'standard', label: 'Standard' },
      { value: 'full', label: 'Everything' },
    ],
  },
};

describe('the registry (FMS-157)', () => {
  test('an admin adds a dropdown with 3 options, and code reads its value with no deployment', async () => {
    const admin = api(await signIn(['admin']));
    expect(await settings.get('report_detail')).toBeUndefined();

    const created = await admin.post('/settings/definitions', REPORT_DETAIL);
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.body.data).toMatchObject({ key: 'report_detail', type: 'dropdown', value: 'standard', is_default: true, is_system: false, is_enabled: true });
    expect(await settings.get('report_detail')).toBe('standard');

    const changed = await admin.patch('/settings/definitions/report_detail', { value: 'full' }, created.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ value: 'full', is_default: false, value_changed_by_name: expect.any(String) });
    expect(changed.headers.etag).toBe('"2"');
    // The saving instance forgot its copy: code reads the new value at once.
    expect(await settings.get('report_detail')).toBe('full');

    const listed = await admin.get('/settings/definitions?category=Reports');
    expect(listed.body.data.map((p: { key: string }) => p.key)).toEqual(['report_detail']);
    expect(listed.body.meta.categories).toEqual(expect.arrayContaining(['Reports', 'Driving rules', 'Driver score', 'Alerts and anomalies']));

    expect((await publishedEvents('SettingDefined', 'SettingChanged')).map((e) => [e.type, e.payload.key, e.payload.value_changed ?? null])).toEqual([
      ['SettingDefined', 'report_detail', null],
      ['SettingChanged', 'report_detail', true],
    ]);
    // Events name the parameter, never its value.
    expect(JSON.stringify((await publishedEvents('SettingChanged'))[0].payload)).not.toContain('full');
  });

  test('a wrong value is 400 with its reason, and nothing in that save is written', async () => {
    const admin = api(await signIn(['admin']));
    await admin.post('/settings/definitions', REPORT_DETAIL);
    await admin.post('/settings/definitions', { key: 'ops_email', label: 'Operations email', category: 'Reports', type: 'email', default_value: 'ops@fleet.et' });
    await admin.post('/settings/definitions', {
      key: 'cutoff',
      label: 'Cut-off',
      category: 'Reports',
      type: 'json',
      default_value: { hour: 18 },
      rules: { schema: { type: 'object', required: ['hour'], properties: { hour: { type: 'integer', minimum: 0, maximum: 23 } } } },
    });

    const reasons = async (body: object) => {
      const res = await admin.patch('/settings', body);
      expect(res.status).toBe(400);
      return res.body.error.details;
    };
    expect(await reasons({ health_alert_below: 'high' })).toEqual([{ field: 'health_alert_below', reason: 'wrong_type' }]);
    expect(await reasons({ health_alert_below: 90 })).toEqual([{ field: 'health_alert_below', reason: 'out_of_range' }]);
    expect(await reasons({ report_detail: 'verbose' })).toEqual([{ field: 'report_detail', reason: 'not_an_option' }]);
    expect(await reasons({ ops_email: 'ops@' })).toEqual([{ field: 'ops_email', reason: 'invalid_format' }]);
    expect(await reasons({ cutoff: { hour: 30 } })).toEqual([{ field: 'cutoff', reason: 'invalid_format' }]);

    // A good value beside a bad one: neither is written.
    expect(await reasons({ expiry_warning_days: 45, report_detail: 'verbose' })).toEqual([{ field: 'report_detail', reason: 'not_an_option' }]);
    expect(await settings.value('expiry_warning_days')).toBe(30);
    expect(await audits('settings.settings')).toEqual([]);

    // The same on one parameter's endpoint.
    const one = await admin.patch('/settings/definitions/report_detail', { value: 'verbose' });
    expect([one.status, one.body.error.details]).toEqual([400, [{ field: 'value', reason: 'not_an_option' }]]);
  });

  test('a system parameter cannot be deleted; disabled, it answers with its default, and its own value comes back when enabled', async () => {
    const admin = api(await signIn(['admin']));
    const gone = await admin.delete('/settings/definitions/health_alert_below');
    expect([gone.status, gone.body.error.code, gone.body.error.details]).toEqual([409, 'CONFLICT_SYSTEM_PARAMETER', [{ reason: 'system_parameter' }]]);

    // A system parameter's value needs a reason.
    const why = await admin.patch('/settings/definitions/health_alert_below', { value: 70 });
    expect([why.status, why.body.error.details]).toEqual([400, [{ field: 'reason', reason: 'required' }]]);
    expect((await admin.patch('/settings/definitions/health_alert_below', { value: 70, reason: 'Fewer false alarms' })).status).toBe(200);
    expect(await settings.value('health_alert_below')).toBe(70);

    const off = await admin.patch('/settings/definitions/health_alert_below', { is_enabled: false });
    expect(off.body.data).toMatchObject({ is_enabled: false, value: 75 });
    expect(await settings.value('health_alert_below')).toBe(75);
    expect(await settings.get('health_alert_below')).toBe(75);

    await admin.patch('/settings/definitions/health_alert_below', { is_enabled: true });
    expect(await settings.value('health_alert_below')).toBe(70);
    expect((await publishedEvents('SettingDisabled', 'SettingEnabled')).map((e) => e.type)).toEqual(['SettingDisabled', 'SettingEnabled']);

    // Its definition is the code's.
    const edit = await admin.patch('/settings/definitions/health_alert_below', { label: 'Health line' });
    expect([edit.status, edit.body.error.code]).toEqual([409, 'CONFLICT_SYSTEM_PARAMETER']);
  });

  test('two admins edit one parameter at once: the second save is 412, not a silent overwrite', async () => {
    const first = api(await signIn(['admin']));
    const second = api(await signIn(['admin']));
    await first.post('/settings/definitions', REPORT_DETAIL);
    const etag = (await first.get('/settings/definitions/report_detail')).headers.etag;
    expect((await second.get('/settings/definitions/report_detail')).headers.etag).toBe(etag);

    expect((await first.patch('/settings/definitions/report_detail', { value: 'full' }, etag)).status).toBe(200);
    const late = await second.patch('/settings/definitions/report_detail', { value: 'summary' }, etag);
    expect([late.status, late.body.error.code]).toEqual([412, 'PRECONDITION_FAILED']);
    expect(await settings.get('report_detail')).toBe('full');
    expect((await second.delete('/settings/definitions/report_detail', etag)).status).toBe(412);
  });

  test('a change is in the audit log (S-10) and the parameter’s history, who, when and why, and restores from it', async () => {
    const admin = api(await signIn(['admin']));
    const created = await admin.post('/settings/definitions', REPORT_DETAIL);
    await admin.patch('/settings/definitions/report_detail', { value: 'full', reason: 'The board wants it all' });
    await admin.patch('/settings/definitions/report_detail', { value: 'summary' });
    await admin.patch('/settings/definitions/report_detail', { label: 'Monthly report detail' });

    const history = await admin.get('/settings/definitions/report_detail/history');
    expect(history.status).toBe(200);
    expect(history.body.data.map((h: Record<string, unknown>) => [h.change, h.old_value, h.new_value, h.reason])).toEqual([
      ['edited', null, null, null],
      ['value', 'full', 'summary', null],
      ['value', null, 'full', 'The board wants it all'],
      ['defined', null, null, null],
    ]);
    expect(history.body.data[0]).toMatchObject({ fields: ['label'], by: expect.any(String), by_name: expect.any(String), at: expect.any(String) });

    // Restore this value: the old one sent again.
    await admin.patch('/settings/definitions/report_detail', { value: history.body.data[2].new_value, reason: 'Restored from the history' });
    expect(await settings.get('report_detail')).toBe('full');

    const log = await admin.get('/audit-logs?entity_type=settings.settings');
    expect(log.status).toBe(200);
    expect(log.body.data.length).toBe(3);
    void created;
  });

  test('without settings:define nobody adds, deletes, enables or disables; secrets are never returned in clear', async () => {
    for (const roles of [['fleet_manager'], ['fleet_owner'], ['driver']] as RoleName[][]) {
      const user = api(await signIn(roles));
      expect((await user.post('/settings/definitions', REPORT_DETAIL)).status).toBe(403);
      expect((await user.delete('/settings/definitions/report_detail')).status).toBe(403);
      expect((await user.patch('/settings/definitions/health_alert_below', { is_enabled: false })).status).toBe(403);
    }

    const admin = api(await signIn(['admin']));
    const created = await admin.post('/settings/definitions', {
      key: 'maps_api_key',
      label: 'Maps API key',
      category: 'Integrations',
      type: 'text',
      default_value: '',
      is_secret: true,
      value: 'sk-live-123456',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ value: null, default_value: null, is_secret: true, has_value: true });
    expect(JSON.stringify((await admin.get('/settings/definitions')).body)).not.toContain('sk-live');
    await admin.patch('/settings/definitions/maps_api_key', { value: 'sk-live-999999' });
    const history = await admin.get('/settings/definitions/maps_api_key/history');
    expect(JSON.stringify(history.body)).not.toContain('sk-live');
    expect(history.body.data[0]).toMatchObject({ change: 'value', old_value: '[SECRET]', new_value: '[SECRET]' });
    expect(JSON.stringify(await audits('settings.settings'))).not.toContain('sk-live');
    // Code reads the real value.
    expect(await settings.get('maps_api_key')).toBe('sk-live-999999');
  });

  test('a definition can require a permission besides settings:write to change its value', async () => {
    const admin = api(await signIn(['admin']));
    await admin.post('/settings/definitions', { ...REPORT_DETAIL, required_permission: 'backup:write' });
    expect((await admin.patch('/settings', { report_detail: 'full' })).status).toBe(200);
    // Admins hold backup:write; a permission nobody has blocks everyone.
    expect((await admin.post('/settings/definitions', { ...REPORT_DETAIL, key: 'x_detail', required_permission: 'no:such' })).body.error.details).toEqual([
      { field: 'required_permission', reason: 'unknown_permission' },
    ]);
  });

  test('a deleted custom parameter is gone for code, and its key starts again from the default', async () => {
    const admin = api(await signIn(['admin']));
    await admin.post('/settings/definitions', REPORT_DETAIL);
    await admin.patch('/settings', { report_detail: 'full' });
    expect((await admin.delete('/settings/definitions/report_detail')).status).toBe(204);
    expect(await settings.get('report_detail')).toBeUndefined();
    expect((await admin.get('/settings/definitions/report_detail')).status).toBe(404);
    expect((await admin.patch('/settings', { report_detail: 'full' })).body.error.details).toEqual([{ field: 'report_detail', reason: 'unknown_parameter' }]);

    expect((await admin.post('/settings/definitions', REPORT_DETAIL)).body.data).toMatchObject({ value: 'standard', is_default: true });
    expect((await admin.post('/settings/definitions', REPORT_DETAIL)).status).toBe(409);
    expect((await publishedEvents('SettingDeleted')).map((e) => e.payload.key)).toEqual(['report_detail']);
  });
});

describe('the driving rules as system parameters', () => {
  test('changed in the registry: the fleet’s row of tracking.rule_thresholds, audited with the reason, in the history', async () => {
    const admin = api(await signIn(['admin']));
    const res = await admin.patch('/settings/definitions/speed_limit_kmh', { value: 70, reason: 'New city limit' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ value: 70, is_default: false, storage: 'rule_thresholds', category: 'Driving rules' });
    expect((await admin.get('/settings/telemetry-rules')).body.data.fleet).toMatchObject({ speed_limit_kmh: 70 });
    expect((await audits('tracking.rule_thresholds')).map((a) => [a.action, a.new_values.speed_limit_kmh, a.new_values.change_reason])).toEqual([
      ['UPDATE', 70, 'New city limit'],
    ]);
    const history = (await admin.get('/settings/definitions/speed_limit_kmh/history')).body.data;
    expect(history[0]).toMatchObject({ change: 'value', old_value: 80, new_value: 70, reason: 'New city limit' });

    // The rules between them still hold: urgent later than late. Nothing written.
    const bad = await admin.patch('/settings', { trip_delay_urgent_minutes: 10 });
    expect([bad.status, bad.body.error.details]).toEqual([400, [{ field: 'trip_delay_urgent_minutes', reason: 'not_above_late' }]]);
    expect((await audits('tracking.rule_thresholds')).length).toBe(1);

    // Back to the default: the default's value.
    await admin.patch('/settings/definitions/speed_limit_kmh', { value: null, reason: 'Back to normal' });
    expect((await admin.get('/settings/telemetry-rules')).body.data.fleet).toMatchObject({ speed_limit_kmh: 80 });
  });

  test('a disabled threshold answers with its default for the fleet and every depot', async () => {
    const admin = api(await signIn(['admin']));
    await admin.patch('/settings/definitions/trip_delay_minutes', { value: 30, reason: 'Long routes' });
    expect(await trackingLookups.tripDelayMargins(pool, null)).toEqual({ lateMinutes: 30, urgentMinutes: 60 });
    await admin.patch('/settings/definitions/trip_delay_minutes', { is_enabled: false });
    expect(await trackingLookups.tripDelayMargins(pool, null)).toEqual({ lateMinutes: 15, urgentMinutes: 60 });
    await admin.patch('/settings/definitions/driver_attendance_exception', { is_enabled: false });
    expect(await trackingLookups.exceptionPolicies(pool, null)).toEqual({ attendance: 'warn', overrun: 'warn' });
  });

  test('a change on the driving rules screen moves the registry’s ETag on and is published', async () => {
    const admin = api(await signIn(['admin']));
    const before = (await admin.get('/settings/definitions/idle_minutes')).headers.etag;
    const FLEET = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 9 };
    expect((await admin.put('/settings/telemetry-rules/fleet', FLEET)).status).toBe(200);
    const after = await admin.get('/settings/definitions/idle_minutes');
    expect(after.body.data.value).toBe(9);
    expect(after.headers.etag).not.toBe(before);
    expect((await admin.patch('/settings/definitions/idle_minutes', { value: 7, reason: 'x' }, before)).status).toBe(412);
    expect((await publishedEvents('SettingChanged')).map((e) => e.payload.key)).toEqual(['idle_minutes']);
  });
});

test('the system parameters in the database are the code’s: the migration and the declarations agree', async () => {
  const declared = [
    ...settingParameters(settingDefinitions({ fuelVarianceThresholdPct: config.fuel.varianceThresholdPct })),
    ...thresholdParameterStore({ thresholds: null as never, service: null as never, trail: null as never }).parameters,
  ];
  // 9 settings (FMS-80, FMS-146, the 2 of FMS-159's appeals) and 15 driving rules.
  expect(declared).toHaveLength(24);
  // Bringing them in step changes nothing.
  expect(await new SettingsRepository(pool).syncSystem(pool, declared)).toEqual([]);
});
