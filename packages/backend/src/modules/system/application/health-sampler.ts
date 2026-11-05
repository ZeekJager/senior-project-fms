import type { Queryable } from '../../../shared/infrastructure/queryable';
import { errorText, floorToMinute, LATENCY_BUCKET_COUNT, latencyBucket, MINUTE_MS, type Sample } from '../domain/health';
import type { HealthRepository, RequestMinute } from '../infrastructure/health.repository';

/** What a check found besides "ok": the component is not configured here, or a latency of its own (a circuit's mean). */
export interface ProbeResult {
  disabled?: boolean;
  latencyMs?: number | null;
}

/** One component's check: resolves when it is up, rejects (or times out) when it is down. */
export interface Probe {
  component: string;
  label: string;
  check(): Promise<ProbeResult | void>;
}

export interface SamplerLog {
  warn(obj: object, msg: string): void;
}

export interface SamplerDeps {
  db: Queryable;
  repo: HealthRepository;
  /** The checks of this minute: the fixed components and each active provider. */
  probes: () => Promise<Probe[]>;
  requests: RequestRecorder;
  /** A check slower than this is down. Default 3 s. */
  timeoutMs?: number;
  log?: SamplerLog;
}

/** Minutes of samples kept in memory while the database cannot be written: a day. */
const MAX_PENDING_MINUTES = 24 * 60;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Per minute, per instance: how many requests the API answered, how many with a 5xx, and their latencies as a
 * histogram. Counts only, never a path, a body, a user or an id. Written by the sampler each minute, added to
 * what other instances wrote for the same minute.
 */
export class RequestRecorder {
  private minutes = new Map<number, RequestMinute>();

  record(status: number, durationMs: number, at = Date.now()): void {
    const key = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    let m = this.minutes.get(key);
    if (!m) {
      m = {
        minute: new Date(key),
        requests: 0,
        errors5xx: 0,
        latencyBuckets: new Array<number>(LATENCY_BUCKET_COUNT).fill(0),
      };
      this.minutes.set(key, m);
    }
    m.requests += 1;
    if (status >= 500) m.errors5xx += 1;
    m.latencyBuckets[latencyBucket(durationMs)] += 1;
  }

  /** Everything counted so far, emptied. */
  take(): RequestMinute[] {
    const taken = [...this.minutes.values()];
    this.minutes = new Map();
    return taken;
  }

  /** Puts counts back that could not be written, added to any counted since. */
  restore(minutes: readonly RequestMinute[]): void {
    for (const m of minutes) {
      const key = m.minute.getTime();
      const current = this.minutes.get(key);
      if (!current) {
        this.minutes.set(key, m);
        continue;
      }
      current.requests += m.requests;
      current.errors5xx += m.errors5xx;
      current.latencyBuckets = current.latencyBuckets.map((n, i) => n + (m.latencyBuckets[i] ?? 0));
    }
    // A database down for over a day: the oldest minutes go.
    const keys = [...this.minutes.keys()].sort((a, b) => a - b);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PENDING_MINUTES))) this.minutes.delete(key);
  }
}

/**
 * The health sampler (FMS-143): each minute, on every API instance, checks every component at once (each
 * within `timeoutMs`), records ok, down with the error, or disabled, with the check's latency, and writes
 * the minute's request counts. Not a scheduled job: those take their lock in the database, and the sampler
 * must still take its samples while the database is down. What cannot be written is kept (up to a day) and
 * written once the database answers again, so a database outage is recorded too.
 */
export class HealthSampler {
  private pending: { minute: Date; samples: Sample[] }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private flushing: Promise<void> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly deps: SamplerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 3_000;
  }

  /** Checks every component now, for the minute `at` falls in. Never throws. */
  async sample(at = new Date()): Promise<Sample[]> {
    const probes = await this.deps.probes().catch((err: unknown) => {
      this.deps.log?.warn({ err }, 'system health: could not list the components to check');
      return [] as Probe[];
    });
    const samples = await Promise.all(probes.map((p) => this.check(p)));
    this.pending.push({ minute: floorToMinute(at), samples });
    if (this.pending.length > MAX_PENDING_MINUTES) this.pending.splice(0, this.pending.length - MAX_PENDING_MINUTES);
    return samples;
  }

  private async check(probe: Probe): Promise<Sample> {
    const started = performance.now();
    try {
      const result = (await withTimeout(probe.check(), this.timeoutMs)) ?? {};
      if (result.disabled)
        return {
          component: probe.component,
          label: probe.label,
          status: 'disabled',
          latencyMs: null,
          error: null,
        };
      const latencyMs = result.latencyMs !== undefined ? result.latencyMs : Math.round(performance.now() - started);
      return {
        component: probe.component,
        label: probe.label,
        status: 'ok',
        latencyMs,
        error: null,
      };
    } catch (err) {
      return {
        component: probe.component,
        label: probe.label,
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        error: errorText(err),
      };
    }
  }

  /** Writes the samples and request counts not yet written; keeps them for the next minute when the database fails. */
  async flush(): Promise<void> {
    const { db, repo, requests } = this.deps;
    while (this.pending.length > 0) {
      const next = this.pending[0];
      try {
        await repo.insertSamples(db, next.minute, next.samples);
      } catch (err) {
        this.deps.log?.warn({ err, pending_minutes: this.pending.length }, 'system health: samples not written; kept for the next minute');
        break;
      }
      this.pending.shift();
    }
    const minutes = requests.take();
    try {
      await repo.addRequests(db, minutes);
    } catch (err) {
      requests.restore(minutes);
      this.deps.log?.warn({ err }, 'system health: request counts not written; kept for the next minute');
    }
  }

  /**
   * One minute's work: sample, then write. A write still under way (a database that hangs) is not waited for
   * and not started twice: the minute's samples wait in memory, and sampling goes on.
   */
  async tick(at = new Date()): Promise<void> {
    await this.sample(at);
    this.flushing ??= this.flush().finally(() => {
      this.flushing = null;
    });
  }

  /** Samples at the start of every minute (a second in, so the minute is unambiguous) until `stop`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const schedule = () => {
      if (!this.started) return;
      const delay = MINUTE_MS - (Date.now() % MINUTE_MS) + 1_000;
      this.timer = setTimeout(() => {
        void this.tick().finally(schedule);
      }, delay);
      this.timer.unref();
    };
    schedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flushing;
  }
}
