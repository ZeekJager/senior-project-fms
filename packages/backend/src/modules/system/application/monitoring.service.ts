import type { PoolClient } from 'pg';
import { AppError, validationFailed } from '../../../shared/errors/app-error';
import { createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { RequestUser } from '../../../types/express';
import {
  RANGE_SPECS,
  daysUntil,
  silences,
  statusOf,
  toMonitoringAlerts,
  worst,
  type AlertmanagerPayload,
  type MonitoringAlert,
  type Range,
  type Status,
} from '../domain/monitoring';
import type { MaintenanceRepository, WindowRow } from '../infrastructure/maintenance.repository';
import { PrometheusUnavailable, type PrometheusClient, type Series } from '../infrastructure/prometheus.client';

/** The monitoring thresholds as the settings say now (FMS-163). */
export interface Thresholds {
  cpu: [number, number];
  memory: [number, number];
  disk: [number, number];
  dbConnections: [number, number];
  replicaLag: [number, number];
  errorRate: [number, number];
  p95: [number, number];
  gpsSilenceMinutes: number;
}

export interface MonitoringDeps {
  prometheus: PrometheusClient | null;
  repo: MaintenanceRepository;
  events: EventBus;
  thresholds: () => Promise<Thresholds>;
  /** The report PDF (the analytics module's table writer). */
  pdf: (table: { title: string; subtitle: string; columns: { label: string; align: 'left' | 'right' }[]; rows: string[][]; totals: string[] | null; footer: string }) => Buffer;
  now?: () => Date;
}

interface Caller {
  user: RequestUser;
  correlationId: string;
}

type Point = [number, number];
/** A metric on a tile: its latest value and when it was sampled, its status, and its series over the range. */
interface Metric {
  value: number | null;
  sampled_at: string | null;
  status: Status;
  series: Point[];
}

// The queries. `host` is the node's name (Prometheus' relabelling sets it); a container is its Compose service.
const Q = {
  hostCpu: '100 * (1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[2m])))',
  hostMemory: '100 * (1 - sum by (host) (node_memory_MemAvailable_bytes) / sum by (host) (node_memory_MemTotal_bytes))',
  hostDisk: 'max by (host) (100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))',
  hostNetIn: 'sum by (host) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[2m]))',
  hostNetOut: 'sum by (host) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[2m]))',
  serviceCpu: '100 * sum by (service) (rate(container_cpu_usage_seconds_total{service!=""}[2m]))',
  serviceMemory: '100 * sum by (service) (container_memory_working_set_bytes{service!=""}) / scalar(sum(node_memory_MemTotal_bytes))',
  serviceNetIn: 'sum by (service) (rate(container_network_receive_bytes_total{service!=""}[2m]))',
  serviceNetOut: 'sum by (service) (rate(container_network_transmit_bytes_total{service!=""}[2m]))',
  requestRate: '60 * sum(rate(http_request_duration_seconds_count{service="fms-backend"}[5m]))',
  errorPct: '100 * sum(rate(http_request_duration_seconds_count{service="fms-backend",status_class="5xx"}[5m])) / clamp_min(sum(rate(http_request_duration_seconds_count{service="fms-backend"}[5m])), 1e-9)',
  p95Ms: '1000 * histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="fms-backend"}[5m])))',
  gpsPerMinute: '60 * sum(rate(gps_points_stored_total[5m]))',
  sockets: 'sum(socket_connections)',
  jobFailures: 'sum(increase(job_duration_seconds_count{status="failed"}[1h]))',
  dbConnectionsPct: '100 * sum(pg_stat_activity_count{role="primary"}) / max(pg_settings_max_connections{role="primary"})',
  dbTps: 'sum(rate(pg_stat_database_xact_commit{role="primary"}[5m]) + rate(pg_stat_database_xact_rollback{role="primary"}[5m]))',
  dbCacheHitPct: '100 * sum(rate(pg_stat_database_blks_hit{role="primary"}[5m])) / clamp_min(sum(rate(pg_stat_database_blks_hit{role="primary"}[5m])) + sum(rate(pg_stat_database_blks_read{role="primary"}[5m])), 1e-9)',
  replicaLag: 'max(replica_lag_seconds)',
  dbSizeBytes: 'sum(pg_database_size_bytes{role="primary"})',
} as const;

const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
const round = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const MAX_WINDOW_DAYS = 31;

/**
 * Live resources and their history (FMS-163, docs/observability.md), read from Prometheus by the API so the browser
 * never calls it; Alertmanager's alerts into the alert engine, held back for hosts in a maintenance window; the
 * monthly capacity report. system:read reads, settings:write keeps the windows.
 */
export class MonitoringService {
  private readonly now: () => Date;

  constructor(private readonly deps: MonitoringDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** GET /system/metrics?range=: every host and service tile, the application and database panels, over the range. */
  async metrics(range: Range) {
    const t = await this.deps.thresholds();
    const prom = this.deps.prometheus;
    const now = Math.floor(this.now().getTime() / 1000);
    const spec = RANGE_SPECS[range];
    const base = { range, step_seconds: spec.stepSeconds, generated_at: new Date(now * 1000).toISOString(), thresholds: this.thresholdView(t) };
    if (!prom) return { ...base, source: { configured: false, reachable: false }, hosts: [], services: [], application: null, database: null };
    const start = now - spec.seconds;
    const series = (q: string) => prom.range(q, start, now, spec.stepSeconds);
    try {
      const [hostCpu, hostMem, hostDisk, hostIn, hostOut, svcCpu, svcMem, svcIn, svcOut] = await Promise.all([
        series(Q.hostCpu),
        series(Q.hostMemory),
        series(Q.hostDisk),
        series(Q.hostNetIn),
        series(Q.hostNetOut),
        series(Q.serviceCpu),
        series(Q.serviceMemory),
        series(Q.serviceNetIn),
        series(Q.serviceNetOut),
      ]);
      const app = await Promise.all([Q.requestRate, Q.errorPct, Q.p95Ms, Q.gpsPerMinute, Q.sockets, Q.jobFailures].map(series));
      const db = await Promise.all([Q.dbConnectionsPct, Q.dbTps, Q.dbCacheHitPct, Q.replicaLag].map(series));
      const slowest = await this.deps.repo.slowestQueries(this.deps.repo.pool());

      const names = (list: Series[][], label: string) => [...new Set(list.flatMap((s) => s.map((x) => x.labels[label] ?? '')))].filter(Boolean).sort();
      const pick = (list: Series[], label: string, name: string) => list.find((s) => s.labels[label] === name) ?? null;
      const metric = (s: Series | null, lines: [number, number] | null): Metric => {
        const last = s?.values.at(-1) ?? null;
        const value = last ? round(last[1]) : null;
        return { value, sampled_at: last ? iso(last[0]) : null, status: lines ? statusOf(value, lines[0], lines[1]) : value === null ? 'unknown' : 'ok', series: (s?.values ?? []).map(([ts, v]) => [ts, round(v, 2)!] as Point) };
      };
      const tile = (label: 'host' | 'service', name: string, cpu: Series[], mem: Series[], disk: Series[] | null, rx: Series[], tx: Series[]) => {
        const m = {
          cpu: metric(pick(cpu, label, name), t.cpu),
          memory: metric(pick(mem, label, name), t.memory),
          disk: disk ? metric(pick(disk, label, name), t.disk) : null,
          network_in: metric(pick(rx, label, name), null),
          network_out: metric(pick(tx, label, name), null),
        };
        return { name, status: worst([m.cpu.status, m.memory.status, ...(m.disk ? [m.disk.status] : [])]), ...m };
      };
      const single = (s: Series[]) => s[0] ?? null;
      return {
        ...base,
        source: { configured: true, reachable: true },
        hosts: names([hostCpu, hostMem, hostDisk], 'host').map((h) => tile('host', h, hostCpu, hostMem, hostDisk, hostIn, hostOut)),
        services: names([svcCpu, svcMem], 'service').map((s) => tile('service', s, svcCpu, svcMem, null, svcIn, svcOut)),
        application: {
          request_rate_per_minute: metric(single(app[0]), null),
          error_pct: metric(single(app[1]), t.errorRate),
          p95_ms: metric(single(app[2]), t.p95),
          gps_points_per_minute: metric(single(app[3]), null),
          sockets: metric(single(app[4]), null),
          job_failures_last_hour: metric(single(app[5]), [1, 1]),
        },
        database: {
          connections_pct: metric(single(db[0]), t.dbConnections),
          transactions_per_second: metric(single(db[1]), null),
          cache_hit_pct: metric(single(db[2]), null),
          replica_lag_seconds: metric(single(db[3]), t.replicaLag),
          slowest_queries: slowest.map((q) => ({ query: q.query, calls: q.calls, mean_ms: q.meanMs, total_ms: q.totalMs })),
        },
      };
    } catch (err) {
      if (err instanceof PrometheusUnavailable) return { ...base, source: { configured: true, reachable: false, error: err.message }, hosts: [], services: [], application: null, database: null };
      throw err;
    }
  }

  /**
   * POST /system/alerts/webhook: Alertmanager's alerts, each an event the alert engine turns into an alert (firing) or
   * closes (resolved); a firing one for a host in a maintenance window is held back and counted. Each event's id comes
   * from the alert and its start, so Alertmanager repeating itself is one alert.
   */
  async webhook(payload: AlertmanagerPayload, correlationId: string): Promise<{ published: number; suppressed: number }> {
    const alerts = toMonitoringAlerts(payload);
    const { repo } = this.deps;
    const now = this.now();
    return repo.inTransaction(async (client) => {
      const windows = await repo.inForce(client, now);
      let published = 0;
      let suppressed = 0;
      const events = [];
      for (const a of alerts) {
        const holding = a.status === 'firing' ? windows.filter((w) => silences(w, a.host, now)) : [];
        if (holding.length) {
          suppressed += 1;
          await repo.countSuppressed(client, holding.map((w) => w.id));
          continue;
        }
        events.push(this.event(a, correlationId));
        published += 1;
      }
      if (events.length) await this.deps.events.publish(client, events);
      return { published, suppressed };
    });
  }

  private event(a: MonitoringAlert, correlationId: string) {
    const type = a.status === 'firing' ? 'MonitoringAlertFiring' : 'MonitoringAlertResolved';
    return createEvent(
      type,
      { fingerprint: a.fingerprint, alert_name: a.alertName, severity: a.severity, host: a.host, summary: a.summary, description: a.description, started_at: a.startedAt },
      { actor: null, correlationId },
      // One per alert, start and severity: a repeat of the same is skipped, a warning becoming critical is new.
      { id: deterministicEventId(`${type}:${a.fingerprint}:${a.startedAt}:${a.status === 'firing' ? a.severity : 'resolved'}`) },
    );
  }

  // Maintenance windows ---------------------------------------------------------------------------------------------

  async windows() {
    const since = new Date(this.now().getTime() - 7 * 86_400_000);
    return (await this.deps.repo.list(this.deps.repo.pool(), since, 200)).map((w) => this.windowView(w));
  }

  async createWindow(caller: Caller, input: { hosts: string[]; starts_at: string; ends_at: string; reason: string }) {
    const starts = new Date(input.starts_at);
    const ends = new Date(input.ends_at);
    if (!(ends > starts)) throw validationFailed([{ field: 'ends_at', reason: 'not_after_start' }], 'A window ends after it starts.');
    if (ends.getTime() - starts.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw validationFailed([{ field: 'ends_at', reason: 'too_long' }], `A window lasts at most ${MAX_WINDOW_DAYS} days.`);
    if (ends <= this.now()) throw validationFailed([{ field: 'ends_at', reason: 'in_the_past' }], 'A window must end in the future.');
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await repo.insert(this.ctx(caller), { hosts: [...new Set(input.hosts)], starts_at: starts, ends_at: ends, reason: input.reason, created_by: caller.user.id }, client);
      return this.windowView((await repo.findById(client, String(row.id)))!);
    });
  }

  async cancelWindow(caller: Caller, publicId: string) {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const w = await repo.find(client, publicId, true);
      if (!w) throw new AppError(404, 'NOT_FOUND', 'Maintenance window not found.');
      if (!w.cancelledAt) await repo.update(this.ctx(caller), w.id, { cancelled_at: this.now(), cancelled_by: caller.user.id }, client);
      return this.windowView((await repo.findById(client, w.id))!);
    });
  }

  /** The job: each window's start and end written to the audit log when they happen (an end also when it is cancelled). */
  async recordWindowEdges(run: { now: Date; correlationId: string }): Promise<{ started: number; ended: number }> {
    const { repo } = this.deps;
    let started = 0;
    let ended = 0;
    for (const w of await repo.unrecorded(repo.pool(), run.now)) {
      await repo.inTransaction(async (client: PoolClient) => {
        const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
        const edge = !w.startRecordedAt ? 'started' : 'ended';
        await recordAuditEntry(client, {
          action: `system.maintenance_window_${edge}`,
          userId: null,
          entityType: 'system.maintenance_windows',
          entityId: w.id,
          correlationId: run.correlationId,
          details: { window_id: w.publicId, hosts: w.hosts, starts_at: w.startsAt.toISOString(), ends_at: w.endsAt.toISOString(), cancelled: w.cancelledAt !== null, suppressed: w.suppressedCount },
        });
        await repo.update(ctx, w.id, edge === 'started' ? { start_recorded_at: run.now } : { end_recorded_at: run.now }, client);
        if (edge === 'started') started += 1;
        else ended += 1;
      });
    }
    return { started, ended };
  }

  // The capacity report ---------------------------------------------------------------------------------------------

  /**
   * The capacity report (FMS-163): each host's disk, memory and CPU now, its growth over the last 30 days, the days until
   * each disk is full, and anything expected past 80% within 90 days; the month's requests, GPS points and database
   * size. A least-squares line through the 30 days' daily points (domain/monitoring.ts, daysUntil).
   */
  async capacity() {
    const prom = this.deps.prometheus;
    if (!prom) throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'The metrics store is not set up (PROMETHEUS_URL).');
    const now = Math.floor(this.now().getTime() / 1000);
    const start = now - 30 * 86_400;
    const day = 86_400;
    try {
      const [disk, memory, cpu, requests, gps, dbSize] = await Promise.all([
        prom.range(Q.hostDisk, start, now, day),
        prom.range(Q.hostMemory, start, now, day),
        prom.range(Q.hostCpu, start, now, day),
        prom.range('sum(increase(http_request_duration_seconds_count{service="fms-backend"}[1d]))', start, now, day),
        prom.range('sum(increase(gps_points_stored_total[1d]))', start, now, day),
        prom.range(Q.dbSizeBytes, start, now, day),
      ]);
      const resources = [
        ...disk.map((s) => ({ host: s.labels.host ?? '?', resource: 'disk', s })),
        ...memory.map((s) => ({ host: s.labels.host ?? '?', resource: 'memory', s })),
        ...cpu.map((s) => ({ host: s.labels.host ?? '?', resource: 'cpu', s })),
      ].map(({ host, resource, s }) => {
        const current = s.values.at(-1)?.[1] ?? null;
        const first = s.values[0]?.[1] ?? null;
        const to80 = daysUntil(s.values, 80, now);
        return {
          host,
          resource,
          current_pct: round(current),
          growth_pct_30d: current !== null && first !== null ? round(current - first) : null,
          days_to_full: resource === 'disk' ? round(daysUntil(s.values, 100, now)) : null,
          days_to_80_pct: round(to80),
          past_80_within_90_days: to80 !== null && to80 <= 90,
        };
      });
      const total = (s: Series[]) => s[0]?.values.reduce((sum, [, v]) => sum + v, 0) ?? null;
      const lastOf = (s: Series[]) => s[0]?.values.at(-1)?.[1] ?? null;
      const firstOf = (s: Series[]) => s[0]?.values[0]?.[1] ?? null;
      return {
        generated_at: new Date(now * 1000).toISOString(),
        period: { from: new Date(start * 1000).toISOString(), to: new Date(now * 1000).toISOString() },
        resources,
        growth: {
          requests_30d: round(total(requests), 0),
          gps_points_30d: round(total(gps), 0),
          database_bytes: round(lastOf(dbSize), 0),
          database_growth_bytes_30d: lastOf(dbSize) !== null && firstOf(dbSize) !== null ? round(lastOf(dbSize)! - firstOf(dbSize)!, 0) : null,
        },
      };
    } catch (err) {
      if (err instanceof PrometheusUnavailable) throw new AppError(503, 'UPSTREAM_UNAVAILABLE', err.message);
      throw err;
    }
  }

  async capacityPdf(): Promise<Buffer> {
    const r = await this.capacity();
    const n = (v: number | null, unit = '') => (v === null ? '-' : `${v.toLocaleString('en-US')}${unit}`);
    return this.deps.pdf({
      title: 'Capacity report',
      subtitle: `The last 30 days, to ${r.period.to.slice(0, 10)}. Requests ${n(r.growth.requests_30d)}; GPS points ${n(r.growth.gps_points_30d)}; database ${n(r.growth.database_bytes === null ? null : Math.round(r.growth.database_bytes / 1e6), ' MB')} (${n(r.growth.database_growth_bytes_30d === null ? null : Math.round(r.growth.database_growth_bytes_30d / 1e6), ' MB')} in 30 days).`,
      columns: [
        { label: 'Host', align: 'left' },
        { label: 'Resource', align: 'left' },
        { label: 'Now %', align: 'right' },
        { label: 'Growth 30 d', align: 'right' },
        { label: 'Days to full', align: 'right' },
        { label: 'Days to 80%', align: 'right' },
        { label: 'Past 80% in 90 days', align: 'left' },
      ],
      rows: r.resources.map((x) => [x.host, x.resource, n(x.current_pct), n(x.growth_pct_30d), n(x.days_to_full), n(x.days_to_80_pct), x.past_80_within_90_days ? 'Yes' : 'No']),
      totals: null,
      footer: `FMS capacity report, ${r.generated_at.slice(0, 16).replace('T', ' ')} UTC`,
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  private ctx(caller: Caller): MutationContext {
    return { userId: caller.user.id, correlationId: caller.correlationId };
  }

  private thresholdView(t: Thresholds) {
    const pair = ([warning, critical]: [number, number]) => ({ warning, critical });
    return {
      cpu_pct: pair(t.cpu),
      memory_pct: pair(t.memory),
      disk_pct: pair(t.disk),
      db_connections_pct: pair(t.dbConnections),
      replica_lag_seconds: pair(t.replicaLag),
      error_pct: pair(t.errorRate),
      p95_ms: pair(t.p95),
      gps_silence_minutes: t.gpsSilenceMinutes,
    };
  }

  private windowView(w: WindowRow) {
    const now = this.now();
    return {
      id: w.publicId,
      hosts: w.hosts,
      starts_at: w.startsAt.toISOString(),
      ends_at: w.endsAt.toISOString(),
      reason: w.reason,
      cancelled_at: w.cancelledAt?.toISOString() ?? null,
      in_force: !w.cancelledAt && w.startsAt <= now && w.endsAt > now,
      suppressed: w.suppressedCount,
      version: w.version,
    };
  }
}
