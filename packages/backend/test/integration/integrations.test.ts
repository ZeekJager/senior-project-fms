import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { INTEGRATION_EVENTS, SIGNATURE_HEADER, TIMESTAMP_HEADER, integrationGateway, mockProviderAdapter, signWebhook, webhookDeliveries } from '../../src/modules/integration';
import { createProvider, createUser, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';
import { startMockProvider, type MockProviderServer } from '../support/mock-provider-server';

// FMS-85: the integration gateway against a provider served locally (test/support/mock-provider-server.ts).
// Its secrets come from the test environment (test-env.ts): INTEGRATION_MOCK_TELEMATICS_*.

const app = createApp();
const PASSWORD = 'Gateway-Test-1';
const CODE = 'mock-telematics';
const SECRET = process.env.INTEGRATION_MOCK_TELEMATICS_WEBHOOK_SECRET!;
const API_KEY = process.env.INTEGRATION_MOCK_TELEMATICS_API_KEY!;

let mock: MockProviderServer;
beforeAll(async () => {
  integrationGateway.register(mockProviderAdapter(CODE));
  integrationGateway.register(mockProviderAdapter('mock-fuel'));
  mock = await startMockProvider();
});
afterEach(async () => {
  // A sync still running would write into the next test's transaction.
  await integrationGateway.settled();
  mock.requests.length = 0;
});
afterAll(async () => {
  integrationGateway.shutdown();
  await mock.close();
});

async function signIn(roles: RoleName[] = ['admin']): Promise<string> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const provider = (overrides: Record<string, unknown> = {}) => createProvider({ code: CODE, name: 'Mock telematics', base_url: mock.url, ...overrides });
const statusOf = async (cookie: string, code = CODE, query = '') => {
  const res = await request(app).get(`/api/v1/integrations/providers${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.data.find((p: { code: string }) => p.code === code);
};
const sync = (cookie: string, row: Record<string, unknown>) => request(app).post(`/api/v1/integrations/providers/${row.public_id}/sync`).set('Cookie', cookie);

const seconds = () => Math.floor(Date.now() / 1000);
function webhook(body: unknown, options: { path?: string; secret?: string; timestamp?: number; signature?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const ts = options.timestamp ?? seconds();
  const req = request(app)
    .post(`/api/v1/webhooks/${options.path ?? `telematics/${CODE}`}`)
    .set('Content-Type', 'application/json')
    .set(TIMESTAMP_HEADER, String(ts));
  if (options.signature !== null) req.set(SIGNATURE_HEADER, options.signature ?? signWebhook(options.secret ?? SECRET, ts, raw));
  return req.send(raw);
}
const delivery = (eventId = 'evt-1') => ({ event_id: eventId, kind: 'position', occurred_at: '2026-10-21T09:00:00Z', data: { lat: 9.01, lng: 38.76, speed_kmh: 42 } });
const inboundRows = async () => (await pool.query('SELECT status, external_reference, error_message FROM integration.sync_logs WHERE direction = $1 ORDER BY id', ['inbound'])).rows;

describe('GET /integrations/providers', () => {
  test('lists each provider with what it can do and its state, never its settings or secrets', async () => {
    const cookie = await signIn(['fleet_manager']);
    await provider({ configuration: { timeout_ms: 2000, token: 'stored-by-mistake' } });
    await createProvider({ code: 'no-adapter', name: 'Weather', provider_type: 'weather', is_active: false });

    const res = await request(app).get('/api/v1/integrations/providers').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const mine = res.body.data.find((p: { code: string }) => p.code === CODE);
    expect(mine).toMatchObject({
      code: CODE,
      provider_type: 'telematics',
      is_active: true,
      status: 'unknown',
      capabilities: { sync: true, webhooks: true, health_check: true },
      webhook_secret_configured: true,
      last_success_at: null,
      last_failure_at: null,
      circuit: null,
    });
    expect(res.body.data.find((p: { code: string }) => p.code === 'no-adapter')).toMatchObject({
      status: 'inactive',
      capabilities: { sync: false, webhooks: false, health_check: false },
      webhook_secret_configured: false,
    });
    const text = JSON.stringify(res.body);
    for (const secret of [SECRET, API_KEY, 'stored-by-mistake', 'timeout_ms']) expect(text).not.toContain(secret);
  });

  test('needs integration:read', async () => {
    const res = await request(app).get('/api/v1/integrations/providers').set('Cookie', await signIn(['dispatcher']));
    expect(res.status).toBe(403);
  });

  test('?check=true runs the health checks: operational when it answers, degraded when it fails', async () => {
    const cookie = await signIn();
    await provider();
    mock.answer('/health', { status: 200 });
    expect(await statusOf(cookie, CODE, '?check=true')).toMatchObject({ status: 'operational', health: { healthy: true, error: null } });
    mock.answer('/health', { status: 500 });
    expect(await statusOf(cookie, CODE, '?check=true')).toMatchObject({ status: 'degraded', health: { healthy: false, error: 'GET /health answered 500.' } });
  });
});

describe('POST /integrations/providers/{id}/sync', () => {
  test('answers 202 with the started sync, then records its outcome; the status shows the last success', async () => {
    const cookie = await signIn(['fleet_manager']);
    const row = await provider();
    mock.answer('/sync', { body: { records: 3, batch_id: 'batch-7' } });

    const res = await sync(cookie, row);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ provider_id: row.public_id, direction: 'outbound', status: 'started', trigger: 'manual', request_id: res.headers['x-request-id'] });
    expect(res.body.meta).toMatchObject({ already_running: false });

    await integrationGateway.settled();
    // The provider got the API key from the environment and our request id.
    expect(mock.requests).toEqual([expect.objectContaining({ path: '/sync', headers: expect.objectContaining({ authorization: `Bearer ${API_KEY}`, 'x-request-id': res.headers['x-request-id'] }) })]);
    const status = await statusOf(cookie);
    expect(status).toMatchObject({ status: 'operational', last_failure_at: null, last_sync: { id: res.body.data.id, status: 'succeeded', records: 3, external_reference: 'batch-7' } });
    expect(status.last_success_at).not.toBeNull();

    const audit = await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'integration.sync_logs' AND correlation_id = $1 ORDER BY id", [res.headers['x-request-id']]);
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
  });

  test('a provider timing out 5 times opens the breaker, and the next sync fails fast with 503', async () => {
    const cookie = await signIn();
    const row = await provider({ configuration: { timeout_ms: 50, max_retries: 0 } });
    mock.answer('/sync', { hang: true });

    for (let i = 0; i < 5; i++) {
      expect((await sync(cookie, row)).status).toBe(202);
      await integrationGateway.settled();
    }
    const started = Date.now();
    const refused = await sync(cookie, row);
    expect(Date.now() - started).toBeLessThan(500);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(25);
    expect(mock.requests).toHaveLength(5);

    const status = await statusOf(cookie);
    expect(status).toMatchObject({
      status: 'down',
      last_success_at: null,
      last_error: 'GET /sync timed out after 50 ms.',
      circuit: { state: 'open', window: { calls: 5, failures: 5, timeouts: 5 } },
    });
    expect(status.last_failure_at).not.toBeNull();
  });

  test('a second sync while one runs gets the running one', async () => {
    const cookie = await signIn();
    const row = await provider();
    mock.answer('/sync', { delayMs: 200, body: { records: 1 } });
    const first = await sync(cookie, row);
    const second = await sync(cookie, row);
    expect(second.status).toBe(202);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.meta.already_running).toBe(true);
  });

  test('refuses an unknown provider, one switched off, one without sync, and callers without integration:execute', async () => {
    const cookie = await signIn();
    expect((await sync(cookie, { public_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const off = await sync(cookie, await provider({ is_active: false }));
    expect([off.status, off.body.error.details]).toEqual([400, [{ field: 'provider_id', reason: 'provider_inactive' }]]);
    const none = await sync(cookie, await createProvider({ code: 'weather-x', provider_type: 'weather' }));
    expect([none.status, none.body.error.details]).toEqual([400, [{ field: 'provider_id', reason: 'sync_not_supported' }]]);
    expect((await sync(await signIn(['depot_admin']), await provider({ code: 'mock-fuel' }))).status).toBe(403);
  });
});

describe('POST /webhooks/telematics/{provider}', () => {
  test('a signed delivery is stored, announced for its consumer, and answered 202', async () => {
    const row = await provider();
    const res = await webhook(delivery());
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ id: expect.any(String), status: 'accepted', duplicate: false });

    expect(await inboundRows()).toEqual([{ status: 'succeeded', external_reference: 'evt-1', error_message: null }]);
    const [event] = await publishedEvents(INTEGRATION_EVENTS.webhookReceived);
    expect(event).toMatchObject({
      actor: null,
      aggregate: `provider:${row.public_id}`,
      payload: { sync_log_id: res.body.data.id, provider_id: row.public_id, provider_code: CODE, provider_type: 'telematics', event_id: 'evt-1', kind: 'position' },
    });
    expect(await webhookDeliveries.find(pool, res.body.data.id)).toEqual({
      provider_code: CODE,
      provider_type: 'telematics',
      event_id: 'evt-1',
      kind: 'position',
      occurred_at: '2026-10-21T09:00:00.000Z',
      data: { lat: 9.01, lng: 38.76, speed_kmh: 42 },
    });
    const audit = await pool.query("SELECT user_id, request_source->>'channel' AS channel FROM audit.audit_logs WHERE correlation_id = $1", [res.headers['x-request-id']]);
    expect(audit.rows).toEqual([{ user_id: null, channel: 'webhook' }]);
  });

  test('a redelivery of the same event is a duplicate: 202 again, nothing stored or announced twice', async () => {
    await provider();
    const first = await webhook(delivery('evt-dup'));
    const again = await webhook(delivery('evt-dup'));
    expect(again.status).toBe(202);
    expect(again.body.data).toEqual({ id: first.body.data.id, status: 'accepted', duplicate: true });
    expect(await inboundRows()).toHaveLength(1);
    expect(await publishedEvents(INTEGRATION_EVENTS.webhookReceived)).toHaveLength(1);
  });

  test('a replay older than 5 minutes is rejected, though its signature is genuine', async () => {
    await provider();
    const res = await webhook(delivery(), { timestamp: seconds() - 6 * 60 });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED', details: [{ field: TIMESTAMP_HEADER, reason: 'stale_timestamp' }] });
    expect(await inboundRows()).toEqual([]);
  });

  test('a wrong or missing signature is rejected, and nothing is stored', async () => {
    await provider();
    const wrong = await webhook(delivery(), { secret: 'x'.repeat(48) });
    expect([wrong.status, wrong.body.error.code, wrong.body.error.details[0].reason]).toEqual([401, 'AUTH_TOKEN_INVALID', 'signature_mismatch']);
    const missing = await webhook(delivery(), { signature: null });
    expect([missing.status, missing.body.error.details[0].reason]).toEqual([401, 'missing_signature']);
    // Signed over other bytes than those sent (a proxy re-encoding the JSON would do this).
    const ts = seconds();
    const tampered = await request(app)
      .post(`/api/v1/webhooks/telematics/${CODE}`)
      .set('Content-Type', 'application/json')
      .set(TIMESTAMP_HEADER, String(ts))
      .set(SIGNATURE_HEADER, signWebhook(SECRET, ts, JSON.stringify(delivery())))
      .send(JSON.stringify(delivery(), null, 2));
    expect(tampered.status).toBe(401);
    expect(await inboundRows()).toEqual([]);
    expect(await publishedEvents(INTEGRATION_EVENTS.webhookReceived)).toEqual([]);
  });

  test('a signed body the adapter cannot read is 400, recorded as a failure on the provider', async () => {
    const cookie = await signIn();
    await provider();
    const res = await webhook({ event_id: 'evt-9', kind: 'position' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'data', reason: 'invalid_type' }]);
    expect(await inboundRows()).toEqual([{ status: 'failed', external_reference: null, error_message: 'Webhook payload: data invalid_type' }]);
    expect(await statusOf(cookie)).toMatchObject({ status: 'degraded', last_error: 'Webhook payload: data invalid_type' });
  });

  test('404 for an unknown provider, one switched off, or a path of another type; 415 for a body that is not JSON', async () => {
    await provider();
    expect((await webhook(delivery(), { path: 'telematics/nobody' })).status).toBe(404);
    expect((await webhook(delivery(), { path: `ev/${CODE}` })).status).toBe(404);
    await pool.query('UPDATE integration.external_providers SET is_active = FALSE WHERE code = $1', [CODE]);
    expect((await webhook(delivery())).status).toBe(404);
    await pool.query('UPDATE integration.external_providers SET is_active = TRUE WHERE code = $1', [CODE]);

    const text = await request(app).post(`/api/v1/webhooks/telematics/${CODE}`).set('Content-Type', 'text/plain').send('lat=9');
    expect(text.status).toBe(415);
  });

  test('/health/ready reports the circuits', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.body.metrics.integrations).toEqual({ providers_called: expect.any(Number), circuits_open: expect.any(Number), circuits_half_open: expect.any(Number) });
  });
});
