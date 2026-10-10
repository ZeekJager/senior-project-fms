import { hostname } from 'node:os';
import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { modules } from './modules';
import { PostgresJobLock } from './shared/jobs/job-lock';
import { startScheduler } from './shared/jobs/scheduler';
import { logger } from './shared/logging/logger';

/** The operating time zone: daily jobs run on Addis Ababa days. */
const JOBS_TIME_ZONE = 'Africa/Addis_Ababa';

createApp().listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'fms-backend listening');
});

// Every instance schedules every job; the lock in jobs.job_runs lets one run
// each per day (FMS-26).
startScheduler(
  modules.flatMap((m) => m.jobs ?? []),
  {
    lock: new PostgresJobLock(pool),
    audit: pool,
    timeZone: JOBS_TIME_ZONE,
    instanceId: `${hostname()}:${process.pid}`,
    log: (level, message, fields) => logger[level](fields, message),
  },
);
