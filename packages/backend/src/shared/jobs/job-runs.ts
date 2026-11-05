import type { Queryable } from '../infrastructure/queryable';

/** A scheduled job's run that failed, as the system health screen lists it (FMS-143). */
export interface FailedJobRun {
  job: string;
  /** The local day of a daily job, the slot of an interval job. */
  run_key: string;
  attempts: number;
  started_at: Date;
  failed_at: Date;
  error: string | null;
}

/**
 * The runs in jobs.job_runs that failed since `since`, newest first, and how many there were. A daily run that
 * failed is retried by the sweep (and listed until a retry succeeds); interval runs are kept a week
 * (job-runs-cleanup). For other modules: jobs.job_runs is platform-owned and never queried by a module.
 */
export async function failedJobRuns(db: Queryable, since: Date, limit: number): Promise<{ runs: FailedJobRun[]; total: number }> {
  const res = await db.query<FailedJobRun>(
    `SELECT job_name AS job, run_key, attempts, started_at, COALESCE(finished_at, started_at) AS failed_at, error
       FROM jobs.job_runs
      WHERE status = 'failed' AND COALESCE(finished_at, started_at) >= $1
      ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
      LIMIT $2`,
    [since, limit],
  );
  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs.job_runs WHERE status = 'failed' AND COALESCE(finished_at, started_at) >= $1`,
    [since],
  );
  return { runs: res.rows, total: total.rows[0].n };
}
