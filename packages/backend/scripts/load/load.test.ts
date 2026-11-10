import { describe, expect, test } from 'vitest';
import { assertLoadTarget } from './guard';
import { cpuPercent, sampleValue } from './metrics';
import { BUDGETS } from './profiles';
import { checksFor, formatChecks, type Results } from './report';
import { pageRequests } from './scenarios/dashboard';
import { serverEnv } from './server';
import { setCookies } from './session';
import { check, percentile, Recorder, summarize } from './stats';

describe('statistics', () => {
  test('nearest-rank percentiles', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([], 95)).toBe(0);
  });

  test('a summary of unsorted samples', () => {
    expect(summarize([30, 10, 20])).toEqual({ count: 3, min: 10, mean: 20, p50: 20, p95: 30, p99: 30, max: 30 });
    expect(summarize([])).toMatchObject({ count: 0, p95: 0 });
  });

  test('budget checks: under, at, over', () => {
    expect(check('x', 199.9, '<', 200, 'ms').passed).toBe(true);
    expect(check('x', 200, '<', 200, 'ms').passed).toBe(false);
    expect(check('x', 0, '<=', 0, 'events').passed).toBe(true);
    expect(check('x', 1, '<=', 0, 'events').passed).toBe(false);
  });

  test('the recorder groups requests by label and counts failures by outcome', () => {
    const r = new Recorder();
    r.record('GET /trips', 10, true, '200');
    r.record('GET /trips', 30, false, '503');
    r.record('GET /trips', 20, false, '503');
    r.record('POST /fuel-logs', 50, false, 'network');
    expect(r.labels()).toEqual(['GET /trips', 'POST /fuel-logs']);
    expect(r.errors()).toEqual({ 'GET /trips': { '503': 2 }, 'POST /fuel-logs': { network: 1 } });
    expect(r.errorCount()).toBe(3);
    expect(r.table(2)['GET /trips']).toMatchObject({ count: 3, p50: 20, perSecond: 1.5 });
  });
});

describe('server metrics', () => {
  const text = [
    '# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.',
    '# TYPE process_cpu_seconds_total counter',
    'process_cpu_seconds_total{service="fms-backend"} 12.5',
    'process_cpu_seconds_total_extra 99',
    'nodejs_eventloop_lag_p99_seconds 0.021',
  ].join('\n');

  test('reads a sample with or without labels, never a metric whose name merely starts the same', () => {
    expect(sampleValue(text, 'process_cpu_seconds_total')).toBe(12.5);
    expect(sampleValue(text, 'nodejs_eventloop_lag_p99_seconds')).toBe(0.021);
    expect(sampleValue(text, 'process_resident_memory_bytes')).toBeUndefined();
    expect(sampleValue('process_cpu_seconds_total_extra 99', 'process_cpu_seconds_total')).toBeUndefined();
  });

  test('CPU as a share of one core', () => {
    expect(cpuPercent(10, 10.5, 1000)).toBe(50);
    expect(cpuPercent(10, 12, 1000)).toBe(200); // two cores' worth: reported as it is
    expect(cpuPercent(10, 10, 0)).toBe(0);
  });
});

describe('the session', () => {
  test('keeps each cookie a response sets, by name, without its attributes', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'fms_access=abc.def; Path=/; HttpOnly; Secure; SameSite=Strict');
    headers.append('set-cookie', 'fms_csrf=tok%3D1; Path=/; Secure; SameSite=Strict');
    expect(Object.fromEntries(setCookies(headers))).toEqual({ fms_access: 'abc.def', fms_csrf: 'tok%3D1' });
  });
});

describe('guard', () => {
  test('refuses production and a database not named *_test', () => {
    expect(() => assertLoadTarget({ NODE_ENV: 'production' }, 'fms_load_test')).toThrow(/production/);
    expect(() => assertLoadTarget({ NODE_ENV: 'development' }, 'fms')).toThrow(/_test/);
    expect(() => assertLoadTarget({}, 'fms_load_test')).not.toThrow();
  });
});

describe('the API under load', () => {
  test('gets neither the schema owner nor the backup role, so no scheduled backup runs mid-scenario', () => {
    const env = serverEnv({ DB_USER: 'fms_app', DB_ADMIN_USER: 'fms_admin', DB_ADMIN_PASSWORD: 'admin-pw', BACKUP_DB_USER: 'b', BACKUP_DB_PASSWORD: 'p' });
    expect(env).toEqual({ DB_USER: 'fms_app' });
  });
});

describe('the dashboards', () => {
  test('open with the requests their screens make, over the default 30 days', () => {
    const plan = pageRequests();
    expect(Object.keys(plan['Fleet Command Center'])).toEqual(['GET /command-center/overview', 'GET /tracking/vehicles/current']);
    const summary = plan['Analytics dashboard']['GET /analytics/fleet-summary'];
    const [, from, to] = /from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(summary)!;
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(29);
  });
});

describe('the verdict', () => {
  const load = { missed: 0, lastError: null, cpuPct: summarize([20, 30]), eventLoopLagP99Ms: summarize([5]), samples: 2 };
  const table = (p95: number) => ({ count: 100, min: 1, mean: p95 / 2, p50: p95 / 2, p95, p99: p95, max: p95, perSecond: 1 });

  const passing: Results = {
    gps: {
      workload: { vehicles: 200, intervalS: 10, durationS: 300, observers: 25 },
      seconds: 300,
      requests: {},
      errors: {},
      errorCount: 0,
      events: { announced: 6000, expected: 150_000, received: 150_000, dropped: 0, observerDisconnects: 0, unmatched: 0, sample: null },
      deliveryMs: summarize([100, 200, 300]),
      server: load,
    },
    api: {
      workload: { users: 50, durationS: 120, thinkMs: [500, 1500] },
      seconds: 120,
      requests: { 'GET /trips': table(150), 'GET /vehicles': table(150), 'POST /fuel-logs': table(300) },
      warmup: {},
      errors: {},
      warmupErrors: {},
      errorCount: 0,
      server: load,
    },
    dashboard: {
      workload: { users: 20, durationS: 60, thinkMs: [1000, 3000] },
      seconds: 60,
      pages: { 'Fleet Command Center': table(400), 'Analytics dashboard': table(300) },
      requests: { 'GET /analytics/fleet-summary': table(150), 'GET /command-center/overview': table(900) },
      warmup: { pages: {}, requests: {} },
      errors: {},
      warmupErrors: {},
      errorCount: 0,
      server: load,
    },
  };

  test('every budget met passes, and only analytics requests are held to the analytics budget', () => {
    const checks = checksFor(passing);
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checks.map((c) => c.name)).not.toContain('Dashboard: GET /command-center/overview, p95');
    expect(checks.filter((c) => c.name.startsWith('API:') && c.unit === 'ms')).toHaveLength(Object.keys(BUDGETS.api.p95Ms).length);
  });

  test('one dropped event, a slow endpoint or one failed request fails the run', () => {
    const failing: Results = {
      ...passing,
      gps: { ...passing.gps!, events: { ...passing.gps!.events, dropped: 1 } },
      api: { ...passing.api!, requests: { ...passing.api!.requests, 'GET /trips': table(201) }, errorCount: 1 },
    };
    const failed = checksFor(failing).filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(['GPS: socket events dropped', 'API: GET /trips, p95', 'API: failed requests']);
  });

  test('a budget nothing was measured against fails, rather than passing by default', () => {
    const empty: Results = { api: { ...passing.api!, requests: {} } };
    const checks = checksFor(empty);
    expect(checks.filter((c) => c.unit === 'ms').every((c) => !c.passed)).toBe(true);
    expect(formatChecks(checks)).toContain('not measured');
  });
});
