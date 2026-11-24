import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { INTERVAL_RUN_RETENTION_DAYS, jobRunsCleanupJob } from '../../src/shared/jobs/job-runs-cleanup';

const DAY = 86_400_000;

/** One finished (or running) run of a test-only job, `ageDays` ago. */
async function run(job: string, runKey: string, ageDays: number, status: 'succeeded' | 'failed' | 'running' = 'succeeded') {
  const at = new Date(Date.now() - ageDays * DAY);
  await pool.query(
    `INSERT INTO jobs.job_runs (job_name, run_key, status, instance_id, correlation_id, started_at, lease_until, finished_at)
     VALUES ($1, $2, $3, 'test-instance', $4, $5, $5, $6)`,
    [job, runKey, status, randomUUID(), at, status === 'running' ? null : at],
  );
}

describe('job-runs-cleanup (SE-207)', () => {
  test('runs as the app role and removes interval runs past retention, keeping recent, daily and running ones', async () => {
    const who = await pool.query<{ who: string }>('SELECT current_user AS who');
    expect(who.rows[0].who).toBe(config.db.user);

    const job = `test-cleanup-${randomUUID()}`;
    const old = INTERVAL_RUN_RETENTION_DAYS + 2;
    await run(job, '2026-01-01T10:00', old);
    await run(job, '2026-01-01T10:01', old, 'failed');
    await run(job, '2026-01-01T10:02', old, 'running');
    await run(job, '2026-01-02T10:00', 1);
    await run(job, '2026-01-01', old);

    const result = await jobRunsCleanupJob(pool).run({ now: new Date(), correlationId: randomUUID(), runKey: '2026-01-09' });

    expect(result).toEqual({ runs_deleted: expect.any(Number) });
    expect((result as { runs_deleted: number }).runs_deleted).toBeGreaterThanOrEqual(2);
    const left = await pool.query<{ run_key: string }>('SELECT run_key FROM jobs.job_runs WHERE job_name = $1 ORDER BY run_key', [job]);
    expect(left.rows.map((r) => r.run_key)).toEqual(['2026-01-01', '2026-01-01T10:02', '2026-01-02T10:00']);
  });
});
