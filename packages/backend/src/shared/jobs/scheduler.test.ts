import { describe, expect, test } from 'vitest';
import type { Queryable } from '../infrastructure/queryable';
import { parseAt, type ScheduledJob } from './job';
import type { JobClaim, JobLock } from './job-lock';
import { isDue, localDateAndTime, runJob } from './scheduler';

const TZ = 'Africa/Addis_Ababa'; // UTC+3, no daylight saving

/** A lock that hands out one claim per (job, key), like jobs.job_runs, and records outcomes. */
function memoryLock() {
  const runs = new Map<string, { status: string; attempts: number }>();
  const lock: JobLock & { runs: typeof runs } = {
    runs,
    async claim({ jobName, runKey, correlationId, maxAttempts }) {
      const key = `${jobName}:${runKey}`;
      const run = runs.get(key);
      if (run && (run.status !== 'failed' || run.attempts >= maxAttempts)) return null;
      const attempts = (run?.attempts ?? 0) + 1;
      runs.set(key, { status: 'running', attempts });
      return { id: key, jobName, runKey, correlationId, attempts } satisfies JobClaim;
    },
    async succeed(claim) {
      runs.get(claim.id)!.status = 'succeeded';
    },
    async fail(claim) {
      runs.get(claim.id)!.status = 'failed';
    },
  };
  return lock;
}

function auditSink() {
  const entries: unknown[][] = [];
  const db = { query: async (_sql: string, params: unknown[]) => void entries.push(params) } as unknown as Queryable;
  return { db, entries };
}

const job = (run: ScheduledJob['run']): ScheduledJob => ({ name: 'test-job', at: '07:00', run });
const at0730 = new Date('2026-10-10T04:30:00Z'); // 07:30 in Addis Ababa

describe('parseAt and isDue', () => {
  test('HH:MM only', () => {
    expect(parseAt('07:00')).toEqual({ hour: 7, minute: 0 });
    for (const bad of ['7:00', '24:00', '07:60', '0700', '']) expect(() => parseAt(bad)).toThrow(/HH:MM/);
  });

  test('due from the job time on the local day', () => {
    expect(localDateAndTime(new Date('2026-10-09T21:30:00Z'), TZ)).toEqual({ date: '2026-10-10', time: '00:30' });
    expect(isDue(job(async () => {}), new Date('2026-10-10T03:59:00Z'), TZ)).toBe(false); // 06:59
    expect(isDue(job(async () => {}), new Date('2026-10-10T04:00:00Z'), TZ)).toBe(true); // 07:00
  });
});

describe('runJob', () => {
  test('runs once per local day; the second trigger is skipped', async () => {
    const lock = memoryLock();
    const { db, entries } = auditSink();
    let runs = 0;
    const deps = { lock, audit: db, timeZone: TZ, instanceId: 'a', now: () => at0730 };
    const first = await runJob(job(async () => ({ n: ++runs })), deps);
    expect(first).toMatchObject({ status: 'succeeded', result: { n: 1 } });
    expect(await runJob(job(async () => ({ n: ++runs })), { ...deps, instanceId: 'b' })).toEqual({ status: 'skipped' });
    expect(runs).toBe(1);
    expect([...lock.runs.keys()]).toEqual(['test-job:2026-10-10']);
    // Audited as the system: user null, one UUID correlation id for both entries.
    expect(entries.map((p) => [p[0], p[1]])).toEqual([
      [null, 'job.started'],
      [null, 'job.succeeded'],
    ]);
    expect(entries[0][4]).toBe(entries[1][4]);
    expect(String(entries[0][4])).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a failure is recorded and audited, and the next trigger retries until it succeeds', async () => {
    const lock = memoryLock();
    const { db, entries } = auditSink();
    let calls = 0;
    const flaky = job(async () => {
      calls += 1;
      if (calls === 1) throw new Error('database unavailable');
      return { ok: true };
    });
    const deps = { lock, audit: db, timeZone: TZ, instanceId: 'a', now: () => at0730 };
    expect(await runJob(flaky, deps)).toMatchObject({ status: 'failed', error: 'database unavailable' });
    expect(await runJob(flaky, deps)).toMatchObject({ status: 'succeeded' });
    expect(await runJob(flaky, deps)).toEqual({ status: 'skipped' });
    expect(entries.map((p) => p[1])).toEqual(['job.started', 'job.failed', 'job.started', 'job.succeeded']);
  });

  test('gives up for the day after maxAttempts failures', async () => {
    const lock = memoryLock();
    const deps = { lock, audit: auditSink().db, timeZone: TZ, instanceId: 'a', now: () => at0730, maxAttempts: 2 };
    const broken = job(async () => {
      throw new Error('boom');
    });
    expect((await runJob(broken, deps)).status).toBe('failed');
    expect((await runJob(broken, deps)).status).toBe('failed');
    expect((await runJob(broken, deps)).status).toBe('skipped');
  });
});
