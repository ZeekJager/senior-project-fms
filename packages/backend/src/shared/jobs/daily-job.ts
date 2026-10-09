/** A task a module wants run once a day (e.g. licence expiry warnings). */
export interface DailyJob {
  name: string;
  /** Local hour (0-23, in the scheduler's time zone) from which the day's run may happen. */
  hour: number;
  run(now: Date): Promise<void>;
}

export interface SchedulerOptions {
  timeZone: string;
  /** How often to check whether a job is due. */
  checkEveryMs?: number;
  now?: () => Date;
  onError?: (job: DailyJob, err: unknown) => void;
  onRun?: (job: DailyJob) => void;
}

/** `YYYY-MM-DD` and the hour of `at` in `timeZone`. */
function localDateAndHour(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * Runs each job at most once per local day, at or after its hour. Checks on
 * start (so a server that was down at the hour catches up the same day) and
 * then every `checkEveryMs`. Per process: with several servers each runs the
 * job, so jobs publish events with deterministic ids and consumers dedupe.
 * Until a shared scheduler exists (FMS-73's worker), this is enough for one
 * server. Returns a function that stops the timer.
 */
export function startDailyJobs(jobs: readonly DailyJob[], options: SchedulerOptions): () => void {
  const now = options.now ?? (() => new Date());
  const lastRun = new Map<string, string>();
  const running = new Set<string>();

  const tick = () => {
    const at = now();
    const { date, hour } = localDateAndHour(at, options.timeZone);
    for (const job of jobs) {
      if (hour < job.hour || lastRun.get(job.name) === date || running.has(job.name)) continue;
      running.add(job.name);
      lastRun.set(job.name, date);
      options.onRun?.(job);
      job
        .run(at)
        .catch((err: unknown) => {
          // Try again on the next check rather than skipping the day.
          lastRun.delete(job.name);
          options.onError?.(job, err);
        })
        .finally(() => running.delete(job.name));
    }
  };

  tick();
  const timer = setInterval(tick, options.checkEveryMs ?? 10 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
