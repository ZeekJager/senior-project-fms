import { scrapedGauge, scrapedLabelledGauge } from './registry';

/** What the gauges read when Prometheus scrapes. Set by the composition root; a reader that is not set leaves its gauge without a value. */
export interface MetricReaders {
  /** The event outbox's lag (FMS-73). */
  outbox?: () => Promise<{ undispatched: number; unpublished: number; oldest_pending_seconds: number; dead_lettered: number }>;
  /** The read replica (FMS-94): `lag_seconds` is -1 while there is none, `in_use` 1 while reporting reads go to it. */
  replica?: () => Promise<Record<string, number>>;
  /** Each active provider's circuit on this instance (FMS-85). */
  circuits?: () => Promise<{ code: string; state: string }[]>;
  /** Open Socket.IO connections on this instance (FMS-43). */
  sockets?: () => number;
  /** The monitoring thresholds (FMS-163), by setting key: Prometheus' alert rules compare against them. */
  thresholds?: () => Promise<Record<string, number>>;
  /** Backup findings by severity (FMS-108): a critical one (a failed or overdue backup) is an alert. */
  backups?: () => Promise<Record<string, number>>;
  /** Trips under way now: no GPS point stored while there are some is an alert (FMS-163). */
  tripsUnderWay?: () => Promise<number>;
  /** The GPS months (FMS-110): until when they reach, and the pings outside every month. */
  gpsPartitions?: () => Promise<{ coveredUntil: Date | null; partitions: number; defaultRows: number }>;
}

let readers: MetricReaders = {};

/** Gives the gauges their sources. Called by the composition root (createApp, server.ts); a later call replaces the readers it names. */
export function setMetricReaders(next: MetricReaders): void {
  readers = { ...readers, ...next };
}

/** A read shared by everything that asks within `ttlMs`: one scrape reads each source once, however many gauges use it. */
function shortLived<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (value === null || now - at > ttlMs) {
      at = now;
      value = read();
      value.catch(() => {
        value = null;
      });
    }
    return value;
  };
}

/**
 * Every source, read one after the other (they share the database): prom-client collects the gauges at the same time, and
 * a gauge each would be a query each, concurrently. A source that fails leaves its gauges without a value, not the scrape failed.
 */
const snapshot = shortLived(async () => {
  const attempt = async <T>(read: (() => Promise<T>) | undefined): Promise<T | null> => {
    try {
      return read ? await read() : null;
    } catch {
      return null;
    }
  };
  const outbox = await attempt(readers.outbox);
  const replica = await attempt(readers.replica);
  const circuits = (await attempt(readers.circuits)) ?? [];
  const thresholds = await attempt(readers.thresholds);
  const backups = await attempt(readers.backups);
  const tripsUnderWay = await attempt(readers.tripsUnderWay);
  const gpsPartitions = await attempt(readers.gpsPartitions);
  return { outbox, replica, circuits, thresholds, backups, tripsUnderWay, gpsPartitions };
}, 1000);

const fromOutbox = (key: 'undispatched' | 'unpublished' | 'oldest_pending_seconds' | 'dead_lettered') => async () => (await snapshot()).outbox?.[key] ?? null;

scrapedGauge('outbox_undispatched_events', 'Events published but not yet handled by every consumer', fromOutbox('undispatched'));
scrapedGauge('outbox_unpublished_events', 'Events written but not yet published', fromOutbox('unpublished'));
scrapedGauge('outbox_oldest_pending_seconds', 'Age of the oldest event still waiting to be delivered (the outbox lag)', fromOutbox('oldest_pending_seconds'));
scrapedGauge('outbox_dead_lettered_events', 'Events a consumer gave up on after every attempt', fromOutbox('dead_lettered'));

// -1: there is no replica to measure (none configured, or it is down), as in /health/ready's metrics.
scrapedGauge('replica_lag_seconds', 'How far the read replica is behind the primary; -1 while there is no replica to measure', async () => (await snapshot()).replica?.lag_seconds ?? -1);
scrapedGauge('replica_in_use', '1 while reporting reads go to the read replica, 0 while they use the primary', async () => (await snapshot()).replica?.in_use ?? 0);
scrapedGauge('replica_fallbacks', 'Times a reporting read used the primary because the replica was down or too far behind', async () => (await snapshot()).replica?.fallbacks ?? 0);

/** closed 0, half open 1, open 2: a graph of the state rises as a provider gets worse. */
const CIRCUIT_VALUE: Record<string, number> = { closed: 0, half_open: 1, open: 2 };
scrapedLabelledGauge('circuit_breaker_state', 'A provider circuit breaker on this instance: 0 closed, 1 half open, 2 open', 'provider', async () =>
  Object.fromEntries((await snapshot()).circuits.map((c) => [c.code, CIRCUIT_VALUE[c.state] ?? 0])),
);

scrapedGauge('socket_connections', 'Open Socket.IO connections on this instance', () => readers.sockets?.() ?? 0);

// The monitoring thresholds (FMS-163, docs/observability.md) as the settings say now: a rule such as
// `cpu > scalar(max(fms_alert_threshold{setting="monitor_cpu_critical_pct"}))` follows a change at the next scrape.
// With the backup findings and the trips under way, read in the same snapshot as the rest, one after the other.
scrapedLabelledGauge('fms_alert_threshold', 'A monitoring threshold from the settings, by setting key', 'setting', async () => (await snapshot()).thresholds ?? {});
scrapedLabelledGauge('backup_findings', 'Backup and point-in-time recovery findings by severity (FMS-108)', 'severity', async () => (await snapshot()).backups ?? {});
scrapedGauge('trips_under_way', 'Trips under way now (en route)', async () => (await snapshot()).tripsUnderWay ?? null);
// FMS-110: days of months still ahead (0 when there are none, so the alert fires rather than going quiet), and pings outside them.
scrapedGauge('gps_partition_days_ahead', 'Days from now to the end of the last monthly GPS partition', async () => {
  const status = (await snapshot()).gpsPartitions;
  if (!status) return null;
  return status.coveredUntil ? Math.max(0, (status.coveredUntil.getTime() - Date.now()) / 86_400_000) : 0;
});
scrapedGauge('gps_default_partition_rows', 'GPS pings in the default partition, outside every month (counted up to a million)', async () => (await snapshot()).gpsPartitions?.defaultRows ?? null);
