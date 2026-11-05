import { Router } from 'express';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { modules } from '../../src/modules';
import { RequestRecorder, systemHealth } from '../../src/modules/system';
import { publicRoute } from '../../src/shared/authz/route-policy';
import { RedisCache } from '../../src/shared/cache';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { runJob } from '../../src/shared/jobs/scheduler';
import { createUser, type RoleName } from '../support/factories';

// FMS-143: the system health screen's API. Samples are taken by a sampler the test drives minute by minute,
// with the server's own checks; Redis is stopped by pointing its check at a port nothing listens on.

const app = createApp();
const PASSWORD = 'System-Health-1';
const MINUTE = 60_000;

// A Redis client to a port with nothing on it: never connects, never retries, refuses commands at once.
const deadRedis = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
const stoppedRedis = new RedisCache(deadRedis, 'fms-test-dead', () => {});
const runningRedis = { state: () => 'ok' as const, ping: async () => 'PONG' };
deadRedis.on('error', () => {});
afterAll(() => deadRedis.disconnect());

async function signIn(roles: RoleName[]): Promise<string> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (cookie: string, path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
/** A minute from the start of the current one; `base` pins "current" for a test that may cross a minute. */
const minuteStart = (offset: number, base = Date.now()) => new Date(Math.floor(base / MINUTE) * MINUTE + offset * MINUTE);

/** Takes one sample per minute for the six minutes before `base`, Redis stopped for the 2nd to the 4th. */
async function sampleSixMinutesWithRedisStoppedForThree(base: number): Promise<void> {
  for (let m = -6; m <= -1; m++) {
    const stopped = m >= -5 && m <= -3;
    const sampler = systemHealth.samplerWith(systemHealth.probes({ redis: stopped ? stoppedRedis : runningRedis }), new RequestRecorder());
    await sampler.sample(minuteStart(m, base));
    await sampler.flush();
  }
}

describe('GET /system/health', () => {
  test('admin only (system:read)', async () => {
    expect((await request(app).get('/api/v1/system/health')).status).toBe(401);
    const manager = await signIn(['fleet_manager']);
    expect((await get(manager, '/system/health')).status).toBe(403);
    expect((await get(manager, '/system/health/history')).status).toBe(403);
    const admin = await signIn(['admin']);
    const res = await get(admin, '/system/health');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('nothing sampled yet: every component listed, no data, no uptime', async () => {
    const res = await get(await signIn(['admin']), '/system/health');
    expect(res.body.data).toMatchObject({ sampled_from: null, outages: [], outages_total: 0 });
    const components = res.body.data.components as { component: string; status: string; uptime: Record<string, { uptime_pct: number | null }> }[];
    expect(components.slice(0, 5).map((c) => c.component)).toEqual(['api', 'database', 'replica', 'redis', 'ai_service']);
    // The API answering is up; the others have no sample.
    expect(components.find((c) => c.component === 'api')!.status).toBe('ok');
    expect(components.find((c) => c.component === 'redis')).toMatchObject({ status: 'no_data', uptime: { '24h': { uptime_pct: null } } });
  });

  test('Redis stopped for 3 minutes is a 3-minute outage, and the uptime matches the samples', async () => {
    const base = Date.now();
    await sampleSixMinutesWithRedisStoppedForThree(base);
    const res = await get(await signIn(['admin']), '/system/health');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.sampled_from).toBe(minuteStart(-6, base).toISOString());

    const byName = Object.fromEntries((data.components as { component: string }[]).map((c) => [c.component, c]));
    expect(byName.api).toMatchObject({ kind: 'api', status: 'ok', uptime: { '24h': { uptime_pct: 100, ok_minutes: 6, down_minutes: 0 } } });
    expect(byName.database).toMatchObject({ status: 'ok', latency_ms: expect.any(Number), uptime: { '24h': { uptime_pct: 100, ok_minutes: 6 } } });
    expect(byName.redis).toMatchObject({
      label: 'Redis',
      status: 'ok',
      error: null,
      uptime: { '24h': { uptime_pct: 50, ok_minutes: 3, down_minutes: 3 }, '7d': { uptime_pct: 50 }, '30d': { uptime_pct: 50 } },
    });

    const redisOutages = (data.outages as { component: string }[]).filter((o) => o.component === 'redis');
    expect(redisOutages).toEqual([
      {
        component: 'redis',
        label: 'Redis',
        started_at: minuteStart(-5, base).toISOString(),
        ended_at: minuteStart(-2, base).toISOString(),
        duration_minutes: 3,
        error: expect.stringMatching(/writeable|ECONNREFUSED|closed/i),
      },
    ]);

    // The status strip: the last 15-minute cell holds the 3 down minutes and the 3 up.
    const history = await get(await signIn(['admin']), '/system/health/history?window=24h');
    expect(history.status).toBe(200);
    expect(history.body.data).toMatchObject({ window: '24h', bucket_minutes: 15 });
    expect(history.body.data.requests.cells).toHaveLength(96);
    const redisCells = history.body.data.components.find((c: { component: string }) => c.component === 'redis').cells as { ok_minutes: number; down_minutes: number }[];
    expect(redisCells.reduce((s, c) => s + c.down_minutes, 0)).toBe(3);
    expect(redisCells.reduce((s, c) => s + c.ok_minutes, 0)).toBe(3);
  });

  test('a component down in the last minute is down now, with its error, and the outage goes on', async () => {
    for (const m of [-3, -2, -1]) {
      const sampler = systemHealth.samplerWith(systemHealth.probes({ redis: m === -3 ? runningRedis : stoppedRedis }), new RequestRecorder());
      await sampler.sample(minuteStart(m));
      await sampler.flush();
    }
    const data = (await get(await signIn(['admin']), '/system/health')).body.data;
    expect(data.components.find((c: { component: string }) => c.component === 'redis')).toMatchObject({ status: 'down', error: expect.any(String) });
    expect(data.outages.find((o: { component: string }) => o.component === 'redis')).toMatchObject({ ended_at: null, duration_minutes: expect.any(Number) });
  });

  test('a failed scheduled job appears with its error', async () => {
    const outcome = await runJob(
      {
        name: 'system-health-test-job',
        at: '00:00',
        run: async () => {
          throw new Error('The provider did not answer within 10 s');
        },
      },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test' },
    );
    expect(outcome.status).toBe('failed');
    const data = (await get(await signIn(['admin']), '/system/health')).body.data;
    expect(data.failed_jobs_total).toBeGreaterThanOrEqual(1);
    expect(data.failed_jobs[0]).toMatchObject({
      job: 'system-health-test-job',
      attempts: 1,
      error: 'The provider did not answer within 10 s',
      failed_at: expect.any(String),
    });
  });
});

describe('request rollups', () => {
  test('requests and 5xx answers are counted per minute, counts only; the history adds them up with a p95', async () => {
    const boom = createApp({
      modules: [
        {
          name: 'boom',
          router: Router().get('/boom', publicRoute(), () => {
            throw new Error('boom');
          }),
        },
      ],
    });
    systemHealth.requests.take();
    const admin = await signIn(['admin']);
    await get(admin, '/system/health');
    expect((await request(boom).get('/api/v1/boom')).status).toBe(500);
    // Health checks are left out.
    await request(app).get('/health/live');

    const counted = systemHealth.requests.take();
    const total = counted.reduce((s, m) => ({ requests: s.requests + m.requests, errors: s.errors + m.errors5xx }), { requests: 0, errors: 0 });
    // The sign-in, the summary and the 500.
    expect(total).toEqual({ requests: 3, errors: 1 });
    // Only the minute, the counts and the histogram: no path, user or id.
    expect(Object.keys(counted[0]).sort()).toEqual(['errors5xx', 'latencyBuckets', 'minute', 'requests']);

    // Written as they would be a minute ago, by two instances: added up.
    const counts = new RequestRecorder();
    for (let i = 0; i < 19; i++) counts.record(200, 40, minuteStart(-2).getTime());
    counts.record(503, 900, minuteStart(-2).getTime());
    const other = new RequestRecorder();
    for (let i = 0; i < 20; i++) other.record(200, 40, minuteStart(-2).getTime() + 30_000);
    const noProbes = async () => [];
    await systemHealth.samplerWith(noProbes, counts).flush();
    await systemHealth.samplerWith(noProbes, other).flush();

    const history = await get(admin, '/system/health/history?window=24h');
    expect(history.body.data.requests).toMatchObject({ requests: 40, errors_5xx: 1, error_rate_pct: 2.5, p95_ms: expect.any(Number) });
    // 39 of 40 at 40 ms: the 95th is in (25, 50].
    expect(history.body.data.requests.p95_ms).toBeGreaterThan(25);
    expect(history.body.data.requests.p95_ms).toBeLessThanOrEqual(50);
    const last = history.body.data.requests.cells.at(-1);
    expect(last).toMatchObject({ requests: 40, errors_5xx: 1 });
  });

  test('history: a window is 24h, 7d or 30d', async () => {
    const admin = await signIn(['admin']);
    expect((await get(admin, '/system/health/history?window=7d')).body.data).toMatchObject({ window: '7d', bucket_minutes: 120 });
    expect((await get(admin, '/system/health/history?window=30d')).body.data.requests.cells).toHaveLength(90);
    expect((await get(admin, '/system/health/history?window=1h')).status).toBe(400);
  });
});

test('samples and request counts older than 30 days are removed', async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * MINUTE);
  const recent = minuteStart(-1);
  for (const minute of [old, recent]) {
    const counts = new RequestRecorder();
    counts.record(200, 10, minute.getTime());
    const sampler = systemHealth.samplerWith(systemHealth.probes({ redis: runningRedis }), counts);
    await sampler.sample(minute);
    await sampler.flush();
  }
  const removed = await systemHealth.retention(new Date());
  expect(removed.samples_deleted).toBeGreaterThanOrEqual(5);
  expect(removed.request_minutes_deleted).toBe(1);
  const left = await pool.query<{ n: number }>(`SELECT count(DISTINCT minute)::int AS n FROM system.health_samples`);
  expect(left.rows[0].n).toBe(1);
});

test('the system module is mounted', () => {
  expect(modules.map((m) => m.name)).toContain('system');
});
