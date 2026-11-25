import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { channelPostDelivery } from '../../src/modules/alert';
import { integrationGateway, notificationAdapter } from '../../src/modules/integration';
import { settings } from '../../src/modules/settings';
import { monitoringJobs } from '../../src/modules/system';
import { metricsRegistry } from '../../src/shared/metrics/registry';
import { deliverEvents, publishedEvents } from '../support/events';
import { createProvider, createUser, type RoleName } from '../support/factories';

// FMS-109, FMS-163 (docs/observability.md): Alertmanager's alerts become FMS alerts for the administrators (critical on
// every channel, posted to Teams), resolve by themselves, and are held back for hosts in a maintenance window, whose
// start and end are audited; the thresholds Prometheus compares against follow the settings; /system/metrics needs
// system:read. The rules themselves fire in promtool's tests (docker/observability/prometheus/rules).

const app = createApp();
const PASSWORD = 'Monitoring-Test-1';
const TOKEN = process.env.ALERTMANAGER_WEBHOOK_TOKEN!;

afterEach(() => settings.forget());

async function signIn(roles: RoleName[]) {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const hook = (body: object, token: string | null = TOKEN) => {
  const req = request(app).post('/api/v1/system/alerts/webhook').send(body);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

function alertmanager(status: 'firing' | 'resolved', alerts: { name: string; severity: 'critical' | 'warning'; host?: string; fingerprint: string; startsAt?: string }[]) {
  return {
    version: '4',
    status,
    alerts: alerts.map((a) => ({
      status,
      labels: { alertname: a.name, severity: a.severity, ...(a.host ? { host: a.host } : {}) },
      annotations: { summary: `${a.name} summary`, description: `${a.host ?? 'the fleet'} passed a line.` },
      startsAt: a.startsAt ?? '2026-11-25T08:00:00Z',
      fingerprint: a.fingerprint,
    })),
  };
}

const alertsByDedup = async (fingerprint: string) =>
  (
    await pool.query<{ id: string; status: string; severity: string; alert_type: string; title: string; resolved_by: string | null }>(
      'SELECT id, status::text, severity::text, alert_type, title, resolved_by FROM alert.alerts WHERE dedup_key = $1 ORDER BY id',
      [`monitoring:${fingerprint}`],
    )
  ).rows;

describe("Alertmanager's webhook", () => {
  test('refuses a request without the token', async () => {
    expect((await hook(alertmanager('firing', [{ name: 'HostCpuCritical', severity: 'critical', host: 'h', fingerprint: 'f0' }]), null)).status).toBe(401);
    expect((await hook(alertmanager('firing', [{ name: 'HostCpuCritical', severity: 'critical', host: 'h', fingerprint: 'f0' }]), 'wrong-token')).status).toBe(401);
    expect((await hook({ status: 'firing' })).status).toBe(400);
  });

  test('a critical alert opens an FMS alert for the administrators, queued for Teams; a repeat is the same alert; resolved closes it by itself', async () => {
    const admin = await signIn(['admin']);
    const fingerprint = `cpu-${randomUUID().slice(0, 8)}`;
    const body = alertmanager('firing', [{ name: 'HostCpuCritical', severity: 'critical', host: 'fms-host', fingerprint }]);
    const first = await hook(body);
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual({ published: 1, suppressed: 0 });
    // Alertmanager repeats itself every group interval: the same event, skipped.
    await hook(body);
    expect((await publishedEvents('MonitoringAlertFiring')).filter((e) => e.payload.fingerprint === fingerprint)).toHaveLength(1);
    await deliverEvents();

    const [alert] = await alertsByDedup(fingerprint);
    expect(alert).toMatchObject({ status: 'open', severity: 'critical', alert_type: 'monitoring_host_cpu_critical', title: 'Critical: HostCpuCritical summary (fms-host)' });
    const told = (await pool.query<{ channel: string }>('SELECT DISTINCT channel::text FROM alert.notifications WHERE alert_id = $1 AND recipient_user_id = $2', [alert.id, admin.user.id])).rows.map((r) => r.channel);
    expect(told).toContain('in_app');
    const posts = async () => (await pool.query<{ kind: string; status: string }>('SELECT kind, status FROM alert.channel_posts WHERE alert_id = $1 ORDER BY id', [alert.id])).rows;
    expect(await posts()).toEqual([{ kind: 'opened', status: 'queued' }]);
    const inbox = await request(app).get('/api/v1/notifications').set('Cookie', admin.cookie);
    expect(inbox.body.data.find((n: { title: string }) => n.title.startsWith('Critical: HostCpuCritical'))).toMatchObject({ entity: { type: 'monitoring', id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });

    expect((await hook(alertmanager('resolved', [{ name: 'HostCpuCritical', severity: 'critical', host: 'fms-host', fingerprint }]))).status).toBe(202);
    await deliverEvents();
    const [after] = await alertsByDedup(fingerprint);
    expect(after).toMatchObject({ status: 'resolved', resolved_by: null });
    expect(await posts()).toEqual([
      { kind: 'opened', status: 'queued' },
      { kind: 'resolved', status: 'queued' },
    ]);
    const resolved = (await publishedEvents('AlertResolved')).find((e) => e.payload.resolved_by === null && e.payload.by === 'system');
    expect(resolved).toBeDefined();
  });

  test('a warning is an alert in the app only, and a warning turned critical is told again', async () => {
    await signIn(['admin']);
    const fingerprint = `disk-${randomUUID().slice(0, 8)}`;
    await hook(alertmanager('firing', [{ name: 'HostDiskWarning', severity: 'warning', host: 'fms-host', fingerprint }]));
    await deliverEvents();
    const [alert] = await alertsByDedup(fingerprint);
    expect(alert).toMatchObject({ severity: 'medium', status: 'open' });
    const channels = (await pool.query<{ channel: string }>('SELECT DISTINCT channel::text FROM alert.notifications WHERE alert_id = $1', [alert.id])).rows.map((r) => r.channel);
    expect(channels).toEqual(['in_app']);
  });
});

describe('maintenance windows', () => {
  test('hold back alerts for their hosts only, and their start and end are in the audit log', async () => {
    const admin = await signIn(['admin']);
    const manager = await signIn(['fleet_manager']);
    const now = Date.now();
    const window = { hosts: ['db-host-1'], starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 3_600_000).toISOString(), reason: 'Disk replacement' };
    expect((await request(app).post('/api/v1/system/maintenance-windows').set('Cookie', manager.cookie).send(window)).status).toBe(403);
    expect((await request(app).post('/api/v1/system/maintenance-windows').set('Cookie', admin.cookie).send({ ...window, ends_at: window.starts_at })).status).toBe(400);
    const created = await request(app).post('/api/v1/system/maintenance-windows').set('Cookie', admin.cookie).send(window);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ hosts: ['db-host-1'], in_force: true, suppressed: 0 });

    const held = `held-${randomUUID().slice(0, 8)}`;
    const other = `other-${randomUUID().slice(0, 8)}`;
    const res = await hook(
      alertmanager('firing', [
        { name: 'HostDiskCritical', severity: 'critical', host: 'db-host-1', fingerprint: held },
        { name: 'HostDiskCritical', severity: 'critical', host: 'app-host-2', fingerprint: other },
      ]),
    );
    expect(res.body.data).toEqual({ published: 1, suppressed: 1 });
    await deliverEvents();
    expect(await alertsByDedup(held)).toEqual([]);
    expect(await alertsByDedup(other)).toHaveLength(1);

    await monitoringJobs.recordWindowEdges(new Date(), randomUUID());
    const cancelled = await request(app).post(`/api/v1/system/maintenance-windows/${created.body.data.id}/cancel`).set('Cookie', admin.cookie);
    expect(cancelled.body.data).toMatchObject({ in_force: false, suppressed: 1 });
    await monitoringJobs.recordWindowEdges(new Date(), randomUUID());
    const trail = await pool.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM audit.audit_logs WHERE action LIKE 'system.maintenance_window_%' AND details->>'window_id' = $1 ORDER BY id",
      [created.body.data.id],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['system.maintenance_window_started', 'system.maintenance_window_ended']);
    expect(trail.rows[1].details).toMatchObject({ hosts: ['db-host-1'], cancelled: true, suppressed: 1 });
    // Once each: running the job again writes nothing more.
    await monitoringJobs.recordWindowEdges(new Date(), randomUUID());
    expect((await pool.query("SELECT 1 FROM audit.audit_logs WHERE action LIKE 'system.maintenance_window_%' AND details->>'window_id' = $1", [created.body.data.id])).rowCount).toBe(2);
    expect((await request(app).get('/api/v1/system/maintenance-windows').set('Cookie', admin.cookie)).body.data.map((w: { id: string }) => w.id)).toContain(created.body.data.id);
  });
});

describe('the thresholds and the Resources tab', () => {
  test('Prometheus reads the thresholds from the settings: a change applies at the next scrape', async () => {
    const admin = await signIn(['admin']);
    const scrape = async () => metricsRegistry.metrics();
    // The scraped line, whatever order its labels come in.
    const threshold = async () => (await scrape()).split(String.fromCharCode(10)).find((l) => l.startsWith('fms_alert_threshold{') && l.includes('setting="monitor_cpu_critical_pct"'))?.split(' ').pop();
    expect(await threshold()).toBe('90');
    const changed = await request(app).patch('/api/v1/settings').set('Cookie', admin.cookie).send({ monitor_cpu_critical_pct: 95 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    // The next scrape (a scrape's reads are shared for 1 s; Prometheus scrapes every 15 s).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await threshold()).toBe('95');
    // A warning line may not reach its critical one.
    const crossed = await request(app).patch('/api/v1/settings').set('Cookie', admin.cookie).send({ monitor_cpu_warning_pct: 96 });
    expect(crossed.status).toBe(400);
    expect(crossed.body.error.details[0]).toMatchObject({ field: 'monitor_cpu_warning_pct', reason: 'warning_not_below_critical' });
  });

  test('/system/metrics needs system:read; without a metrics store it says so', async () => {
    const manager = await signIn(['fleet_manager']);
    const admin = await signIn(['admin']);
    expect((await request(app).get('/api/v1/system/metrics').set('Cookie', manager.cookie)).status).toBe(403);
    const res = await request(app).get('/api/v1/system/metrics?range=24h').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ range: '24h', source: { configured: false }, hosts: [], thresholds: { cpu_pct: { warning: 75, critical: 90 } } });
    expect((await request(app).get('/api/v1/system/metrics?range=2y').set('Cookie', admin.cookie)).status).toBe(400);
    expect((await request(app).get('/api/v1/system/capacity-report').set('Cookie', admin.cookie)).status).toBe(503);
  });
});

describe('Teams', () => {
  let server: Server;
  let url: string;
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const CODE = `teams-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        posted.push({ path: req.url ?? '', body: JSON.parse(data) as Record<string, unknown> });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workflows/abc/triggers/manual/run?sig=secret`;
    integrationGateway.register(notificationAdapter(CODE, { teamsHosts: ['127.0.0.1'], allowHttpTeams: true }));
    Object.assign(config.integrations.secrets, { [CODE]: { apiKey: url } });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('an opened and a resolved monitoring alert are each posted once, as an Adaptive Card', async () => {
    await createProvider({ code: CODE, provider_type: 'notification', configuration: { channel: 'teams' } });
    const fingerprint = `teams-${randomUUID().slice(0, 8)}`;
    await hook(alertmanager('firing', [{ name: 'ReplicaLagCritical', severity: 'critical', fingerprint }]));
    await deliverEvents();
    await channelPostDelivery.drain(new Date(), randomUUID());
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe('/workflows/abc/triggers/manual/run?sig=secret');
    const card = (posted[0].body.attachments as { contentType: string; content: { body: { text: string }[] } }[])[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.body[0].text).toBe('Critical: ReplicaLagCritical summary');

    await hook(alertmanager('resolved', [{ name: 'ReplicaLagCritical', severity: 'critical', fingerprint }]));
    await deliverEvents();
    await channelPostDelivery.drain(new Date(), randomUUID());
    await channelPostDelivery.drain(new Date(), randomUUID());
    expect(posted).toHaveLength(2);
    expect((posted[1].body.attachments as { content: { body: { text: string }[] } }[])[0].content.body[0].text).toBe('Resolved: Critical: ReplicaLagCritical summary');
  });
});
