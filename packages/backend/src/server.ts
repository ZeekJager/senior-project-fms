import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { modules } from './modules';
import { attachRealtime } from './modules/realtime';
import { setMetricReaders } from './shared/metrics/domain-metrics';
import { startMetricsServer } from './shared/metrics/metrics-server';
import { metricsRegistry } from './shared/metrics/registry';
import { systemHealth } from './modules/system';
import { redis, redisKey } from './shared/cache';
import { createOutboxRelay } from './shared/events/event-bus';
import { outboxCleanupJob } from './shared/events/outbox-cleanup';
import { idempotencyPurgeJob } from './shared/http/idempotency-purge';
import { jobRunsCleanupJob } from './shared/jobs/job-runs-cleanup';
import { PostgresJobLock } from './shared/jobs/job-lock';
import { RedisJobLock } from './shared/jobs/redis-job-lock';
import { startScheduler } from './shared/jobs/scheduler';
import { logger } from './shared/logging/logger';

/** The operating time zone: daily jobs run on Addis Ababa days. */
const JOBS_TIME_ZONE = 'Africa/Addis_Ababa';

const server = createServer(createApp());
// Socket.IO on the same server and port, at /api/v1/socket.io (FMS-43).
const realtime = attachRealtime(server);
setMetricReaders({ sockets: () => realtime.io.engine.clientsCount });
server.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'fms-backend listening');
});
// GET /metrics (FMS-75, docs/metrics.md) on its own port, never the public one.
startMetricsServer(metricsRegistry, config.metrics, (port) => logger.info({ port, host: config.metrics.host, token: config.metrics.token !== null }, 'fms-backend metrics listening'));

// Every instance schedules every job; a Redis lease picks one (FMS-72) and
// the jobs.job_runs row guarantees it runs once a day (FMS-26).
const runs = new PostgresJobLock(pool);
const lock = redis ? new RedisJobLock(redis, runs, (job, day) => redisKey('lock', 'job', job, day)) : runs;

startScheduler(
  [...modules.flatMap((m) => m.jobs ?? []), idempotencyPurgeJob(pool), outboxCleanupJob(pool), jobRunsCleanupJob(pool)],
  {
    lock,
    audit: pool,
    timeZone: JOBS_TIME_ZONE,
    instanceId: `${hostname()}:${process.pid}`,
    log: (level, message, fields) => logger[level](fields, message),
  },
);

// Every instance checks the API, the database, the replica, Redis, the AI service and the providers each
// minute and writes its request counts (FMS-143); not a scheduled job, so a database outage is sampled too.
systemHealth.start();

// Delivers domain events from the outbox to consumers and Redis (FMS-73).
// Every instance runs one; an advisory lock lets one relay at a time. With no
// Redis (one instance) it hands events to this instance's sockets directly.
createOutboxRelay(redis ? {} : { broadcaster: realtime.localBroadcaster }).start();
