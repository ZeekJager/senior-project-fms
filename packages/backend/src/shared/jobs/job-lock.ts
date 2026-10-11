import type { Pool } from 'pg';

/** A run this instance holds the lock for. */
export interface JobClaim {
  id: string;
  jobName: string;
  runKey: string;
  correlationId: string;
  attempts: number;
}

/**
 * The single-run guarantee across app instances (§28.1): one claim per
 * (job, run key) at a time. PostgreSQL today; FMS-72 can move the lock to
 * Redis behind this interface, keeping the run history in jobs.job_runs.
 */
export interface JobLock {
  /**
   * Takes the run, or returns null when another instance holds it, it has
   * already succeeded, or it has failed `maxAttempts` times. A failed run, or
   * one whose lease ran out (its instance died), is taken again.
   */
  claim(input: { jobName: string; runKey: string; instanceId: string; correlationId: string; leaseMs: number; maxAttempts: number }): Promise<JobClaim | null>;
  succeed(claim: JobClaim, result: Record<string, unknown>): Promise<void>;
  fail(claim: JobClaim, error: string): Promise<void>;
}

/**
 * jobs.job_runs as the lock and the run history in one row. The claim is
 * one statement: the INSERT wins a new (job, run key); otherwise the ON
 * CONFLICT branch takes the row over only if it failed or its lease ran out.
 * Two instances claiming at once serialise on the unique key and exactly one
 * gets a row back. clock_timestamp(), not now(): the lease is wall-clock
 * time, whatever transaction the caller is in.
 */
export class PostgresJobLock implements JobLock {
  constructor(private readonly db: Pick<Pool, 'query'>) {}

  async claim(input: Parameters<JobLock['claim']>[0]): Promise<JobClaim | null> {
    const res = await this.db.query<{ id: string; attempts: number }>(
      `INSERT INTO jobs.job_runs (job_name, run_key, status, instance_id, correlation_id, started_at, lease_until)
       VALUES ($1, $2, 'running', $3, $4, clock_timestamp(), clock_timestamp() + $5 * interval '1 millisecond')
       ON CONFLICT (job_name, run_key) DO UPDATE
          SET status = 'running', instance_id = EXCLUDED.instance_id, correlation_id = EXCLUDED.correlation_id,
              attempts = jobs.job_runs.attempts + 1, started_at = EXCLUDED.started_at, lease_until = EXCLUDED.lease_until,
              finished_at = NULL, result = NULL, error = NULL
        WHERE jobs.job_runs.attempts < $6
          AND (jobs.job_runs.status = 'failed' OR (jobs.job_runs.status = 'running' AND jobs.job_runs.lease_until < clock_timestamp()))
       RETURNING id, attempts`,
      [input.jobName, input.runKey, input.instanceId, input.correlationId, input.leaseMs, input.maxAttempts],
    );
    const row = res.rows[0];
    return row ? { id: row.id, jobName: input.jobName, runKey: input.runKey, correlationId: input.correlationId, attempts: row.attempts } : null;
  }

  async succeed(claim: JobClaim, result: Record<string, unknown>): Promise<void> {
    await this.finish(claim, 'succeeded', result, null);
  }

  async fail(claim: JobClaim, error: string): Promise<void> {
    await this.finish(claim, 'failed', null, error.slice(0, 2000));
  }

  /** Only while this claim still holds the row: a run that outlived its lease cannot overwrite its successor. */
  private async finish(claim: JobClaim, status: 'succeeded' | 'failed', result: Record<string, unknown> | null, error: string | null): Promise<void> {
    await this.db.query(
      `UPDATE jobs.job_runs SET status = $3, result = $4, error = $5, finished_at = clock_timestamp()
        WHERE id = $1 AND correlation_id = $2`,
      [claim.id, claim.correlationId, status, result, error],
    );
  }
}
