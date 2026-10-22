import type { Queryable } from '../infrastructure/queryable';
import type { ScheduledJob } from './job';

/** How long the runs of interval jobs are kept in jobs.job_runs. Daily runs are kept: one row a day. */
export const INTERVAL_RUN_RETENTION_DAYS = 7;

/**
 * Daily: deletes interval jobs' runs (run key `YYYY-MM-DDTHH:MM`, FMS-92) finished more than a week
 * ago; a job every minute writes 1,440 a day. Platform job, run by src/server.ts.
 */
export function jobRunsCleanupJob(db: Queryable): ScheduledJob {
  return {
    name: 'job-runs-cleanup',
    at: '03:40',
    async run({ now }) {
      const res = await db.query(
        `DELETE FROM jobs.job_runs WHERE run_key LIKE '%T%' AND status <> 'running' AND COALESCE(finished_at, started_at) < $1`,
        [new Date(now.getTime() - INTERVAL_RUN_RETENTION_DAYS * 86_400_000)],
      );
      return { runs_deleted: res.rowCount ?? 0 };
    },
  };
}
