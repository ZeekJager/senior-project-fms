import type { Queryable } from '../../../shared/infrastructure/queryable';
import { failedJobRuns, type FailedJobRun } from '../../../shared/jobs/job-runs';
import {
  addHistograms,
  BUCKET_MINUTES,
  CORE_COMPONENTS,
  currentStatus,
  errorRatePct,
  floorToMinute,
  kindOf,
  MINUTE_MS,
  outagesOf,
  p95Of,
  RETENTION_DAYS,
  timelineOf,
  uptimeOf,
  WINDOW_KEYS,
  WINDOWS,
  withApiGaps,
  type ComponentKind,
  type Outage,
  type Run,
  type SampleStatus,
  type TimelineCell,
  type Uptime,
  type WindowKey,
} from '../domain/health';
import type { HealthRepository } from '../infrastructure/health.repository';

export interface SystemHealthDeps {
  db: Queryable;
  repo: HealthRepository;
  now?: () => Date;
}

export interface ComponentHealth {
  component: string;
  kind: ComponentKind;
  label: string;
  /** Now: its last sample, `no_data` when it has none in the last two minutes. */
  status: SampleStatus | 'no_data';
  checked_at: Date | null;
  latency_ms: number | null;
  /** Why it is down, in our words. */
  error: string | null;
  uptime: Record<WindowKey, Uptime>;
}

export interface SystemHealthSummary {
  generated_at: Date;
  /** The end of every window: the start of the current minute. */
  window_end: Date;
  /** The first sample in the last 30 days: no uptime is counted before it. Null when nothing was sampled. */
  sampled_from: Date | null;
  components: ComponentHealth[];
  /** The last 30 days, newest first, at most MAX_OUTAGES. */
  outages: Outage[];
  outages_total: number;
  /** Failed scheduled job runs of the last 30 days, newest first, at most MAX_FAILED_JOBS. */
  failed_jobs: FailedJobRun[];
  failed_jobs_total: number;
}

export interface RequestStats {
  requests: number;
  errors_5xx: number;
  error_rate_pct: number | null;
  p95_ms: number | null;
}

export interface SystemHealthHistory {
  window: WindowKey;
  from: Date;
  to: Date;
  bucket_minutes: number;
  requests: RequestStats & { cells: (RequestStats & { start: Date })[] };
  components: { component: string; label: string; cells: TimelineCell[] }[];
}

const MAX_OUTAGES = 100;
const MAX_FAILED_JOBS = 50;

/** Each component's runs, the API's gaps filled in, in the screen's order: the core components, then providers by name. */
function byComponent(runs: readonly Run[]): { component: string; label: string; runs: Run[] }[] {
  const grouped = new Map<string, Run[]>();
  for (const r of runs) grouped.set(r.component, [...(grouped.get(r.component) ?? []), r]);
  const core = CORE_COMPONENTS.map((c) => ({
    component: c.component as string,
    label: c.label as string,
    runs: c.component === 'api' ? withApiGaps(grouped.get('api') ?? []) : (grouped.get(c.component) ?? []),
  }));
  const providers = [...grouped.entries()]
    .filter(([component]) => kindOf(component) === 'provider')
    .map(([component, list]) => ({
      component,
      label: list[list.length - 1].label,
      runs: list,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...core, ...providers];
}

/** The start of the history: the API's first sample, which every instance takes each minute. */
const sampledFromOf = (runs: readonly Run[]) =>
  runs.filter((r) => r.component === 'api').reduce<Date | null>((first, r) => (!first || r.start < first ? r.start : first), null);

function stats(requests: number, errors: number, histogram: readonly number[]): RequestStats {
  return {
    requests,
    errors_5xx: errors,
    error_rate_pct: errorRatePct(requests, errors),
    p95_ms: p95Of(histogram),
  };
}

/** System health (FMS-143, docs/system-health.md): read from the primary, so it never depends on the replica it reports on. */
export class SystemHealthService {
  private readonly now: () => Date;

  constructor(private readonly deps: SystemHealthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** GET /system/health. */
  async summary(): Promise<SystemHealthSummary> {
    const { db, repo } = this.deps;
    const generatedAt = this.now();
    const to = floorToMinute(generatedAt);
    const from = new Date(to.getTime() - WINDOWS['30d'] * MINUTE_MS);
    // One after another: a transaction's client (the tests') runs one query at a time.
    const runs = await repo.runs(db, from);
    const latest = await repo.latest(db, new Date(to.getTime() - 10 * MINUTE_MS));
    const jobs = await failedJobRuns(db, from, MAX_FAILED_JOBS);
    const sampledFrom = sampledFromOf(runs);
    const latestOf = new Map(latest.map((s) => [s.component, s]));

    const groups = byComponent(runs);
    const components = groups.map(({ component, label, runs: own }): ComponentHealth => {
      const last = latestOf.get(component);
      let status = currentStatus(own, to);
      // The API answering this request is up, whatever its last sample says it was.
      if (component === 'api' && status === 'no_data') status = 'ok';
      return {
        component,
        kind: kindOf(component),
        label: last?.label ?? label,
        status,
        checked_at: last?.minute ?? null,
        latency_ms: status === 'no_data' ? null : (last?.latencyMs ?? null),
        error: status === 'down' ? (last?.error ?? null) : null,
        uptime: Object.fromEntries(WINDOW_KEYS.map((w) => [w, uptimeOf(own, new Date(to.getTime() - WINDOWS[w] * MINUTE_MS), to, sampledFrom)])) as Record<
          WindowKey,
          Uptime
        >,
      };
    });

    const labels = new Map(components.map((c) => [c.component, c.label]));
    const outages = outagesOf(
      groups.flatMap((g) => g.runs),
      from,
      to,
    ).map((o) => ({ ...o, label: labels.get(o.component) ?? o.label }));

    return {
      generated_at: generatedAt,
      window_end: to,
      sampled_from: sampledFrom,
      components,
      outages: outages.slice(0, MAX_OUTAGES),
      outages_total: outages.length,
      failed_jobs: jobs.runs,
      failed_jobs_total: jobs.total,
    };
  }

  /** GET /system/health/history: requests, errors and p95 latency per cell of the window, and each component's minutes per cell. */
  async history(window: WindowKey): Promise<SystemHealthHistory> {
    const { db, repo } = this.deps;
    const to = floorToMinute(this.now());
    const bucket = BUCKET_MINUTES[window];
    // Cells end at `to`; the first one may reach before the window, so every cell is whole.
    const cellCount = Math.ceil(WINDOWS[window] / bucket);
    const from = new Date(to.getTime() - cellCount * bucket * MINUTE_MS);
    const runs = await repo.runs(db, new Date(to.getTime() - WINDOWS['30d'] * MINUTE_MS));
    const cells = await repo.requestCells(db, from, to, bucket);
    const sampledFrom = sampledFromOf(runs);

    const byIndex = new Map(cells.map((c) => [c.index, c]));
    let total = { requests: 0, errors: 0, histogram: [] as number[] };
    const requestCells = Array.from({ length: cellCount }, (_, i) => {
      const c = byIndex.get(i);
      if (c)
        total = {
          requests: total.requests + c.requests,
          errors: total.errors + c.errors5xx,
          histogram: addHistograms(total.histogram, c.latencyBuckets),
        };
      return {
        start: new Date(from.getTime() + i * bucket * MINUTE_MS),
        ...stats(c?.requests ?? 0, c?.errors5xx ?? 0, c?.latencyBuckets ?? []),
      };
    });

    return {
      window,
      from,
      to,
      bucket_minutes: bucket,
      requests: {
        ...stats(total.requests, total.errors, total.histogram),
        cells: requestCells,
      },
      components: byComponent(runs).map(({ component, label, runs: own }) => ({
        component,
        label,
        cells: timelineOf(own, from, to, bucket, sampledFrom),
      })),
    };
  }

  /** The daily retention: samples and request counts past RETENTION_DAYS go. */
  async purge(now: Date): Promise<Record<string, number>> {
    const removed = await this.deps.repo.deleteBefore(this.deps.db, new Date(floorToMinute(now).getTime() - RETENTION_DAYS * 24 * 60 * MINUTE_MS));
    return {
      samples_deleted: removed.samples,
      request_minutes_deleted: removed.rollups,
    };
  }
}
