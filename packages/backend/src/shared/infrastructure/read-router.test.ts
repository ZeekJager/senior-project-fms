import type { QueryResult } from 'pg';
import { describe, expect, test } from 'vitest';
import { isReplicaUnavailable, ReadRouter } from './read-router';

const result = (rows: unknown[]) => ({ rows, rowCount: rows.length }) as unknown as QueryResult;

/** A fake database: answers the lag check with `lag`, and every other query with its name. */
function fakeDb(name: string, options: { lag?: number; fail?: () => unknown } = {}) {
  const calls: string[] = [];
  return {
    calls,
    lag: options.lag ?? 0,
    fail: options.fail,
    async query(text: string) {
      calls.push(text.startsWith('SELECT pg_is_in_recovery()') ? 'lag?' : text);
      if (this.fail) throw this.fail();
      if (text.startsWith('SELECT pg_is_in_recovery()')) return result([{ standby: true, lag: this.lag }]);
      return result([{ from: name }]);
    },
  };
}

const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

function setup(replicaOptions: { lag?: number; fail?: () => unknown } = {}, maxLagSeconds = 30) {
  let now = Date.parse('2026-10-29T08:00:00Z');
  const primary = fakeDb('primary');
  const replica = fakeDb('replica', replicaOptions);
  const warnings: string[] = [];
  const router = new ReadRouter(primary, replica, { maxLagSeconds, checkEveryMs: 5_000, retryAfterMs: 30_000, now: () => now, log: { warn: (_o, msg) => warnings.push(msg) } });
  return { primary, replica, router, warnings, tick: (ms: number) => (now += ms), at: () => now };
}

describe('ReadRouter (FMS-94)', () => {
  test('reads the replica when it is up, and says how far behind it is', async () => {
    const { router, replica, primary, at } = setup({ lag: 3 });
    const session = await router.session();
    expect((await session.query('SELECT 1')).rows).toEqual([{ from: 'replica' }]);
    expect(session.freshness()).toEqual({ source: 'replica', lag_seconds: 3, as_of: new Date(at() - 3000).toISOString() });
    expect(primary.calls).toEqual([]);
    expect(replica.calls).toEqual(['lag?', 'SELECT 1']);
    expect(router.state()).toBe('ok');
  });

  test('checks the replica at most every 5 s, one check shared by concurrent sessions', async () => {
    const { router, replica, tick } = setup();
    await Promise.all([router.session(), router.session(), router.session()]);
    await router.session();
    expect(replica.calls).toEqual(['lag?']);
    tick(5_000);
    await router.session();
    expect(replica.calls).toEqual(['lag?', 'lag?']);
  });

  test('further behind than the limit: reads the primary, degraded, and back once it catches up', async () => {
    const { router, replica, warnings, tick } = setup({ lag: 45 });
    const session = await router.session();
    expect((await session.query('SELECT 1')).rows).toEqual([{ from: 'primary' }]);
    expect(session.freshness()).toMatchObject({ source: 'primary', lag_seconds: 0 });
    expect(router.state()).toBe('degraded');
    await expect(router.ping()).rejects.toThrow('45 s behind');
    expect(warnings).toEqual(['read replica too far behind: reading the primary']);

    replica.lag = 2;
    tick(5_000);
    expect((await router.session()).freshness()).toMatchObject({ source: 'replica', lag_seconds: 2 });
    expect(router.state()).toBe('ok');
  });

  test('down: reads the primary, does not try again for 30 s, then recovers', async () => {
    const { router, replica, tick } = setup({ fail: refused });
    const session = await router.session();
    expect((await session.query('SELECT 1')).rows).toEqual([{ from: 'primary' }]);
    expect(router.state()).toBe('degraded');
    expect(await router.metrics()).toEqual({ lag_seconds: -1, in_use: 0, max_lag_seconds: 30, fallbacks: 1 });

    tick(29_000);
    await router.session();
    expect(replica.calls).toEqual(['lag?']);

    replica.fail = undefined;
    tick(1_000);
    expect((await router.session()).freshness().source).toBe('replica');
    expect(replica.calls).toEqual(['lag?', 'lag?']);
  });

  test('a replica that fails during a request: the rest of it reads the primary, keeping the lag of what it read', async () => {
    const { router, replica, primary } = setup({ lag: 4 });
    const session = await router.session();
    await session.query('SELECT a');
    replica.fail = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

    expect((await session.query('SELECT b')).rows).toEqual([{ from: 'primary' }]);
    await session.query('SELECT c');
    expect(primary.calls).toEqual(['SELECT b', 'SELECT c']);
    expect(session.freshness()).toMatchObject({ source: 'primary', lag_seconds: 4 });
    expect(router.state()).toBe('degraded');
  });

  test('a query error is not a fallback: the primary would refuse it too', async () => {
    const { router, replica, primary } = setup();
    const session = await router.session();
    replica.fail = () => Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    await expect(session.query('SELECT * FROM x')).rejects.toThrow('does not exist');
    expect(primary.calls).toEqual([]);
    expect(router.state()).toBe('ok');
  });

  test('without a replica every session is the primary, and readiness says disabled', async () => {
    const primary = fakeDb('primary');
    const router = new ReadRouter(primary, null, { maxLagSeconds: 30 });
    const session = await router.session();
    expect((await session.query('SELECT 1')).rows).toEqual([{ from: 'primary' }]);
    expect(session.freshness()).toMatchObject({ source: 'primary', lag_seconds: 0 });
    expect(router.state()).toBe('disabled');
    expect(await router.metrics()).toMatchObject({ in_use: 0, fallbacks: 0 });
  });

  test('which errors mean the replica cannot serve', () => {
    expect(isReplicaUnavailable(refused())).toBe(true);
    expect(isReplicaUnavailable({ code: '08006' })).toBe(true);
    expect(isReplicaUnavailable({ code: '57P03' })).toBe(true);
    expect(isReplicaUnavailable({ code: '40001', message: 'canceling statement due to conflict with recovery' })).toBe(true);
    expect(isReplicaUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isReplicaUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isReplicaUnavailable({ code: '23505' })).toBe(false);
    expect(isReplicaUnavailable({ code: '25006', message: 'cannot execute INSERT in a read-only transaction' })).toBe(false);
    expect(isReplicaUnavailable(null)).toBe(false);
  });
});
