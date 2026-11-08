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
  return { outbox, replica, circuits };
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
