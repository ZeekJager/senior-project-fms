import { createApp } from './app';
import { config } from './config';
import { modules } from './modules';
import { startDailyJobs } from './shared/jobs/daily-job';
import { logger } from './shared/logging/logger';

/** The operating time zone: daily jobs run on Addis Ababa days. */
const JOBS_TIME_ZONE = 'Africa/Addis_Ababa';

createApp().listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'fms-backend listening');
});

startDailyJobs(
  modules.flatMap((m) => m.jobs ?? []),
  {
    timeZone: JOBS_TIME_ZONE,
    onRun: (job) => logger.info({ job: job.name }, 'daily job started'),
    onError: (job, err) => logger.error({ err, job: job.name }, 'daily job failed'),
  },
);
