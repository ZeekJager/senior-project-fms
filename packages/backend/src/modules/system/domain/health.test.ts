import { describe, expect, test } from 'vitest';
import {
  API_GAP_ERROR,
  addHistograms,
  currentStatus,
  errorRatePct,
  errorText,
  latencyBucket,
  LATENCY_BUCKET_COUNT,
  outagesOf,
  p95Of,
  timelineOf,
  uptimeOf,
  withApiGaps,
  type Run,
  type SampleStatus,
} from './health';

const T0 = Date.parse('2026-11-04T08:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000);
const run = (
  component: string,
  status: SampleStatus,
  from: number,
  to: number,
  error: string | null = status === 'down' ? 'connection refused' : null,
): Run => ({
  component,
  label: component,
  status,
  start: at(from),
  end: at(to),
  error,
});

describe('uptimeOf', () => {
  test('counts ok and down minutes; minutes with no sample are no data, left out of the uptime', () => {
    // Redis: ok for 50 minutes, down 3, ok again 40; 7 minutes not sampled in between.
    const runs = [run('redis', 'ok', 0, 50), run('redis', 'down', 50, 53), run('redis', 'ok', 60, 100)];
    expect(uptimeOf(runs, at(0), at(100), at(0))).toEqual({
      uptime_pct: 96.77,
      ok_minutes: 90,
      down_minutes: 3,
      disabled_minutes: 0,
      no_data_minutes: 7,
    });
  });

  test('the window starts when sampling began, and clips the runs at both ends', () => {
    const runs = [run('database', 'ok', 0, 30), run('database', 'down', 30, 40), run('database', 'ok', 40, 60)];
    // A 24-hour window over an hour of samples: only that hour counts, none of it as no data.
    expect(uptimeOf(runs, at(-24 * 60 + 60), at(60), at(0))).toMatchObject({
      ok_minutes: 50,
      down_minutes: 10,
      no_data_minutes: 0,
      uptime_pct: 83.33,
    });
    // [35, 45): half of the outage and five ok minutes.
    expect(uptimeOf(runs, at(35), at(45), at(0))).toMatchObject({
      ok_minutes: 5,
      down_minutes: 5,
      uptime_pct: 50,
    });
  });

  test('a short outage never reads 100%, a disabled component has no uptime, nothing sampled is all null', () => {
    const month = 30 * 24 * 60;
    expect(uptimeOf([run('api', 'ok', 0, month - 1), run('api', 'down', month - 1, month)], at(0), at(month), at(0)).uptime_pct).toBe(99.99);
    expect(uptimeOf([run('replica', 'disabled', 0, 60)], at(0), at(60), at(0))).toEqual({
      uptime_pct: null,
      ok_minutes: 0,
      down_minutes: 0,
      disabled_minutes: 60,
      no_data_minutes: 0,
    });
    expect(uptimeOf([], at(0), at(60), null)).toEqual({
      uptime_pct: null,
      ok_minutes: 0,
      down_minutes: 0,
      disabled_minutes: 0,
      no_data_minutes: 0,
    });
  });
});

describe('withApiGaps', () => {
  test('a gap between two samples of the API is the API down; a gap after the last is not', () => {
    const runs = withApiGaps([run('api', 'ok', 20, 30), run('api', 'ok', 0, 12)]);
    expect(runs).toEqual([run('api', 'ok', 0, 12), run('api', 'down', 12, 20, API_GAP_ERROR), run('api', 'ok', 20, 30)]);
    expect(uptimeOf(runs, at(0), at(40), at(0))).toMatchObject({
      ok_minutes: 22,
      down_minutes: 8,
      no_data_minutes: 10,
      uptime_pct: 73.33,
    });
  });
});

describe('outagesOf', () => {
  test('each down run is an outage with its length and first error, newest first; one reaching the end goes on', () => {
    const runs = [
      run('redis', 'ok', 0, 10),
      run('redis', 'down', 10, 13, 'connect ECONNREFUSED'),
      run('redis', 'ok', 13, 50),
      run('database', 'down', 48, 50, 'timed out after 3000 ms'),
    ];
    expect(outagesOf(runs, at(0), at(50))).toEqual([
      {
        component: 'database',
        label: 'database',
        started_at: at(48),
        ended_at: null,
        duration_minutes: 2,
        error: 'timed out after 3000 ms',
      },
      {
        component: 'redis',
        label: 'redis',
        started_at: at(10),
        ended_at: at(13),
        duration_minutes: 3,
        error: 'connect ECONNREFUSED',
      },
    ]);
    // Outside the window: not listed. Reaching into it: listed whole.
    expect(outagesOf(runs, at(20), at(50)).map((o) => o.component)).toEqual(['database']);
    expect(outagesOf(runs, at(12), at(50))[1]).toMatchObject({
      started_at: at(10),
      duration_minutes: 3,
    });
  });
});

describe('currentStatus', () => {
  test('the last sample if it is of the last minute or the one before; otherwise no data', () => {
    const runs = [run('redis', 'ok', 0, 10), run('redis', 'down', 10, 20)];
    expect(currentStatus(runs, at(20))).toBe('down');
    expect(currentStatus(runs, at(21))).toBe('down');
    expect(currentStatus(runs, at(22))).toBe('no_data');
    expect(currentStatus([], at(22))).toBe('no_data');
  });
});

describe('timelineOf', () => {
  test('minutes per cell, with cells before sampling began as no data', () => {
    const runs = [run('redis', 'ok', 10, 20), run('redis', 'down', 20, 25), run('redis', 'ok', 25, 30)];
    const cells = timelineOf(runs, at(0), at(30), 15, at(10));
    expect(cells).toEqual([
      {
        start: at(0),
        ok_minutes: 5,
        down_minutes: 0,
        disabled_minutes: 0,
        no_data_minutes: 10,
      },
      {
        start: at(15),
        ok_minutes: 10,
        down_minutes: 5,
        disabled_minutes: 0,
        no_data_minutes: 0,
      },
    ]);
  });
});

describe('request latency', () => {
  test('a request falls in the first bucket at or above its time, the slowest in the open one', () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(5)).toBe(0);
    expect(latencyBucket(5.1)).toBe(1);
    expect(latencyBucket(120)).toBe(6);
    expect(latencyBucket(60_000)).toBe(LATENCY_BUCKET_COUNT - 1);
  });

  test('p95 interpolates within its bucket; none without requests; at least 10 s in the open bucket', () => {
    const h = new Array(LATENCY_BUCKET_COUNT).fill(0);
    h[3] = 90; // (25, 50]
    h[6] = 10; // (100, 150]
    // Rank 95 is the 5th of the 10 in (100, 150]: 100 + 50 * 5/10.
    expect(p95Of(h)).toBe(125);
    expect(p95Of(new Array(LATENCY_BUCKET_COUNT).fill(0))).toBeNull();
    const slow = new Array(LATENCY_BUCKET_COUNT).fill(0);
    slow[LATENCY_BUCKET_COUNT - 1] = 3;
    expect(p95Of(slow)).toBe(10_000);
    expect(addHistograms([1, 2], [3, 4, 5])).toEqual([4, 6, 5]);
    expect(errorRatePct(400, 3)).toBe(0.75);
    expect(errorRatePct(0, 0)).toBeNull();
  });
});

test('errorText keeps one short line', () => {
  expect(errorText(new Error('connect\n  ECONNREFUSED 127.0.0.1:6379'))).toBe('connect ECONNREFUSED 127.0.0.1:6379');
  expect(errorText('x'.repeat(400))).toHaveLength(300);
  expect(errorText(new Error(''))).toBe('The check failed');
});
