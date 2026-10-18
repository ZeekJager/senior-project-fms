import { hostname } from 'node:os';
import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { modules } from './modules';
import { redis, redisKey } from './shared/cache';
import { createOutboxRelay } from './shared/events/event-bus';
import { outboxCleanupJob } from './shared/events/outbox-cleanup';
import { idempotencyPurgeJob } from './shared/http/idempotency-purge';
import { PostgresJobLock } from './shared/jobs/job-lock';
import { RedisJobLock } from './shared/jobs/redis-job-lock';
import { startScheduler } from './shared/jobs/scheduler';
import { logger } from './shared/logging/logger';

/** The operating time zone: daily jobs run on Addis Ababa days. */
const JOBS_TIME_ZONE = 'Africa/Addis_Ababa';

createApp().listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'fms-backend listening');
});

// Every instance schedules every job; a Redis lease picks one (FMS-72) and
// the jobs.job_runs row guarantees it runs once a day (FMS-26).
const runs = new PostgresJobLock(pool);
const lock = redis ? new RedisJobLock(redis, runs, (job, day) => redisKey('lock', 'job', job, day)) : runs;

startScheduler(
  [...modules.flatMap((m) => m.jobs ?? []), idempotencyPurgeJob(pool), outboxCleanupJob(pool)],
  {
    lock,
    audit: pool,
    timeZone: JOBS_TIME_ZONE,
    instanceId: `${hostname()}:${process.pid}`,
    log: (level, message, fields) => logger[level](fields, message),
  },
);

// Delivers domain events from the outbox to consumers and Redis (FMS-73).
// Every instance runs one; an advisory lock lets one relay at a time.
createOutboxRelay().start();
