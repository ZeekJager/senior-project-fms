import { describe, expect, test } from 'vitest';
import { startDailyJobs, type DailyJob } from './daily-job';

const TZ = 'Africa/Addis_Ababa'; // UTC+3, no daylight saving

function job(hour: number, runs: Date[], fail = false): DailyJob {
  return {
    name: `job-${hour}`,
    hour,
    run: async (now) => {
      runs.push(now);
      if (fail) throw new Error('boom');
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startDailyJobs', () => {
  test('runs once per local day, from the job’s hour, catching up at start', async () => {
    const runs: Date[] = [];
    let now = new Date('2026-10-09T02:00:00Z'); // 05:00 in Addis Ababa
    const stop = startDailyJobs([job(6, runs)], { timeZone: TZ, now: () => now, checkEveryMs: 1 });

    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(0); // before 06:00 local

    now = new Date('2026-10-09T03:30:00Z'); // 06:30 local
    await new Promise((r) => setTimeout(r, 5));
    now = new Date('2026-10-09T20:00:00Z'); // 23:00 local, same day
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(1);

    now = new Date('2026-10-09T21:30:00Z'); // 00:30 on 10 Oct local, before 06:00
    await new Promise((r) => setTimeout(r, 5));
    now = new Date('2026-10-10T04:00:00Z'); // 07:00 on 10 Oct
    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(runs).toHaveLength(2);
  });

  test('a failed run is retried on the next check, and reported', async () => {
    const runs: Date[] = [];
    const errors: string[] = [];
    const stop = startDailyJobs([job(0, runs, true)], {
      timeZone: TZ,
      now: () => new Date('2026-10-09T09:00:00Z'),
      checkEveryMs: 1,
      onError: (j) => errors.push(j.name),
    });
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    stop();
    expect(runs.length).toBeGreaterThan(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
