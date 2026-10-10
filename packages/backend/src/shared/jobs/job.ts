/** What a job's run gets: the time it was triggered and its run's identity, for audit and events. */
export interface JobContext {
  now: Date;
  /** A fresh UUID per run: on the run's audit entry and on every event it publishes (actor: the system). */
  correlationId: string;
  /** The run key the lock was taken on: the local day (YYYY-MM-DD) for a daily job. */
  runKey: string;
}

/**
 * A task a module wants run once a day (FMS-26). Declared on the module
 * (AppModule.jobs) and run by the scheduler in src/server.ts, never by tests
 * or scripts. With several app instances it still runs once per day: the
 * run is locked on (name, local day).
 */
export interface ScheduledJob {
  /** Unique across modules; the lock and the run history are keyed on it. */
  name: string;
  /** Local time, HH:MM in the scheduler's time zone, from which the day's run is due. */
  at: string;
  /** How long a run may hold the lock before another instance may take it over (the holder died). Default 15 minutes. */
  leaseMs?: number;
  /** What it did, for the run history and audit (counts, not personal data). */
  run(context: JobContext): Promise<Record<string, unknown> | void>;
}

/** `{ hour, minute }` of a job's `at`; throws on anything but HH:MM. */
export function parseAt(at: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!match) throw new Error(`Job time must be HH:MM (00:00-23:59), got '${at}'`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
