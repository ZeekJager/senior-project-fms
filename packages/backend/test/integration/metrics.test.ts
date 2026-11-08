import request from 'supertest';
import { afterAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { runJob } from '../../src/shared/jobs/scheduler';
import { setMetricReaders } from '../../src/shared/metrics/domain-metrics';
import { startMetricsServer, metricsApp } from '../../src/shared/metrics/metrics-server';
import { metricsRegistry } from '../../src/shared/metrics/registry';
import { startMockProvider } from '../support/mock-provider-server';

// FMS-75: metrics in Prometheus' format, on an internal port; readiness with the AI service (docs/metrics.md).

const app = createApp();
const scrape = async () => (await request(metricsApp(metricsRegistry, null)).get('/metrics')).text;

/** The value of one series of a scrape: `name{labels}` with the labels in any order, or null. */
function series(text: string, name: string, labels: Record<string, string> = {}): number | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    const found = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (found) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return null;
}

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';

describe('GET /metrics', () => {
  test('is Prometheus text, with the process metrics and the service label', async () => {
    const res = await request(metricsApp(metricsRegistry, null)).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toMatch(/process_cpu_user_seconds_total\{service="fms-backend"\}/);
    expect(res.text).toContain('nodejs_eventloop_lag_seconds');
  });

  test('is not served by the public app, nor by the metrics app on any other path', async () => {
    expect((await request(app).get('/metrics')).status).toBe(404);
    expect((await request(app).get('/api/v1/metrics')).status).toBe(404);
    expect((await request(metricsApp(metricsRegistry, null)).get('/api/v1/vehicles')).status).toBe(404);
    expect((await request(metricsApp(metricsRegistry, null)).post('/metrics')).status).toBe(404);
  });

  test('with a token it needs it as a bearer token: 401 without, with a wrong one, 200 with the right one', async () => {
    const guarded = metricsApp(metricsRegistry, 'scrape-token-0123456789');
    const none = await request(guarded).get('/metrics');
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.text).not.toContain('http_request_duration');
    expect((await request(guarded).get('/metrics').set('Authorization', 'Bearer scrape-token-0123456780')).status).toBe(401);
    expect((await request(guarded).get('/metrics').set('Authorization', 'scrape-token-0123456789')).status).toBe(401);
    expect((await request(guarded).get('/metrics').set('Authorization', 'Bearer scrape-token-0123456789')).status).toBe(200);
  });

  test('port 0 turns the metrics server off', () => {
    expect(startMetricsServer(metricsRegistry, { port: 0, host: '127.0.0.1', token: null })).toBeNull();
  });
});

describe('HTTP latency per route', () => {
  test('is a histogram by method, route template and status class: p95 per route can be computed', async () => {
    for (let i = 0; i < 3; i++) await request(app).get(`/api/v1/vehicles/${UUID}/tracking`);
    const text = await scrape();
    const labels = { method: 'GET', route: '/api/v1/vehicles/:vehicleId/tracking', status_class: '4xx' };
    expect(series(text, 'http_request_duration_seconds_count', labels)).toBeGreaterThanOrEqual(3);
    expect(series(text, 'http_request_duration_seconds_sum', labels)).toBeGreaterThan(0);
    // The buckets a quantile is computed from: cumulative, ending in +Inf with the count.
    const buckets = text.split('\n').filter((l) => l.startsWith('http_request_duration_seconds_bucket{') && l.includes('route="/api/v1/vehicles/:vehicleId/tracking"'));
    expect(buckets.length).toBeGreaterThan(10);
    expect(buckets.some((l) => l.includes('le="0.3"'))).toBe(true);
    const counts = buckets.map((l) => Number(l.slice(l.lastIndexOf(' ') + 1)));
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    expect(buckets.at(-1)).toContain('le="+Inf"');
  });

  test('never holds an id, a URL, a query string or a user: routes are templates, strangers are one series', async () => {
    await request(app).get(`/api/v1/vehicles/${UUID}/tracking?from=2026-01-01`);
    await request(app).get('/api/v1/definitely-not-a-route/12345');
    await request(app).get('/wp-admin/setup.php');
    const text = await scrape();
    expect(text).not.toContain(UUID);
    expect(text).not.toContain('definitely-not-a-route');
    expect(text).not.toContain('wp-admin');
    expect(text).not.toContain('2026-01-01');
    expect(series(text, 'http_request_duration_seconds_count', { route: 'unmatched', status_class: '4xx' })).toBeGreaterThanOrEqual(2);
  });

  test('keeps the prefix when the answer was an error passed on to the error handler', async () => {
    // A body the route's schema refuses is a thrown validation error: next(err) leaves the router before the response is sent.
    await request(app).post('/api/v1/auth/login').send({});
    const text = await scrape();
    expect(series(text, 'http_request_duration_seconds_count', { method: 'POST', route: '/api/v1/auth/login' })).toBeGreaterThanOrEqual(1);
    expect(text).not.toMatch(/route="\/auth\/login"/);
  });

  test('leaves the health probes out', async () => {
    await request(app).get('/health/live');
    await request(app).get('/health/ready');
    expect(await scrape()).not.toContain('/health/');
  });
});

describe('domain metrics', () => {
  test('the event outbox’s lag and dead letters, and the replica, are exported', async () => {
    const text = await scrape();
    expect(series(text, 'outbox_oldest_pending_seconds')).toBe(0);
    expect(series(text, 'outbox_dead_lettered_events')).toBe(0);
    expect(series(text, 'outbox_undispatched_events')).not.toBeNull();
    expect(series(text, 'outbox_unpublished_events')).not.toBeNull();
    // The test database has no read replica: reads use the primary, and there is no lag to show.
    expect(series(text, 'replica_in_use')).toBe(0);
    expect(series(text, 'replica_lag_seconds')).toBe(-1);
  });

  test('a stuck event shows as outbox lag', async () => {
    setMetricReaders({ outbox: async () => ({ undispatched: 4, unpublished: 1, oldest_pending_seconds: 95, dead_lettered: 2 }) });
    try {
      await new Promise((r) => setTimeout(r, 1100)); // the readers are read once a second at most
      const text = await scrape();
      expect(series(text, 'outbox_oldest_pending_seconds')).toBe(95);
      expect(series(text, 'outbox_dead_lettered_events')).toBe(2);
      expect(series(text, 'outbox_undispatched_events')).toBe(4);
    } finally {
      createApp(); // gives the gauges their real readers back
    }
  });

  test('a replica’s lag, a provider’s circuit and the sockets are exported when there are some', async () => {
    setMetricReaders({
      replica: async () => ({ lag_seconds: 7, in_use: 1, max_lag_seconds: 30, fallbacks: 3 }),
      circuits: async () => [
        { code: 'osrm', state: 'closed' },
        { code: 'sms-gateway', state: 'open' },
        { code: 'push', state: 'half_open' },
      ],
      sockets: () => 12,
    });
    try {
      await new Promise((r) => setTimeout(r, 1100));
      const text = await scrape();
      expect(series(text, 'replica_lag_seconds')).toBe(7);
      expect(series(text, 'replica_in_use')).toBe(1);
      expect(series(text, 'replica_fallbacks')).toBe(3);
      expect(series(text, 'circuit_breaker_state', { provider: 'osrm' })).toBe(0);
      expect(series(text, 'circuit_breaker_state', { provider: 'push' })).toBe(1);
      expect(series(text, 'circuit_breaker_state', { provider: 'sms-gateway' })).toBe(2);
      expect(series(text, 'socket_connections')).toBe(12);
    } finally {
      setMetricReaders({ sockets: () => 0 });
      createApp();
    }
  });

  test('a scheduled job’s duration is observed, by job and by how it ended', async () => {
    const deps = { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test' };
    await runJob({ name: 'metrics-ok-job', at: '00:00', run: async () => ({ done: 1 }) }, deps);
    await runJob(
      {
        name: 'metrics-failing-job',
        at: '00:00',
        run: async () => {
          throw new Error('boom');
        },
      },
      deps,
    );
    const text = await scrape();
    expect(series(text, 'job_duration_seconds_count', { job: 'metrics-ok-job', status: 'succeeded' })).toBe(1);
    expect(series(text, 'job_duration_seconds_count', { job: 'metrics-failing-job', status: 'failed' })).toBe(1);
  });
});

describe('/health/ready and the AI service', () => {
  const ready = (ml?: { url: string | null; critical: boolean }) => request(createApp({ ml })).get('/health/ready');
  let stub: Awaited<ReturnType<typeof startMockProvider>> | null = null;
  afterAll(async () => stub?.close());

  test('not configured, it is disabled and readiness is unchanged', async () => {
    for (const critical of [false, true]) {
      const res = await ready({ url: null, critical });
      expect(res.status).toBe(200);
      expect(res.body.checks.ml).toBe('disabled');
    }
  });

  test('answering, it is ok; down, it is degraded (200) unless it is critical, then 503 and failed', async () => {
    stub = await startMockProvider();
    stub.answer('/health', { status: 200, body: { status: 'ok' } });
    const ok = await ready({ url: stub.url, critical: false });
    expect(ok.status).toBe(200);
    expect(ok.body.checks.ml).toBe('ok');
    expect((await ready({ url: stub.url, critical: true })).body.checks.ml).toBe('ok');

    stub.answer('/health', { status: 503 });
    const soft = await ready({ url: stub.url, critical: false });
    expect(soft.status).toBe(200);
    expect(soft.body.status).toBe('degraded');
    expect(soft.body.checks.ml).toBe('degraded');

    const hard = await ready({ url: stub.url, critical: true });
    expect(hard.status).toBe(503);
    expect(hard.body.status).toBe('unavailable');
    expect(hard.body.checks).toMatchObject({ database: 'ok', ml: 'failed' });
  });

  test('an AI service that cannot be reached is down the same way', async () => {
    const soft = await ready({ url: 'http://127.0.0.1:1', critical: false });
    expect(soft.status).toBe(200);
    expect(soft.body.checks.ml).toBe('degraded');
    expect((await ready({ url: 'http://127.0.0.1:1', critical: true })).status).toBe(503);
  });

  test('its answer stands for a few seconds: polling readiness does not poll the AI service', async () => {
    const counted = await startMockProvider();
    try {
      counted.answer('/health', { status: 200 });
      const one = createApp({ ml: { url: counted.url, critical: false } });
      for (let i = 0; i < 5; i++) await request(one).get('/health/ready');
      expect(counted.requests.filter((r) => r.path === '/health')).toHaveLength(1);
    } finally {
      await counted.close();
    }
  });
});
