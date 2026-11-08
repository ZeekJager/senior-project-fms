import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { FallbackRateStore, MemoryRateStore, RedisRateStore, WINDOW_MS, rulesFor, type RateLimits, type RateStore } from '../../src/shared/http/rate-limit';
import { createUser } from '../support/factories';

// FMS-103 (docs/security.md): rate limits by kind of client.

const PASSWORD = 'RateLimit-Test-1';
const LIMITS: RateLimits = { session: 5, upload: 2, device: 3, webhook: 3, anonymous: 4, auth: 3, ipCeiling: 50 };

/** An app with its own counters and clock: the limits are on, small, and a minute can pass in a line. */
function limited(overrides: Partial<RateLimits> = {}, store?: RateStore) {
  let now = 1_000_000;
  const memory = new MemoryRateStore(() => now);
  const app = createApp({ rateLimit: { store: store ?? memory, limits: { ...LIMITS, ...overrides } } });
  return { app, pass: (ms: number) => (now += ms) };
}

/** Signs in through an app with no limits (the session works on any app: same secret, same database), so signing in is not what is counted. */
async function signIn() {
  const user = await createUser({ roles: ['admin'], password: PASSWORD });
  const res = await request(createApp()).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const statuses = async (n: number, send: () => Promise<{ status: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
};

describe('anonymous callers, by address', () => {
  test('are limited, then refused with 429 RATE_LIMITED, Retry-After and the policy named', async () => {
    const { app } = limited();
    const answers = await statuses(5, () => request(app).get('/api/v1/auth/me'));
    expect(answers).toEqual([401, 401, 401, 401, 429]);
    const refused = await request(app).get('/api/v1/auth/me');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', details: [{ reason: 'anonymous' }] });
    expect(refused.body.meta.request_id).toBeTruthy();
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(refused.headers['ratelimit-limit']).toBe('4');
    expect(refused.headers['ratelimit-remaining']).toBe('0');
  });

  test('every answer says how much is left', async () => {
    const { app } = limited();
    const first = await request(app).get('/api/v1/auth/me');
    expect(first.headers['ratelimit-limit']).toBe('4');
    expect(first.headers['ratelimit-remaining']).toBe('3');
    const second = await request(app).get('/api/v1/auth/me');
    expect(second.headers['ratelimit-remaining']).toBe('2');
    expect(Number(second.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  test('start again when the minute is over', async () => {
    const { app, pass } = limited();
    await statuses(5, () => request(app).get('/api/v1/auth/me'));
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(429);
    pass(WINDOW_MS + 1);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });

  test('the health probes are never counted', async () => {
    const { app } = limited({ anonymous: 1, ipCeiling: 2 });
    expect(await statuses(10, () => request(app).get('/health/live'))).toEqual(Array(10).fill(200));
  });

  test('the sign-in calls have a lower limit of their own, for the address', async () => {
    const { app } = limited();
    const answers = await statuses(4, () => request(app).post('/api/v1/auth/login').send({ email: 'nobody@fms.local', password: 'x'.repeat(12) }));
    expect(answers).toEqual([401, 401, 401, 429]);
    const refused = await request(app).post('/api/v1/auth/refresh');
    expect(refused.status).toBe(429);
    expect(refused.body.error.details).toEqual([{ reason: 'auth' }]);
  });
});

describe('signed-in browsers, by session', () => {
  test('are limited per session; the anonymous limit does not apply to them, and another session is not affected', async () => {
    const { app } = limited({ anonymous: 1 });
    const mine = await signIn();
    const theirs = await signIn();
    const answers = await statuses(7, () => request(app).get('/api/v1/auth/me').set('Cookie', mine));
    expect(answers).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', theirs)).status).toBe(200);
    const refused = await request(app).get('/api/v1/auth/me').set('Cookie', mine);
    expect(refused.body.error.details).toEqual([{ reason: 'session' }]);
  });

  test('uploads are limited more tightly, as well', async () => {
    const { app } = limited({ session: 50 });
    const cookie = await signIn();
    const upload = () => request(app).post('/api/v1/documents').set('Cookie', cookie).attach('file', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' });
    const answers = await statuses(3, upload);
    expect(answers[0]).not.toBe(429);
    expect(answers[1]).not.toBe(429);
    expect(answers[2]).toBe(429);
    expect((await upload()).body.error.details).toEqual([{ reason: 'upload' }]);
    // Reads by the same session are not uploads.
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  test('a made-up cookie per request does not get round the limit: the address has a ceiling', async () => {
    const { app } = limited({ ipCeiling: 6 });
    const answers = await statuses(8, () => request(app).get('/api/v1/auth/me').set('Cookie', `fms_access=forged-${Math.random()}`));
    expect(answers.filter((s) => s === 429)).toHaveLength(2);
    const refused = await request(app).get('/api/v1/auth/me').set('Cookie', `fms_access=forged-${Math.random()}`);
    expect(refused.body.error.details).toEqual([{ reason: 'ip_ceiling' }]);
  });
});

describe('devices and webhooks', () => {
  test('a device is counted by its token, whatever the address', async () => {
    const { app } = limited();
    const ping = (token: string) => request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: [] });
    expect((await statuses(4, () => ping('device-one'))).at(-1)).toBe(429);
    expect((await ping('device-two')).status).not.toBe(429);
    expect((await ping('device-one')).body.error.details).toEqual([{ reason: 'device' }]);
  });

  test('a provider’s webhooks are counted per provider; another provider’s are not', async () => {
    const { app } = limited();
    const hook = (provider: string) => request(app).post(`/api/v1/webhooks/telematics/${provider}`).send({});
    const answers = await statuses(4, () => hook('alpha'));
    expect(answers.at(-1)).toBe(429);
    expect(answers.slice(0, 3)).not.toContain(429);
    expect((await hook('beta')).status).not.toBe(429);
    expect((await hook('alpha')).body.error.details).toEqual([{ reason: 'webhook' }]);
  });
});

describe('when the counter fails', () => {
  test('the request goes through: a broken counter must not take the API down', async () => {
    const broken: RateStore = { hit: () => Promise.reject(new Error('redis is down')) };
    const { app } = limited({}, broken);
    expect(await statuses(10, () => request(app).get('/api/v1/auth/me'))).toEqual(Array(10).fill(401));
  });
});

describe('rulesFor: who is counted as what', () => {
  const req = (over: { path?: string; ip?: string; headers?: Record<string, string> }) => {
    const headers = Object.fromEntries(Object.entries(over.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { path: over.path ?? '/api/v1/vehicles', ip: over.ip ?? '10.0.0.1', headers, get: (name: string) => headers[name.toLowerCase()] } as Parameters<typeof rulesFor>[0];
  };
  const names = (r: ReturnType<typeof rulesFor>) => r.map((x) => x.policy);

  test('everyone has the address ceiling; nobody signed in is anonymous', () => {
    expect(names(rulesFor(req({}), LIMITS))).toEqual(['ip_ceiling', 'anonymous']);
  });

  test('a session is one key per access cookie, not per address: an office behind one address is not one client', () => {
    const a = rulesFor(req({ headers: { cookie: 'fms_access=token-a; other=1' } }), LIMITS);
    const b = rulesFor(req({ headers: { cookie: 'fms_access=token-b' } }), LIMITS);
    const c = rulesFor(req({ headers: { cookie: 'fms_access=token-a' }, ip: '10.9.9.9' }), LIMITS);
    expect(names(a)).toEqual(['ip_ceiling', 'session']);
    expect(a[1].key).not.toBe(b[1].key);
    expect(a[1].key).toBe(c[1].key);
    expect(a[1].key).not.toContain('token-a');
  });

  test('a device’s token, a provider and the sign-in paths have their own', () => {
    expect(names(rulesFor(req({ headers: { authorization: 'Bearer abc' } }), LIMITS))).toEqual(['ip_ceiling', 'device']);
    expect(names(rulesFor(req({ path: '/api/v1/webhooks/telematics/x' }), LIMITS))).toEqual(['ip_ceiling', 'webhook']);
    expect(names(rulesFor(req({ path: '/api/v1/auth/login' }), LIMITS))).toEqual(['ip_ceiling', 'auth', 'anonymous']);
  });

  test('an upload is counted as one, on top of its session', () => {
    expect(names(rulesFor(req({ headers: { cookie: 'fms_access=t', 'content-type': 'multipart/form-data; boundary=x' } }), LIMITS))).toEqual(['ip_ceiling', 'session', 'upload']);
  });
});

describe('the counters', () => {
  test('memory: a window starts at the first request and ends a minute after it', async () => {
    let now = 0;
    const store = new MemoryRateStore(() => now);
    expect((await store.hit('k', WINDOW_MS)).count).toBe(1);
    now = 30_000;
    expect(await store.hit('k', WINDOW_MS)).toEqual({ count: 2, ttlMs: 30_000 });
    now = WINDOW_MS;
    expect((await store.hit('k', WINDOW_MS)).count).toBe(1);
    expect((await store.hit('other', WINDOW_MS)).count).toBe(1);
  });

  test('redis: INCR, the window set on the first hit only (NX), and the time left', async () => {
    const calls: unknown[][] = [];
    const chain = {
      incr: (k: string) => (calls.push(['incr', k]), chain),
      pexpire: (k: string, ms: number, mode: string) => (calls.push(['pexpire', k, ms, mode]), chain),
      pttl: (k: string) => (calls.push(['pttl', k]), chain),
      exec: async () => [[null, 3], [null, 0], [null, 41_500]],
    };
    const store = new RedisRateStore({ multi: () => chain } as never, (k) => `fms:throttle:rl:${k}`);
    expect(await store.hit('ip:1.2.3.4', WINDOW_MS)).toEqual({ count: 3, ttlMs: 41_500 });
    expect(calls).toEqual([
      ['incr', 'fms:throttle:rl:ip:1.2.3.4'],
      ['pexpire', 'fms:throttle:rl:ip:1.2.3.4', WINDOW_MS, 'NX'],
      ['pttl', 'fms:throttle:rl:ip:1.2.3.4'],
    ]);
  });

  test('redis down: counted in memory instead, and said once per failure, never open', async () => {
    const down: RateStore = { hit: () => Promise.reject(new Error('ECONNREFUSED')) };
    const seen = vi.fn();
    const store = new FallbackRateStore(down, new MemoryRateStore(), seen);
    expect((await store.hit('k', WINDOW_MS)).count).toBe(1);
    expect((await store.hit('k', WINDOW_MS)).count).toBe(2);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test('no redis configured: memory, silently', async () => {
    const seen = vi.fn();
    const store = new FallbackRateStore(null, new MemoryRateStore(), seen);
    expect((await store.hit('k', WINDOW_MS)).count).toBe(1);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('the configured limits', () => {
  test('are the defaults of docs/security.md', () => {
    expect(config.rateLimits).toEqual({ session: 600, upload: 30, device: 120, webhook: 600, anonymous: 120, auth: 30, ipCeiling: 3000 });
  });
});
