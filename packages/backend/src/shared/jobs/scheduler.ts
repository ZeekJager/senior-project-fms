import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { recordAuditEntry, type AuditResult } from '../infrastructure/audit-log';
import type { Queryable } from '../infrastructure/queryable';
import { jobSource, withRequestSource } from '../infrastructure/request-source';
import type { JobLock } from './job-lock';
import { scheduleOf, type ScheduledJob } from './job';

export interface SchedulerDeps {
  lock: JobLock;
  /** Where the run's audit entries go (audit.audit_logs). */
  audit: Queryable;
  /** The jobs' clock: `at` and the run key (the local day) are in this zone. */
  timeZone: string;
  /** Which app instance this is, for the run history (host and pid). */
  instanceId: string;
  now?: () => Date;
  /** Failed runs are retried by the sweep until this many attempts in a day. Default 5. */
  maxAttempts?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>) => void;
}

export type JobOutcome =
  | { status: 'succeeded'; correlationId: string; result: Record<string, unknown> }
  | { status: 'failed'; correlationId: string; error: string }
  /** Another instance holds or has done today's run, or the attempts are used up. */
  | { status: 'skipped' };

const DEFAULT_LEASE_MS = 15 * 60_000;

/** `YYYY-MM-DD` and `HH:MM` of `at` in `timeZone`. */
export function localDateAndTime(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** Whether today's run of a daily `job` is due at `now`: the local time is at or past its `at`. Interval jobs are never caught up. */
export function isDue(job: ScheduledJob, now: Date, timeZone: string): boolean {
  return job.at !== undefined && localDateAndTime(now, timeZone).time >= job.at;
}

/** The lock's run key: the local day for a daily job; for an interval job, the start of its slot (`2026-10-21T09:15`). */
export function runKeyOf(job: ScheduledJob, now: Date, timeZone: string): string {
  const { date, time } = localDateAndTime(now, timeZone);
  const schedule = scheduleOf(job);
  if (schedule.kind === 'daily') return date;
  const [hour, minute] = time.split(':').map(Number);
  const slot = Math.floor(minute / schedule.minutes) * schedule.minutes;
  return `${date}T${String(hour).padStart(2, '0')}:${String(slot).padStart(2, '0')}`;
}

/** Whether a run's result counts anything: an interval run that did nothing is not audited. */
const didSomething = (result: Record<string, unknown>) => Object.values(result).some((v) => typeof v === 'number' && v > 0);

/**
 * One run of a job, if this instance gets the lock for today. Audited as the
 * system (no user) with a fresh UUID correlation id, which the job also puts
 * on the events it publishes: `job.started`, then `job.succeeded` with the
 * job's result or `job.failed` with the error. The whole run, and every
 * audit row it writes, has the source {channel: job, actor: system} (FMS-27).
 * Never throws.
 */
export function runJob(job: ScheduledJob, deps: SchedulerDeps): Promise<JobOutcome> {
  return withRequestSource(jobSource(job.name), () => runInContext(job, deps));
}

async function runInContext(job: ScheduledJob, deps: SchedulerDeps): Promise<JobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const runKey = runKeyOf(job, now, deps.timeZone);
  const interval = job.every !== undefined;
  const correlationId = randomUUID();
  const claim = await deps.lock.claim({
    jobName: job.name,
    runKey,
    instanceId: deps.instanceId,
    correlationId,
    leaseMs: job.leaseMs ?? DEFAULT_LEASE_MS,
    maxAttempts: deps.maxAttempts ?? 5,
  });
  if (!claim) return { status: 'skipped' };

  const audit = (action: string, details: Record<string, unknown>, result: AuditResult = 'success') =>
    recordAuditEntry(deps.audit, {
      action,
      result,
      userId: null,
      entityType: 'jobs.job_runs',
      entityId: claim.id,
      correlationId,
      details: { job: job.name, run_key: runKey, attempt: claim.attempts, instance: deps.instanceId, ...details },
    });

  const started = Date.now();
  if (!interval) await audit('job.started', {});
  try {
    const result = (await job.run({ now, correlationId, runKey })) ?? {};
    await deps.lock.succeed(claim, result);
    if (!interval || didSomething(result)) await audit('job.succeeded', { result, duration_ms: Date.now() - started });
    return { status: 'succeeded', correlationId, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.lock.fail(claim, error).catch(() => {});
    await audit('job.failed', { error, duration_ms: Date.now() - started }, 'failed').catch(() => {});
    return { status: 'failed', correlationId, error };
  }
}

export interface Scheduler {
  /** Runs every job that is due and not yet done today (what the sweep does). */
  runDue(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Schedules each daily job at its `at` (node-cron, in `timeZone`), plus a
 * sweep every 10 minutes and once at start: it runs jobs that are due but
 * not done today, so a server that was down at 07:00 catches up the same
 * day and a failed run is retried. Every trigger goes through the lock, so
 * the sweep, the cron trigger and other instances never run a day twice.
 * An interval job (`every`) runs on its own cron, once per slot.
 */
export function startScheduler(jobs: readonly ScheduledJob[], deps: SchedulerDeps): Scheduler {
  const names = new Set<string>();
  for (const job of jobs) {
    scheduleOf(job);
    if (names.has(job.name)) throw new Error(`Two scheduled jobs are named '${job.name}'`);
    names.add(job.name);
  }
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<void>>();

  const trigger = (job: ScheduledJob): Promise<void> => {
    const running = inFlight.get(job.name);
    if (running) return running;
    const run = runJob(job, deps)
      .then((outcome) => {
        if (outcome.status === 'succeeded') log('info', 'job succeeded', { job: job.name, correlationId: outcome.correlationId, result: outcome.result });
        if (outcome.status === 'failed') log('error', 'job failed', { job: job.name, correlationId: outcome.correlationId, error: outcome.error });
      })
      .catch((err: unknown) => log('error', 'job could not be started', { job: job.name, err }))
      .finally(() => inFlight.delete(job.name));
    inFlight.set(job.name, run);
    return run;
  };

  const runDue = async () => {
    await Promise.all(jobs.filter((job) => isDue(job, now(), deps.timeZone)).map(trigger));
  };

  const tasks = jobs.map((job) => {
    const schedule = scheduleOf(job);
    const expression =
      schedule.kind === 'daily' ? `${schedule.minute} ${schedule.hour} * * *` : schedule.minutes === 60 ? '0 * * * *' : `*/${schedule.minutes} * * * *`;
    return cron.schedule(expression, () => trigger(job), { timezone: deps.timeZone, name: job.name, noOverlap: true });
  });
  tasks.push(cron.schedule('*/10 * * * *', runDue, { timezone: deps.timeZone, name: 'job-sweep', noOverlap: true }));
  void runDue();

  return {
    runDue,
    async stop() {
      await Promise.all(tasks.map((t) => t.destroy()));
      await Promise.all(inFlight.values());
    },
  };
}
