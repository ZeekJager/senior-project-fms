import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProviderCallError } from '../domain/adapter';
import { DEFAULT_BREAKER, ProviderBreaker } from './circuit-breaker';

const log = { warn: vi.fn(), info: vi.fn() };
let breaker: ProviderBreaker;

const timeout = () => Promise.reject(new ProviderCallError('timeout', 'GET /vehicles timed out after 5000 ms'));
const notFound = () => Promise.reject(new ProviderCallError('http', 'GET /vehicles/9 answered 404', 404));
const ok = () => Promise.resolve('ok');

async function failTimes(n: number, action: () => Promise<unknown> = timeout) {
  for (let i = 0; i < n; i++) await expect(breaker.fire(action)).rejects.toBeInstanceOf(ProviderCallError);
}

beforeEach(() => {
  vi.useFakeTimers();
  log.warn.mockClear();
  log.info.mockClear();
  breaker = new ProviderBreaker('mock-telematics', DEFAULT_BREAKER, log);
});
afterEach(() => {
  breaker.shutdown();
  vi.useRealTimers();
});

describe('ProviderBreaker', () => {
  test('stays closed through 4 timeouts and opens on the 5th', async () => {
    await failTimes(4);
    expect(breaker.state).toBe('closed');
    await failTimes(1);
    expect(breaker.state).toBe('open');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock-telematics', event: 'integration.circuit_opened' }), 'Provider circuit opened');
    expect(breaker.view()).toMatchObject({ state: 'open', window: { calls: 5, failures: 5, timeouts: 5, rejected: 0 } });
  });

  test('while open, fails fast without calling the provider, and says when to retry', async () => {
    await failTimes(5);
    const action = vi.fn(ok);
    const err = await breaker.fire(action).catch((e: unknown) => e);
    expect(action).not.toHaveBeenCalled();
    expect(err).toMatchObject({ kind: 'circuit_open', retryInMs: DEFAULT_BREAKER.resetTimeoutMs });
    vi.advanceTimersByTime(10_000);
    expect(breaker.retryInMs()).toBe(20_000);
    expect(breaker.view()).toMatchObject({ window: { rejected: 1 }, retry_at: new Date(Date.now() + 20_000) });
  });

  test('half-opens after the reset timeout; a successful trial closes it with a clean window', async () => {
    await failTimes(5);
    vi.advanceTimersByTime(DEFAULT_BREAKER.resetTimeoutMs);
    expect(breaker.state).toBe('half_open');

    await expect(breaker.fire(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(breaker.view().window).toEqual({ calls: 0, successes: 0, failures: 0, timeouts: 0, rejected: 0 });
    // The old failures are gone: it takes 5 new ones to open it again.
    await failTimes(4);
    expect(breaker.state).toBe('closed');
  });

  test('a failed trial opens it again for another reset timeout', async () => {
    await failTimes(5);
    vi.advanceTimersByTime(DEFAULT_BREAKER.resetTimeoutMs);
    await failTimes(1);
    expect(breaker.state).toBe('open');
    expect(breaker.retryInMs()).toBe(DEFAULT_BREAKER.resetTimeoutMs);
  });

  test("never opens on the request's own errors (404), which the provider answered", async () => {
    await failTimes(10, notFound);
    expect(breaker.state).toBe('closed');
    expect(breaker.view().window).toMatchObject({ calls: 10, failures: 0 });
  });
});

describe('ProviderBreaker window', () => {
  test('counts successes toward the 5 calls: after one success, 4 failures out of 5 open it', async () => {
    await expect(breaker.fire(ok)).resolves.toBe('ok');
    await failTimes(3);
    expect(breaker.state).toBe('closed');
    await failTimes(1);
    expect(breaker.state).toBe('open');
  });
});
