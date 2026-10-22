import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProviderCallError } from '../domain/adapter';
import { DEFAULT_BREAKER, ProviderBreaker } from './circuit-breaker';
import { backoffMs, DEFAULT_CLIENT, HttpProviderClient, type ClientSettings } from './http-client';

const log = { warn: vi.fn(), info: vi.fn() };
const breakers: ProviderBreaker[] = [];
afterEach(() => breakers.splice(0).forEach((b) => b.shutdown()));

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers from a list, one per call, and records what was asked. */
function fakeFetch(...answers: (Response | Error | 'hang')[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === 'hang') {
      // Like a provider that never answers: only the timeout's abort ends it.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, settings: Partial<ClientSettings> = {}, baseUrl: string | null = 'https://provider.test/v1/') {
  const breaker = new ProviderBreaker('mock', DEFAULT_BREAKER, log);
  breakers.push(breaker);
  const sleep = vi.fn(async () => {});
  return {
    breaker,
    sleep,
    http: new HttpProviderClient({ code: 'mock', baseUrl, settings: { ...DEFAULT_CLIENT, ...settings }, breaker, correlationId: 'corr-1', fetch: fetchImpl, sleep, random: () => 0.5 }),
  };
}

describe('HttpProviderClient', () => {
  test('joins the path to the base URL, sends JSON with the request id, and parses JSON', async () => {
    const { fn, calls } = fakeFetch(json(200, { records: 3 }));
    const res = await client(fn).http.call({ method: 'POST', path: '/sync', query: { since: 5 }, body: { a: 1 } });
    expect(res).toMatchObject({ status: 200, body: { records: 3 } });
    expect(calls[0].url).toBe('https://provider.test/v1/sync?since=5');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'error' });
    expect(calls[0].init.headers).toMatchObject({ 'x-request-id': 'corr-1', 'content-type': 'application/json' });
  });

  test('refuses a path that could leave the base URL', async () => {
    const { http } = client(fakeFetch(json(200)).fn);
    await expect(http.call({ method: 'GET', path: 'https://evil.test/x' })).rejects.toThrow(/relative to the base URL/);
    await expect(http.call({ method: 'GET', path: '/a/../../admin' })).rejects.toThrow(/relative to the base URL/);
  });

  test('retries an idempotent call on 5xx, network errors and 429, with jittered backoff', async () => {
    const { fn, calls } = fakeFetch(json(503), new TypeError('fetch failed'), json(200, { ok: true }));
    const { http, sleep } = client(fn);
    await expect(http.call({ method: 'GET', path: '/vehicles' })).resolves.toMatchObject({ body: { ok: true } });
    expect(calls).toHaveLength(3);
    // random() = 0.5: half of 200 ms, then half of 400 ms.
    expect(sleep.mock.calls).toEqual([[100], [200]]);

    const limited = fakeFetch(json(429), json(200));
    await expect(client(limited.fn).http.call({ method: 'GET', path: '/x' })).resolves.toMatchObject({ status: 200 });
  });

  test('gives up after maxRetries and reports the last failure without the provider body', async () => {
    const { fn, calls } = fakeFetch(new Response('secret stack trace', { status: 500 }));
    const err = await client(fn, { maxRetries: 2 }).http.call({ method: 'GET', path: '/vehicles' }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(err).toMatchObject({ kind: 'http', status: 500, message: 'GET /vehicles answered 500.' });
  });

  test('does not retry a POST unless it is marked idempotent', async () => {
    const once = fakeFetch(json(503));
    await expect(client(once.fn).http.call({ method: 'POST', path: '/orders' })).rejects.toMatchObject({ status: 503 });
    expect(once.calls).toHaveLength(1);

    const keyed = fakeFetch(json(503), json(201));
    await expect(client(keyed.fn).http.call({ method: 'POST', path: '/orders', idempotent: true })).resolves.toMatchObject({ status: 201 });
    expect(keyed.calls).toHaveLength(2);
  });

  test("does not retry the request's own errors (4xx)", async () => {
    const { fn, calls } = fakeFetch(json(404));
    await expect(client(fn).http.call({ method: 'GET', path: '/vehicles/9' })).rejects.toMatchObject({ kind: 'http', status: 404 });
    expect(calls).toHaveLength(1);
  });

  test('cancels an attempt that runs past the timeout', async () => {
    const { fn } = fakeFetch('hang');
    const err = await client(fn, { timeoutMs: 20, maxRetries: 0 }).http.call({ method: 'GET', path: '/slow' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: 'timeout', message: 'GET /slow timed out after 20 ms.' });
  });

  test('5 timeouts open the breaker; the next call fails fast without reaching the provider', async () => {
    const { fn, calls } = fakeFetch('hang');
    const { http, breaker } = client(fn, { timeoutMs: 10, maxRetries: 0 });
    for (let i = 0; i < 5; i++) await expect(http.call({ method: 'GET', path: '/slow' })).rejects.toMatchObject({ kind: 'timeout' });
    expect(breaker.state).toBe('open');

    const started = Date.now();
    await expect(http.call({ method: 'GET', path: '/slow' })).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(Date.now() - started).toBeLessThan(10);
    expect(calls).toHaveLength(5);
  });

  test('a provider without a base URL is a failure, not a crash', async () => {
    await expect(client(fakeFetch(json(200)).fn, {}, null).http.call({ method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('backoffMs', () => {
  test('is random up to base * 2^attempt, capped', () => {
    const s = { retryBaseMs: 200, retryCapMs: 2_000 };
    expect(backoffMs(0, s, () => 0)).toBe(0);
    expect(backoffMs(0, s, () => 0.999)).toBe(199);
    expect(backoffMs(3, s, () => 0.999)).toBe(1598);
    expect(backoffMs(10, s, () => 0.999)).toBe(1998);
  });
});
