import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { integrationGateway, mockProviderAdapter } from '../../src/modules/integration';
import { createProvider, createUser } from '../support/factories';
import { startMockProvider, type MockProviderServer } from '../support/mock-provider-server';

// FMS-111 (docs/resilience.md): the provider drill. A provider that starts failing is cut off by its breaker, so the
// feature that uses it fails fast and the API stays up; once it answers again, the breaker closes on its own. The other
// drills (Redis, the AI service, the replica, an API instance) are scripts/ci/check-resilience.sh, on the Compose stack.

const app = createApp();
const PASSWORD = 'Resilience-Test-1';
const CODE = 'mock-telematics';
/** The breaker's reset time for this drill (the smallest a provider may set). */
const RESET_MS = 1_000;

let mock: MockProviderServer;
beforeAll(async () => {
  integrationGateway.register(mockProviderAdapter(CODE));
  mock = await startMockProvider();
});
afterEach(async () => {
  await integrationGateway.settled();
  mock.requests.length = 0;
});
afterAll(async () => {
  integrationGateway.shutdown();
  await mock.close();
});

async function signIn(): Promise<string> {
  const user = await createUser({ roles: ['admin'], password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

describe('drill: a provider fails', () => {
  test('its breaker opens after 5 failures, calls then fail fast while the API stays up, and it closes within the reset time of the provider answering again', async () => {
    const cookie = await signIn();
    const row = await createProvider({ code: CODE, name: 'Mock telematics', base_url: mock.url, configuration: { timeout_ms: 200, max_retries: 0, reset_timeout_ms: RESET_MS } });
    const sync = () => request(app).post(`/api/v1/integrations/providers/${row.public_id}/sync`).set('Cookie', cookie);
    const circuit = async () => {
      const res = await request(app).get('/api/v1/integrations/providers').set('Cookie', cookie);
      return res.body.data.find((p: { code: string }) => p.code === CODE) as { status: string; circuit: { state: string } };
    };

    // The provider fails: 5 syncs reach it and fail.
    mock.answer('/sync', { status: 502, body: { error: 'bad gateway' } });
    for (let i = 0; i < 5; i++) {
      expect((await sync()).status).toBe(202);
      await integrationGateway.settled();
    }
    expect((await circuit()).circuit.state).toBe('open');

    // Cut off: the next call fails at once, says when to retry, and never reaches the provider.
    const started = Date.now();
    const refused = await sync();
    expect(Date.now() - started).toBeLessThan(500);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(refused.headers['retry-after']).toBeDefined();
    expect(mock.requests).toHaveLength(5);

    // The rest of the API is not affected: readiness is 200 and reports the open circuit; other routes answer.
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.metrics.integrations.circuits_open).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/v1/vehicles').set('Cookie', cookie)).status).toBe(200);

    // The provider recovers. Calls are tried again after the reset time; the first success closes the breaker.
    mock.answer('/sync', { body: { records: 1 } });
    const recovered = Date.now();
    let closedAfter: number | null = null;
    while (Date.now() - recovered < RESET_MS + 4_000) {
      const res = await sync();
      if (res.status === 202) {
        await integrationGateway.settled();
        if ((await circuit()).circuit.state === 'closed') {
          closedAfter = Date.now() - recovered;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(closedAfter, 'the breaker never closed').not.toBeNull();
    // Recovery target: the reset time, plus a second for the trial call.
    expect(closedAfter!).toBeLessThanOrEqual(RESET_MS + 1_000);
    expect((await circuit()).status).toBe('operational');
  });
});
