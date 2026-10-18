import type { Pool, PoolClient } from 'pg';
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
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly lagReportIntervalMs: number;
  private readonly log: RelayLog;

  private loop: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private lastLagReport = 0;
  private broadcastDown = false;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
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
    const client = await this.options.db.connect();
    let keepsLock = false;
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RELAY_LOCK_KEY]);
      if (!rows[0].locked) return null;
      try {
        return await this.pass(client);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [RELAY_LOCK_KEY]).catch(() => {
          keepsLock = true;
        });
      }
    } finally {
      // A connection that may still hold the lock is closed, not pooled.
      client.release(keepsLock || undefined);
    }
  }

  /** Runs passes until stop(): straight on while there is a backlog, every pollIntervalMs when idle. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Lets the current pass finish, then stops. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let more = false;
      try {
        if (await outboxStore.hasWork(this.options.db)) more = (await this.runOnce())?.more ?? false;
        await this.reportLag();
        failures = 0;
      } catch (err) {
        // The database is unreachable: back off, up to 5 s, and keep trying.
        failures++;
        if (failures === 1) this.log('error', 'outbox relay pass failed', { err: describe(err) });
      }
      if (!more && !this.stopping) await this.sleep(failures ? Math.min(this.pollIntervalMs * 2 ** failures, 5000) : this.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wake = null;
    });
  }

  private async pass(client: PoolClient): Promise<RelayPass> {
    const pass: RelayPass = { published: 0, dispatched: 0, retrying: 0, deadLettered: 0, more: false };
    const { broadcaster, subscribers, db } = this.options;

    // 1. Broadcast first: the real-time layer does not wait for consumers.
    if (broadcaster) {
      const rows = await outboxStore.unpublished(client, this.batchSize);
      for (const row of rows) {
        try {
          await broadcaster.publish(row.event);
        } catch (err) {
          // One line per outage; the next pass starts again at this row.
          if (!this.broadcastDown) this.log('warn', 'outbox relay cannot publish to redis; events wait in the outbox', { eventId: row.event.id, err: describe(err) });
          this.broadcastDown = true;
          break;
        }
        if (this.broadcastDown) this.log('info', 'outbox relay publishing to redis again', {});
        this.broadcastDown = false;
        await outboxStore.markPublished(client, [row.seq]);
        pass.published++;
      }
      pass.more ||= rows.length === this.batchSize && pass.published === rows.length;
    }

    // 2. Dispatch to in-process consumers.
    const rows = await outboxStore.dispatchable(client, this.batchSize);
    const held = new Set<string>();
    const nothingToBroadcast: string[] = [];
    for (const row of rows) {
      const aggregate = row.event.aggregate;
      if (aggregate && held.has(aggregate)) continue;
      try {
        await subscribers.dispatch(db, row.event);
        await outboxStore.markDispatched(client, row.seq);
        if (!broadcaster) nothingToBroadcast.push(row.seq);
        pass.dispatched++;
      } catch (err) {
        if (await this.failed(client, row, err)) {
          pass.deadLettered++;
        } else {
          pass.retrying++;
          if (aggregate) held.add(aggregate);
        }
      }
    }
    await outboxStore.markPublished(client, nothingToBroadcast);
    pass.more ||= rows.length === this.batchSize;
    return pass;
  }

  /** Records a failed dispatch; true when it was the last attempt. */
  private async failed(client: PoolClient, row: OutboxRow, err: unknown): Promise<boolean> {
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
