import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '../infrastructure/queryable';
import type { EventBroadcaster } from './broadcaster';
import { outboxStore, type OutboxRow } from './outbox';
import type { SubscriberRegistry } from './subscribers';

export type RelayLog = (level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>) => void;

export interface OutboxRelayOptions {
  db: Pool;
  subscribers: SubscriberRegistry;
  /** Redis pub/sub; null when Redis is not configured (events are then only dispatched). */
  broadcaster: EventBroadcaster | null;
  /** Rows per pass and phase. Default 100. */
  batchSize?: number;
  /**
   * Aggregates dispatched at once (FMS-152): one aggregate's events stay in order, different ones run side by side, each
   * consumer transaction on a connection of `db`. Default 1, one at a time, as on the single connection of a test.
   */
  dispatchConcurrency?: number;
  /** How often an idle relay looks for new rows. Default 200 ms, so a committed event is on Redis well within a second. */
  pollIntervalMs?: number;
  /** Dispatch attempts before an event is dead-lettered. Default 10 (about 8.5 minutes of retries). */
  maxAttempts?: number;
  /** Seconds before retry number `attempt` + 1. Default 1, 2, 4 ... up to 5 minutes. */
  retryDelaySeconds?: (attempt: number) => number;
  /** How often the lag is logged while something is pending. Default 60 s. */
  lagReportIntervalMs?: number;
  log?: RelayLog;
}

export interface RelayPass {
  published: number;
  dispatched: number;
  /** Failed and scheduled for a retry. */
  retrying: number;
  deadLettered: number;
  /** A phase filled its batch: there may be more right away. */
  more: boolean;
}

/**
 * One relay at a time across instances: a session-level advisory lock, held
 * for a pass on one connection. It goes when the connection does, so a
 * crashed instance never keeps it.
 */
export const RELAY_LOCK_KEY = 73_0073;

/**
 * Broadcasting has a lock of its own (FMS-152): it runs in a loop of its own, so a position reaches the live map without
 * waiting for the in-process consumers of the events before it.
 */
export const BROADCAST_LOCK_KEY = 73_0074;

const defaultRetryDelay = (attempt: number) => Math.min(2 ** (attempt - 1), 300);

/**
 * Delivers what modules write to events.outbox (FMS-73), at least once:
 *
 * 1. Broadcast: unpublished rows, oldest first, onto Redis pub/sub. A
 *    failure stops the phase, so the next pass resumes at the same row and
 *    the order on Redis is the outbox order. A Redis outage never holds up
 *    the in-process consumers.
 * 2. Dispatch: due rows to the in-process consumers (SubscriberRegistry),
 *    one aggregate's events in order. A failure is retried with backoff and
 *    holds back the later events of its aggregate; after `maxAttempts` the
 *    row is dead-lettered and its aggregate moves on.
 *
 * Each row's progress is committed as soon as it is made, so a relay that
 * stops (deploy, crash) resumes at the first row it had not finished.
 * Consumers record what they have handled, so the row it was on when it
 * died is not handled twice.
 *
 * The loop (start) runs the two phases apart, each under its own lock, so the
 * live map never waits for consumers (FMS-152, NFR-3: 500 vehicles). A batch is
 * broadcast at once, then marked in one statement; dispatch runs
 * `dispatchConcurrency` aggregates side by side. runOnce runs both, in turn.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly lagReportIntervalMs: number;
  private readonly log: RelayLog;

  private loops: Promise<void>[] = [];
  private readonly dispatchConcurrency: number;
  private stopping = false;
  private readonly wakers = new Set<() => void>();
  private lastLagReport = 0;
  private broadcastDown = false;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.dispatchConcurrency = Math.max(1, options.dispatchConcurrency ?? 1);
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.retryDelay = options.retryDelaySeconds ?? defaultRetryDelay;
    this.lagReportIntervalMs = options.lagReportIntervalMs ?? 60_000;
    this.log = options.log ?? (() => {});
  }

  /**
   * One pass of both phases. Null when another instance's relay holds the
   * lock. Used by the loop, and by tests to deliver what they published.
   */
  async runOnce(): Promise<RelayPass | null> {
    return this.locked(this.options.broadcaster ? [RELAY_LOCK_KEY, BROADCAST_LOCK_KEY] : [RELAY_LOCK_KEY], async (client) => {
      const pass = emptyPass();
      await this.broadcastPhase(client, pass);
      await this.dispatchPhase(client, pass);
      return pass;
    });
  }

  /**
   * Runs passes until stop(): straight on while there is a backlog, every pollIntervalMs when idle. Broadcasting and
   * dispatching are two loops, each under its own lock (one instance at a time for each).
   */
  start(): void {
    if (this.loops.length > 0) return;
    this.stopping = false;
    const { broadcaster, db } = this.options;
    this.loops = [
      this.run('dispatch', () => outboxStore.hasDispatchable(db), () => this.locked([RELAY_LOCK_KEY], (client) => this.dispatchPhase(client, emptyPass())), true),
      ...(broadcaster ? [this.run('broadcast', () => outboxStore.hasUnpublished(db), () => this.locked([BROADCAST_LOCK_KEY], (client) => this.broadcastPhase(client, emptyPass())), false)] : []),
    ];
  }

  /** Lets the current passes finish, then stops. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of [...this.wakers]) wake();
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** `fn` on one connection while it holds every lock of `keys`; null when another instance holds one. */
  private async locked<T>(keys: readonly number[], fn: (client: PoolClient) => Promise<T>): Promise<T | null> {
    const client = await this.options.db.connect();
    let keepsLock = false;
    const held: number[] = [];
    try {
      for (const key of keys) {
        const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
        if (!rows[0].locked) return null;
        held.push(key);
      }
      return await fn(client);
    } finally {
      for (const key of held.reverse()) {
        await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {
          keepsLock = true;
        });
      }
      // A connection that may still hold a lock is closed, not pooled.
      client.release(keepsLock || undefined);
    }
  }

  private async run(name: string, hasWork: () => Promise<boolean>, once: () => Promise<RelayPass | null>, reportsLag: boolean): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let more = false;
      try {
        if (await hasWork()) more = (await once())?.more ?? false;
        if (reportsLag) await this.reportLag();
        failures = 0;
      } catch (err) {
        // The database is unreachable: back off, up to 5 s, and keep trying.
        failures++;
        if (failures === 1) this.log('error', `outbox relay ${name} pass failed`, { err: describe(err) });
      }
      if (!more && !this.stopping) await this.sleep(failures ? Math.min(this.pollIntervalMs * 2 ** failures, 5000) : this.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    let wake: () => void = () => {};
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakers.add(wake);
    }).finally(() => {
      this.wakers.delete(wake);
    });
  }

  /**
   * 1. Broadcast: the next unpublished rows onto Redis, oldest first. The batch is handed over at once (one connection
   * keeps its order) and the rows published before the first failure are marked in one statement; the next pass starts
   * again at the first that failed. A row after it may have gone out too, and goes out again: at least once.
   */
  private async broadcastPhase(client: PoolClient, pass: RelayPass): Promise<RelayPass> {
    const { broadcaster } = this.options;
    if (!broadcaster) return pass;
    const rows = await outboxStore.unpublished(client, this.batchSize);
    if (rows.length === 0) return pass;
    const outcomes = await Promise.allSettled(rows.map((row) => broadcaster.publish(row.event)));
    const failedAt = outcomes.findIndex((o) => o.status === 'rejected');
    const sent = failedAt === -1 ? rows : rows.slice(0, failedAt);
    await outboxStore.markPublished(client, sent.map((r) => r.seq));
    pass.published += sent.length;
    if (failedAt !== -1) {
      // One line per outage; the next pass starts again at this row.
      const reason = (outcomes[failedAt] as PromiseRejectedResult).reason;
      if (!this.broadcastDown) this.log('warn', 'outbox relay cannot publish to redis; events wait in the outbox', { eventId: rows[failedAt].event.id, err: describe(reason) });
      this.broadcastDown = true;
    } else {
      if (this.broadcastDown) this.log('info', 'outbox relay publishing to redis again', {});
      this.broadcastDown = false;
    }
    pass.more ||= rows.length === this.batchSize && failedAt === -1;
    return pass;
  }

  /**
   * 2. Dispatch: due rows to the in-process consumers, one aggregate's in order; a failure holds back the rest of its
   * aggregate. With `dispatchConcurrency` above 1, aggregates run side by side and their progress is written on
   * connections of the pool.
   */
  private async dispatchPhase(client: PoolClient, pass: RelayPass): Promise<RelayPass> {
    const { broadcaster, subscribers, db } = this.options;
    const rows = await outboxStore.dispatchable(client, this.batchSize);
    const nothingToBroadcast: string[] = [];
    const parallel = this.dispatchConcurrency > 1;
    const progress: Queryable = parallel ? db : client;
    /** One aggregate's rows, in order: false when one waits for a retry, which holds back the rest. */
    const deliver = async (row: OutboxRow): Promise<boolean> => {
      try {
        await subscribers.dispatch(db, row.event);
        await outboxStore.markDispatched(progress, row.seq);
        if (!broadcaster) nothingToBroadcast.push(row.seq);
        pass.dispatched++;
        return true;
      } catch (err) {
        if (await this.failed(progress, row, err)) {
          pass.deadLettered++;
          return true;
        }
        pass.retrying++;
        return false;
      }
    };
    if (!parallel) {
      const held = new Set<string>();
      for (const row of rows) {
        const aggregate = row.event.aggregate;
        if (aggregate && held.has(aggregate)) continue;
        if (!(await deliver(row)) && aggregate) held.add(aggregate);
      }
    } else {
      // Events without an aggregate are independent: each is a group of its own.
      const groups = new Map<string, OutboxRow[]>();
      for (const row of rows) {
        const key = row.event.aggregate ?? `seq:${row.seq}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const queue = [...groups.values()];
      const worker = async () => {
        for (let group = queue.shift(); group; group = queue.shift()) {
          for (const row of group) if (!(await deliver(row))) break;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.dispatchConcurrency, queue.length) }, worker));
    }
    await outboxStore.markPublished(client, nothingToBroadcast);
    pass.more ||= rows.length === this.batchSize;
    return pass;
  }

  /** Records a failed dispatch; true when it was the last attempt. */
  private async failed(client: Queryable, row: OutboxRow, err: unknown): Promise<boolean> {
    const attempt = row.attempts + 1;
    const fields = { eventId: row.event.id, eventType: row.event.type, attempt, err: describe(err) };
    const dead = await outboxStore.markFailed(client, row.seq, describe(err), this.retryDelay(attempt), this.maxAttempts);
    if (dead) this.log('error', 'event dead-lettered: a consumer failed it on every attempt', fields);
    else this.log('warn', 'event consumer failed; will retry', { ...fields, retryInSeconds: this.retryDelay(attempt) });
    return dead;
  }

  private async reportLag(): Promise<void> {
    if (Date.now() - this.lastLagReport < this.lagReportIntervalMs) return;
    this.lastLagReport = Date.now();
    const lag = await outboxStore.lag(this.options.db);
    if (lag.dead_lettered > 0 || lag.oldest_pending_seconds >= 60) this.log('warn', 'outbox lag', { ...lag });
    else if (lag.undispatched > 0 || lag.unpublished > 0) this.log('info', 'outbox lag', { ...lag });
  }
}

const emptyPass = (): RelayPass => ({ published: 0, dispatched: 0, retrying: 0, deadLettered: 0, more: false });

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
