// System health (FMS-143, docs/system-health.md): what the sampler records each minute and how uptime,
// outages and request latency are worked out from it. Pure: no clock, no database.

export const MINUTE_MS = 60_000;

/** The components every instance checks, in the screen's order. Providers follow as `provider:<code>`. */
export const CORE_COMPONENTS = [
  { component: 'api', label: 'API' },
  { component: 'database', label: 'Database' },
  { component: 'replica', label: 'Read replica' },
  { component: 'redis', label: 'Redis' },
  { component: 'ai_service', label: 'AI service' },
] as const;

export type ComponentKind = 'api' | 'database' | 'replica' | 'redis' | 'ai_service' | 'provider';

export const providerComponent = (code: string) => `provider:${code}`;
export const kindOf = (component: string): ComponentKind =>
  component.startsWith('provider:') ? 'provider' : (component as Exclude<ComponentKind, 'provider'>);

/** A check's result: ok, down (with why), or disabled (not configured on this server). */
export type SampleStatus = 'ok' | 'down' | 'disabled';

export interface Sample {
  component: string;
  label: string;
  status: SampleStatus;
  latencyMs: number | null;
  error: string | null;
}

/** Consecutive minutes a component had the same status: [start, end), whole minutes. */
export interface Run {
  component: string;
  label: string;
  status: SampleStatus;
  start: Date;
  end: Date;
  /** The first error of a down run. */
  error: string | null;
}

/** The windows the screen shows, in minutes. */
export const WINDOWS = {
  '24h': 24 * 60,
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60,
} as const;
export type WindowKey = keyof typeof WINDOWS;
export const WINDOW_KEYS = Object.keys(WINDOWS) as WindowKey[];

/** Samples and request rollups are kept this long (system-health-retention). */
export const RETENTION_DAYS = 30;

/** What a minute with no sample of the API means: no instance was running to take one. */
export const API_GAP_ERROR = 'No samples: the API was not running';

/** Errors are stored in our words and kept short; never a request, a user or an id. */
export const MAX_ERROR_LENGTH = 300;

export const floorToMinute = (at: Date) => new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
const minutesBetween = (from: number, to: number) => Math.max(0, Math.round((to - from) / MINUTE_MS));

/**
 * The API's runs with its gaps filled in: the API is up in every minute an instance sampled, so a gap
 * between two of its samples is the API down. A gap after the last sample is not: the API answering now
 * is up, and the minute may simply not be written yet; it stays no data.
 */
export function withApiGaps(apiRuns: readonly Run[]): Run[] {
  const sorted = [...apiRuns].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Run[] = [];
  for (const run of sorted) {
    const previous = out[out.length - 1];
    if (previous && run.start.getTime() > previous.end.getTime()) {
      out.push({
        component: run.component,
        label: run.label,
        status: 'down',
        start: previous.end,
        end: run.start,
        error: API_GAP_ERROR,
      });
    }
    out.push(run);
  }
  return out;
}

export interface Uptime {
  /** ok / (ok + down), floored to two decimals so a short outage never reads 100%. Null with no ok or down minute. */
  uptime_pct: number | null;
  ok_minutes: number;
  down_minutes: number;
  disabled_minutes: number;
  /** Minutes in the window, since sampling began, with no sample of this component. Left out of the uptime. */
  no_data_minutes: number;
}

/**
 * A component's uptime over [from, to) from its runs. The window starts no earlier than `sampledFrom`, the
 * first sample of all (before it there was nothing to sample with); null when nothing was ever sampled.
 */
export function uptimeOf(runs: readonly Run[], from: Date, to: Date, sampledFrom: Date | null): Uptime {
  const start = sampledFrom ? Math.max(from.getTime(), sampledFrom.getTime()) : to.getTime();
  const end = to.getTime();
  const minutes = { ok: 0, down: 0, disabled: 0 };
  for (const run of runs) minutes[run.status] += minutesBetween(Math.max(start, run.start.getTime()), Math.min(end, run.end.getTime()));
  const total = minutesBetween(start, end);
  const counted = minutes.ok + minutes.down;
  return {
    uptime_pct: counted > 0 ? Math.floor((minutes.ok / counted) * 10_000) / 100 : null,
    ok_minutes: minutes.ok,
    down_minutes: minutes.down,
    disabled_minutes: minutes.disabled,
    no_data_minutes: Math.max(0, total - minutes.ok - minutes.down - minutes.disabled),
  };
}

export interface Outage {
  component: string;
  label: string;
  started_at: Date;
  /** Null while it goes on: the component was down in the last minute sampled. */
  ended_at: Date | null;
  duration_minutes: number;
  error: string | null;
}

/**
 * Every down run reaching into [from, to), newest first. One whose last minute is the last or the one before
 * (the current minute's sample may not be written yet, as in currentStatus) is still going on.
 */
export function outagesOf(runs: readonly Run[], from: Date, to: Date): Outage[] {
  return runs
    .filter((r) => r.status === 'down' && r.end.getTime() > from.getTime() && r.start.getTime() < to.getTime())
    .map((r) => {
      const ongoing = r.end.getTime() >= to.getTime() - MINUTE_MS;
      return {
        component: r.component,
        label: r.label,
        started_at: r.start,
        ended_at: ongoing ? null : r.end,
        duration_minutes: minutesBetween(r.start.getTime(), Math.min(r.end.getTime(), to.getTime())),
        error: r.error,
      };
    })
    .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
}

/** The component's status now: its sample of the last or the minute before (one may not be written yet), else no data. */
export function currentStatus(runs: readonly Run[], to: Date): SampleStatus | 'no_data' {
  const last = runs.reduce<Run | null>((latest, r) => (!latest || r.end.getTime() > latest.end.getTime() ? r : latest), null);
  if (!last || last.end.getTime() < to.getTime() - MINUTE_MS) return 'no_data';
  return last.status;
}

/** How a window is cut for the charts: 15-minute cells over 24 hours, 2 hours over 7 days, 8 hours over 30. */
export const BUCKET_MINUTES: Record<WindowKey, number> = {
  '24h': 15,
  '7d': 120,
  '30d': 480,
};

export interface TimelineCell {
  start: Date;
  ok_minutes: number;
  down_minutes: number;
  disabled_minutes: number;
  no_data_minutes: number;
}

/** A component's minutes per cell of [from, to), for the status strip. Cells before `sampledFrom` are all no data. */
export function timelineOf(runs: readonly Run[], from: Date, to: Date, bucketMinutes: number, sampledFrom: Date | null): TimelineCell[] {
  const size = bucketMinutes * MINUTE_MS;
  const cells: TimelineCell[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += size) {
    const cellEnd = Math.min(at + size, to.getTime());
    const u = uptimeOf(runs, new Date(at), new Date(cellEnd), sampledFrom);
    const before = sampledFrom ? minutesBetween(at, Math.min(cellEnd, Math.max(at, sampledFrom.getTime()))) : minutesBetween(at, cellEnd);
    cells.push({
      start: new Date(at),
      ok_minutes: u.ok_minutes,
      down_minutes: u.down_minutes,
      disabled_minutes: u.disabled_minutes,
      no_data_minutes: u.no_data_minutes + before,
    });
  }
  return cells;
}

/**
 * Upper bounds of the request latency histogram, in ms; one more bucket holds everything slower. Stored per
 * minute in system.request_rollups.latency_buckets, so the bounds only ever grow at the end.
 */
export const REQUEST_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000] as const;
export const LATENCY_BUCKET_COUNT = REQUEST_LATENCY_BUCKETS_MS.length + 1;

export function latencyBucket(ms: number): number {
  const i = REQUEST_LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
  return i === -1 ? REQUEST_LATENCY_BUCKETS_MS.length : i;
}

/** Adds histograms bucket by bucket. */
export function addHistograms(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
}

/**
 * The 95th percentile of a latency histogram, in whole ms, interpolated within its bucket; null with no
 * requests. In the open last bucket it is that bucket's lower bound (10 s): at least that long.
 */
export function p95Of(histogram: readonly number[]): number | null {
  const total = histogram.reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const rank = Math.ceil(total * 0.95);
  let below = 0;
  for (let i = 0; i < histogram.length; i++) {
    const n = histogram[i];
    if (n > 0 && below + n >= rank) {
      const lower = i === 0 ? 0 : REQUEST_LATENCY_BUCKETS_MS[i - 1];
      const upper = REQUEST_LATENCY_BUCKETS_MS[i];
      if (upper === undefined) return lower;
      return Math.round(lower + ((upper - lower) * (rank - below)) / n);
    }
    below += n;
  }
  return null;
}

/** Errors as a share of requests, to two decimals; null with no requests. */
export const errorRatePct = (requests: number, errors: number): number | null => (requests > 0 ? Math.round((errors / requests) * 10_000) / 100 : null);

/** A check's error as stored: one line, at most MAX_ERROR_LENGTH characters. */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.replace(/\s+/g, ' ').trim() || 'The check failed';
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}
