/** What a job's run gets: the time it was triggered and its run's identity, for audit and events. */
export interface JobContext {
  now: Date;
  /** A fresh UUID per run: on the run's audit entry and on every event it publishes (actor: the system). */
  correlationId: string;
  /** The run key the lock was taken on: the local day (YYYY-MM-DD) for a daily job, the slot (YYYY-MM-DDTHH:MM) for an interval job. */
  runKey: string;
}

/**
 * A task a module wants run once a day (FMS-26), or every few minutes
 * (FMS-92). Declared on the module (AppModule.jobs) and run by the scheduler
 * in src/server.ts, never by tests or scripts. With several app instances it
 * still runs once per day, or once per slot: the run is locked on (name,
 * local day) or (name, slot).
 */
export interface ScheduledJob {
  /** Unique across modules; the lock and the run history are keyed on it. */
  name: string;
  /** Daily: local time, HH:MM in the scheduler's time zone, from which the day's run is due. Give `at` or `every`. */
  at?: string;
  /**
   * Instead of `at`: every this many minutes (a divisor of 60), on the clock (every 5: :00, :05 ...).
   * Each slot runs once. A missed slot is not caught up: the next one does its work. A run whose result
   * counts nothing (no number above 0) leaves no audit entries, so a quiet minute is not 2 audit rows.
   */
  every?: number;
  /** How long a run may hold the lock before another instance may take it over (the holder died). Default 15 minutes. */
  leaseMs?: number;
  /** What it did, for the run history and audit (counts, not personal data). */
  run(context: JobContext): Promise<Record<string, unknown> | void>;
}

/** When a job runs: daily at a local time, or every few minutes. Throws unless it has exactly one of `at` and `every`. */
export function scheduleOf(job: Pick<ScheduledJob, 'name' | 'at' | 'every'>): { kind: 'daily'; hour: number; minute: number } | { kind: 'every'; minutes: number } {
  if ((job.at === undefined) === (job.every === undefined)) throw new Error(`Job '${job.name}' needs exactly one of 'at' and 'every'`);
  if (job.at !== undefined) return { kind: 'daily', ...parseAt(job.at) };
  const minutes = job.every!;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 || 60 % minutes !== 0) {
    throw new Error(`Job '${job.name}': 'every' must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60), got ${minutes}`);
  }
  return { kind: 'every', minutes };
}

/** `{ hour, minute }` of a job's `at`; throws on anything but HH:MM. */
export function parseAt(at: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) throw new Error(`Job time must be HH:MM (00:00-23:59), got '${at}'`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
