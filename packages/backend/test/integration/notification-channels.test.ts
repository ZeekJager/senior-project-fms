import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { notificationDelivery } from '../../src/modules/alert';
import { generateVapidKeys, integrationGateway, notificationAdapter } from '../../src/modules/integration';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { deliverEvents } from '../support/events';
import { createDepot, createProvider, createUser, createVehicle, type RoleName } from '../support/factories';
import { httpRecorder, smtpSink } from '../support/notification-servers';

// FMS-93: alerts by email, SMS and push. Providers are integration.external_providers rows of type notification;
// local servers stand in for the mail server, the SMS gateway and a push service. The delivery job is run by
// hand (notificationDelivery.drain), at the times a test needs.

const app = createApp();
const PASSWORD = 'Notification-Channels-1';
const MIN = 60_000;
type Row = Record<string, unknown> & { id: string };

let smtp: Awaited<ReturnType<typeof smtpSink>>;
let sms: Awaited<ReturnType<typeof httpRecorder>>;
let push: Awaited<ReturnType<typeof httpRecorder>>;
const vapid = generateVapidKeys();

beforeAll(async () => {
  smtp = await smtpSink();
  sms = await httpRecorder();
  push = await httpRecorder();
  // The push service is a local http server: this provider trusts it. Real ones accept the browsers' push services only.
  integrationGateway.register(notificationAdapter('test-push', { pushHosts: ['127.0.0.1'], allowHttpPush: true }));
  // Secrets come from INTEGRATION_<CODE>_API_KEY; these are made for the run, not kept anywhere.
  Object.assign(config.integrations.secrets, { 'test-smtp': {}, 'test-sms': { apiKey: `sms-${randomUUID()}` }, 'test-push': { apiKey: vapid.privateKey } });
});
afterAll(async () => {
  await Promise.all([smtp.close(), sms.close(), push.close()]);
});

/** Turns channels on: one provider row each, pointed at the local servers. */
async function channels(...which: ('email' | 'sms' | 'push')[]) {
  const rows: Record<string, Row> = {};
  if (which.includes('email')) {
    rows.email = await createProvider({ code: 'test-smtp', provider_type: 'notification', configuration: { channel: 'email', host: '127.0.0.1', port: smtp.port, tls: 'none', from: 'FMS Alerts <alerts@fleet.test>' } });
  }
  if (which.includes('sms')) {
    rows.sms = await createProvider({ code: 'test-sms', provider_type: 'notification', base_url: sms.url, configuration: { channel: 'sms', sender: 'FMS', max_retries: 0 } });
  }
  if (which.includes('push')) {
    rows.push = await createProvider({ code: 'test-push', provider_type: 'notification', configuration: { channel: 'push', vapid_public_key: vapid.publicKey, subject: 'mailto:ops@fleet.test', max_retries: 0 } });
  }
  return rows;
}

async function signIn(roles: RoleName[], depot: Row | null, extra: { phone?: string; fullName?: string } = {}) {
  const user = await createUser({ roles, depot, password: PASSWORD, fullName: extra.fullName });
  if (extra.phone) await pool.query('UPDATE auth.users SET phone = $2 WHERE id = $1', [user.id, extra.phone]);
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const get = (cookie: string, path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const post = (cookie: string, path: string, body: object = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);

/** A browser's push subscription on the local push service, with real keys. */
function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `${push.url}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

/** A vehicle fault of this severity, published and handled by the alert engine. */
async function fault(vehicle: Row, severity: 'critical' | 'high' | 'medium') {
  await withTransaction(pool, (tx) =>
    eventBus.publish(tx, [
      createEvent(
        'VehicleFaultDetected',
        { source: 'dvir', dvir_report_id: randomUUID(), vehicle_id: vehicle.public_id, driver_id: null, trip_id: null, inspection_type: 'pre_trip', defect_count: 1, defects: ['Brakes'], maintenance_flag_set: true, severity },
        { actor: null, correlationId: randomUUID() },
      ),
    ]),
  );
  await deliverEvents();
  return (await pool.query('SELECT * FROM alert.alerts WHERE vehicle_id = $1 ORDER BY id DESC LIMIT 1', [vehicle.id])).rows[0] as Row;
}

const messagesOf = async (alert: Row) =>
  (
    await pool.query(
      `SELECT recipient_user_id::text AS recipient, channel, status, delivery_attempts AS attempts, provider_id::text AS provider,
              provider_message_id, failure_reason, next_attempt_at, push_subscription_id::text AS subscription
         FROM alert.notifications WHERE alert_id = $1 AND channel <> 'in_app' ORDER BY channel, recipient_user_id`,
      [alert.id],
    )
  ).rows as { recipient: string; channel: string; status: string; attempts: number; provider: string; provider_message_id: string | null; failure_reason: string | null; next_attempt_at: Date | null; subscription: string | null }[];

const drain = (at: Date = new Date()) => notificationDelivery.drain(at, randomUUID());

describe('critical alerts outside the app', () => {
  test('a critical alert is emailed, texted and pushed to the people it notifies; a high one is only pushed', async () => {
    const providers = await channels('email', 'sms', 'push');
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-93001' });
    const tech = await signIn(['technician'], depot, { phone: '+251 911 000001', fullName: 'Tigist Tech' });
    const admin = await signIn(['depot_admin'], depot, { fullName: 'Abebe Admin' });
    const sub = await post(tech.cookie, '/notifications/push/subscriptions', browser('tech-laptop'));
    expect(sub.status).toBe(201);

    const alert = await fault(vehicle, 'critical');
    // Queued with the alert: email to both, SMS to the one with a phone, push to the one device (in the enum's order).
    expect((await messagesOf(alert)).map((m) => [m.channel, m.recipient, m.status])).toEqual([
      ['push', tech.user.id, 'queued'],
      ['sms', tech.user.id, 'queued'],
      ['email', tech.user.id, 'queued'],
      ['email', admin.user.id, 'queued'],
    ]);

    expect(await drain()).toEqual({ sent: 4, retried: 0, failed: 0, cancelled: 0 });

    // Email: one to each, with the severity in the subject.
    expect(smtp.mails.map((m) => m.to).sort()).toEqual([[`<${admin.user.email}>`], [`<${tech.user.email}>`]].sort());
    expect(smtp.mails[0].data).toMatch(/Subject: \[Critical\] Defects reported on AA 3-93001/);
    expect(smtp.mails[0].data).toMatch(/X-FMS-Reference: [0-9a-f-]{36}/i);
    // SMS: the FMS format, with the API key and the message's own id as idempotency key.
    const text = sms.received.at(-1)!;
    expect(text.method).toBe('POST');
    expect(text.path).toBe('/messages');
    expect(text.headers.authorization).toBe(`Bearer ${config.integrations.secrets['test-sms'].apiKey}`);
    const smsBody = JSON.parse(text.body.toString());
    expect(smsBody).toMatchObject({ to: '+251 911 000001', sender: 'FMS' });
    expect(smsBody.text).toMatch(/^FMS CRITICAL: Defects reported on AA 3-93001/);
    expect(text.headers['idempotency-key']).toBe(smsBody.reference);
    // Push: encrypted, signed with VAPID, urgent.
    const pushed = push.received.at(-1)!;
    expect(pushed.path).toBe('/push/tech-laptop');
    expect(pushed.headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'high', ttl: String(24 * 3600) });
    expect(pushed.headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    expect(pushed.body.subarray(0, 16).length).toBe(16);

    const sent = await messagesOf(alert);
    expect(sent.every((m) => m.status === 'sent' && m.attempts === 1 && m.failure_reason === null)).toBe(true);
    expect(sent.find((m) => m.channel === 'email')!.provider).toBe(providers.email.id);
    expect(sent.find((m) => m.channel === 'email')!.provider_message_id).toMatch(/@/);

    // Nothing is sent twice.
    expect(await drain()).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0 });

    // A high alert: push only.
    const other = await createVehicle({ depot, registration_number: 'AA 3-93002' });
    const high = await fault(other, 'high');
    expect((await messagesOf(high)).map((m) => m.channel)).toEqual(['push']);
    // A medium one stays in the app.
    const medium = await fault(await createVehicle({ depot }), 'medium');
    expect(await messagesOf(medium)).toEqual([]);
  });

  test('with no provider for a channel, nothing is queued for it', async () => {
    await channels('email');
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await signIn(['technician'], depot, { phone: '+251 911 000002' });
    expect((await messagesOf(await fault(vehicle, 'critical'))).map((m) => m.channel)).toEqual(['email']);
  });

  test('a failed SMS is retried after 1, 5, 15 and 60 minutes and shows why meanwhile; then it is sent, or after 5 attempts failed', async () => {
    await channels('sms');
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot, { phone: '+251 911 000003' });
    const manager = await signIn(['fleet_manager'], null);
    const t0 = new Date();
    sms.answer({ status: 503 });

    const alert = await fault(await createVehicle({ depot }), 'critical');
    expect(await drain(t0)).toMatchObject({ retried: 1 });
    let [m] = await messagesOf(alert);
    expect(m).toMatchObject({ status: 'queued', attempts: 1, failure_reason: 'POST /messages answered 503.' });
    expect(m.next_attempt_at!.getTime()).toBe(t0.getTime() + MIN);

    // Visible in its delivery status, with who it was for but not their number.
    const status = await get(manager.cookie, `/alerts/${alert.public_id}/deliveries`);
    expect(status.status).toBe(200);
    const smsRow = status.body.data.find((d: { channel: string }) => d.channel === 'sms');
    expect(smsRow).toMatchObject({ status: 'queued', attempts: 1, recipient: { id: tech.user.public_id, name: 'Test User' }, provider: 'test-sms', failure_reason: 'POST /messages answered 503.' });
    expect(new Date(smsRow.next_attempt_at).getTime()).toBe(t0.getTime() + MIN);
    expect(status.body.data.find((d: { channel: string }) => d.channel === 'in_app')).toMatchObject({ status: 'delivered', recipient: { id: tech.user.public_id } });
    expect(JSON.stringify(status.body)).not.toContain('911');

    // Not due yet; then due, fails again, and the next wait is 5 minutes.
    expect(await drain(new Date(t0.getTime() + 30_000))).toMatchObject({ retried: 0 });
    await drain(new Date(t0.getTime() + MIN));
    [m] = await messagesOf(alert);
    expect(m).toMatchObject({ status: 'queued', attempts: 2 });
    expect(m.next_attempt_at!.getTime()).toBe(t0.getTime() + 6 * MIN);

    // The gateway answers again: sent on the third attempt, with its id.
    sms.answer({ status: 201, json: { id: 'sms-778' } });
    expect(await drain(new Date(t0.getTime() + 6 * MIN))).toMatchObject({ sent: 1 });
    [m] = await messagesOf(alert);
    expect(m).toMatchObject({ status: 'sent', attempts: 3, provider_message_id: 'sms-778', failure_reason: null, next_attempt_at: null });
  });

  test('an SMS that never gets through fails after the fifth attempt; while the provider is failing, the next waits without using attempts', async () => {
    // A provider row of its own: a fresh breaker (each provider has one per instance).
    await channels('sms');
    const depot = await createDepot();
    await signIn(['technician'], depot, { phone: '+251 911 000004' });
    sms.answer({ status: 500 });
    const t0 = new Date();
    const alert = await fault(await createVehicle({ depot }), 'critical');
    let at = t0.getTime();
    for (const wait of [0, 1, 5, 15, 60]) {
      at += wait * MIN;
      await drain(new Date(at));
    }
    let [m] = await messagesOf(alert);
    expect(m).toMatchObject({ status: 'failed', attempts: 5, failure_reason: 'POST /messages answered 500.', next_attempt_at: null });

    // Five failures in a row opened the provider's breaker: the next message is not sent, and not counted.
    const next = await fault(await createVehicle({ depot }), 'critical');
    expect(await drain(new Date(at))).toMatchObject({ retried: 1 });
    [m] = await messagesOf(next);
    expect(m).toMatchObject({ status: 'queued', attempts: 0, failure_reason: 'Calls to test-sms are paused after repeated failures.' });
    expect(m.next_attempt_at!.getTime()).toBeGreaterThan(at);
    sms.answer({ status: 201, json: { id: 'ok' } });
  });

  test('a recipient the mail server refuses is failed at once; resolving an alert cancels what has not gone', async () => {
    await channels('email');
    const depot = await createDepot();
    await signIn(['technician'], depot);
    const manager = await signIn(['fleet_manager'], null);

    smtp.replies.rcpt = '550 No such user';
    const refused = await fault(await createVehicle({ depot }), 'critical');
    expect(await drain()).toMatchObject({ failed: 1 });
    expect((await messagesOf(refused))[0]).toMatchObject({ status: 'failed', attempts: 1, failure_reason: 'The mail server refused the recipient (550).' });
    smtp.replies.rcpt = '250 OK';

    const resolved = await fault(await createVehicle({ depot }), 'critical');
    expect((await post(manager.cookie, `/alerts/${resolved.public_id}/resolve`, {})).status).toBe(200);
    expect(await drain()).toMatchObject({ cancelled: 1, sent: 0 });
    expect((await messagesOf(resolved))[0]).toMatchObject({ status: 'cancelled', attempts: 0, failure_reason: 'The alert was resolved before it was sent.' });
  });

  test('a push subscription the push service has forgotten is removed, its push failed, never retried', async () => {
    await channels('push');
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    await post(tech.cookie, '/notifications/push/subscriptions', browser('old-phone'));
    push.answer({ status: 410 });
    const alert = await fault(await createVehicle({ depot }), 'critical');
    expect(await drain()).toMatchObject({ failed: 1 });
    expect((await messagesOf(alert))[0]).toMatchObject({ status: 'failed', failure_reason: 'The push subscription has expired.', subscription: null });
    expect((await pool.query('SELECT 1 FROM alert.push_subscriptions WHERE user_id = $1', [tech.user.id])).rowCount).toBe(0);
    push.answer({ status: 201, headers: { location: `${push.url}/messages/m-1` } });
  });

  test('delivery status is the alert’s: another depot’s user gets 404', async () => {
    await channels('email');
    const depot = await createDepot();
    await signIn(['technician'], depot);
    const alert = await fault(await createVehicle({ depot }), 'critical');
    const outsider = await signIn(['depot_admin'], await createDepot());
    expect((await get(outsider.cookie, `/alerts/${alert.public_id}/deliveries`)).status).toBe(404);
  });
});

describe('push opt-in', () => {
  test('a browser subscribes once, may move to whoever signs in on it, and unsubscribes only its own', async () => {
    await channels('push');
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const driver = await signIn(['driver'], depot);
    const laptop = browser('shared-laptop');

    const first = await post(tech.cookie, '/notifications/push/subscriptions', laptop);
    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ id: expect.any(String), created_at: expect.any(String) });
    const again = await post(tech.cookie, '/notifications/push/subscriptions', laptop);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);

    // Someone else signs in on the same browser and turns push on: it is theirs now.
    expect((await post(driver.cookie, '/notifications/push/subscriptions', laptop)).status).toBe(200);
    expect((await get(tech.cookie, '/notifications/channels')).body.data.push).toEqual({ available: true, public_key: vapid.publicKey, devices: 0, device_keys: [] });
    // The browser can tell it is the driver's: the fingerprint of its endpoint.
    const key = createHash('sha256').update(laptop.endpoint).digest('base64url').slice(0, 22);
    expect((await get(driver.cookie, '/notifications/channels')).body.data.push).toMatchObject({ devices: 1, device_keys: [key] });

    // The technician cannot remove it any more; the driver can, and again is harmless.
    expect((await post(tech.cookie, '/notifications/push/unsubscribe', { endpoint: laptop.endpoint })).body.data).toEqual({ removed: 0 });
    expect((await post(driver.cookie, '/notifications/push/unsubscribe', { endpoint: laptop.endpoint })).body.data).toEqual({ removed: 1 });
    expect((await post(driver.cookie, '/notifications/push/unsubscribe', { endpoint: laptop.endpoint })).body.data).toEqual({ removed: 0 });
  });

  test('only a push service’s address, and real keys, are accepted', async () => {
    await channels('push');
    const tech = await signIn(['technician'], await createDepot());
    const good = browser('x');
    const bad = await post(tech.cookie, '/notifications/push/subscriptions', { ...good, endpoint: 'https://metadata.internal.example/latest' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ field: 'endpoint', reason: 'unknown_push_service' }]);
    const badKeys = await post(tech.cookie, '/notifications/push/subscriptions', { ...good, keys: { p256dh: 'short', auth: good.keys.auth } });
    expect(badKeys.status).toBe(400);
  });

  test('a test push reaches each of the caller’s devices', async () => {
    await channels('push');
    push.answer({ status: 201, headers: { location: `${push.url}/messages/m-2` } });
    const tech = await signIn(['technician'], await createDepot());
    await post(tech.cookie, '/notifications/push/subscriptions', browser('phone'));
    await post(tech.cookie, '/notifications/push/subscriptions', browser('laptop'));
    const before = push.received.length;
    const res = await post(tech.cookie, '/notifications/push/test');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ devices: 2, sent: 2, failed: 0 });
    expect(push.received.slice(before).map((r) => r.path).sort()).toEqual(['/push/laptop', '/push/phone']);
  });

  test('without a push provider, subscribing says push is not set up; the channels say what is on', async () => {
    await channels('email');
    const tech = await signIn(['technician'], await createDepot(), { phone: '+251 911 000009' });
    const res = await post(tech.cookie, '/notifications/push/subscriptions', browser('y'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    const channelsView = (await get(tech.cookie, '/notifications/channels')).body.data;
    expect(channelsView).toEqual({
      rules: [
        { severity: 'critical', channels: ['in_app', 'email'] },
        { severity: 'high', channels: ['in_app'] },
        { severity: 'medium', channels: ['in_app'] },
        { severity: 'low', channels: ['in_app'] },
      ],
      email: { available: true, address: tech.user.email },
      sms: { available: false, phone: '+251 911 000009' },
      push: { available: false, public_key: null, devices: 0, device_keys: [] },
    });
  });
});
