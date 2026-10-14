import type { Queryable } from '../infrastructure/queryable';
import type { DomainEvent } from './domain-event';

/** A row of events.outbox the relay still has work on. */
export interface OutboxRow {
  /** The row's position: delivery follows it. */
  seq: string;
  event: DomainEvent;
  attempts: number;
}

interface Row {
  seq: string;
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: Date;
  actor_id: string | null;
  correlation_id: string;
  payload: Record<string, unknown>;
  aggregate_key: string | null;
  attempts: number;
}

const COLUMNS = `id::text AS seq, event_id, event_type, event_version, occurred_at, actor_id, correlation_id, payload, aggregate_key, attempts`;

function toOutboxRow(r: Row): OutboxRow {
  return {
    seq: r.seq,
    attempts: r.attempts,
    event: {
      id: r.event_id,
      type: r.event_type,
      version: r.event_version,
      occurred_at: r.occurred_at.toISOString(),
      actor: r.actor_id,
      correlation_id: r.correlation_id,
      payload: r.payload,
      aggregate: r.aggregate_key,
    },
  };
}

/**
 * Writes events into events.outbox on the caller's transaction, so they
 * commit or roll back with the change. One statement for the lot; an event
 * id already there (a job's fixed id, published again) is skipped.
 */
export async function appendToOutbox(tx: Queryable, events: readonly DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.query(
    `INSERT INTO events.outbox (event_id, event_type, event_version, occurred_at, actor_id, correlation_id, payload, aggregate_key)
     SELECT event_id, event_type, event_version, occurred_at, actor_id, correlation_id, payload, aggregate_key
       FROM unnest($1::uuid[], $2::varchar[], $3::smallint[], $4::timestamptz[], $5::uuid[], $6::uuid[], $7::jsonb[], $8::varchar[])
            WITH ORDINALITY AS e(event_id, event_type, event_version, occurred_at, actor_id, correlation_id, payload, aggregate_key, n)
      ORDER BY n
     ON CONFLICT (event_id) DO NOTHING`,
    [
      events.map((e) => e.id),
      events.map((e) => e.type),
      events.map((e) => e.version),
      events.map((e) => e.occurred_at),
      events.map((e) => e.actor),
      events.map((e) => e.correlation_id),
      events.map((e) => JSON.stringify(e.payload)),
      events.map((e) => e.aggregate ?? null),
    ],
  );
}

/** Lag of the outbox, for /health/ready and the relay's log (FMS-73 metrics). */
export interface OutboxLag {
  /** Events not yet handled by every in-process consumer (dead letters excluded). */
  undispatched: number;
  /** Events not yet on Redis. */
  unpublished: number;
  /** Age of the oldest event still waiting for either, in seconds; 0 when none. */
  oldest_pending_seconds: number;
  /** Events a consumer gave up on after the last attempt: someone has to look. */
  dead_lettered: number;
}

/**
 * The relay's reads and writes on events.outbox and events.processed_events.
 * Platform code (src/shared/events): modules publish through the event bus.
 */
export const outboxStore = {
  /**
   * The next events to dispatch, oldest first: due, and not behind an older
   * event of the same aggregate that waits for a retry. An older event that
   * is due comes earlier in the same batch; the relay holds back the rest of
   * its aggregate if it fails. So one aggregate's events reach consumers in
   * order, and a failing one holds back only its own.
   */
  async dispatchable(db: Queryable, limit: number): Promise<OutboxRow[]> {
    const res = await db.query<Row>(
      `SELECT ${COLUMNS}
         FROM events.outbox o
        WHERE o.dispatched_at IS NULL AND o.dead_lettered_at IS NULL
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= clock_timestamp())
          AND (o.aggregate_key IS NULL OR NOT EXISTS (
                SELECT 1 FROM events.outbox p
                 WHERE p.aggregate_key = o.aggregate_key AND p.id < o.id
                   AND p.dispatched_at IS NULL AND p.dead_lettered_at IS NULL
                   AND p.next_attempt_at > clock_timestamp()))
        ORDER BY o.id
        LIMIT $1`,
      [limit],
    );
    return res.rows.map(toOutboxRow);
  },

  /** The next events to put on Redis, oldest first. */
  async unpublished(db: Queryable, limit: number): Promise<OutboxRow[]> {
    const res = await db.query<Row>(`SELECT ${COLUMNS} FROM events.outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`, [limit]);
    return res.rows.map(toOutboxRow);
  },

  async markDispatched(db: Queryable, seq: string): Promise<void> {
    await db.query(`UPDATE events.outbox SET dispatched_at = clock_timestamp(), last_error = NULL WHERE id = $1`, [seq]);
  },

  /** On Redis, or nothing to broadcast to (Redis is not configured). */
  async markPublished(db: Queryable, seqs: readonly string[]): Promise<void> {
    if (seqs.length === 0) return;
    await db.query(`UPDATE events.outbox SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])`, [seqs]);
  },

  /**
   * A failed dispatch: retried after `retryInSeconds`, or dead-lettered when
   * that was the last attempt. Returns whether it was dead-lettered.
   */
  async markFailed(db: Queryable, seq: string, error: string, retryInSeconds: number, maxAttempts: number): Promise<boolean> {
    const res = await db.query<{ dead: boolean }>(
      `UPDATE events.outbox
          SET attempts = attempts + 1,
              last_error = left($2, 2000),
              next_attempt_at = clock_timestamp() + make_interval(secs => $3),
              dead_lettered_at = CASE WHEN attempts + 1 >= $4 THEN clock_timestamp() END
        WHERE id = $1
        RETURNING dead_lettered_at IS NOT NULL AS dead`,
      [seq, error, retryInSeconds, maxAttempts],
    );
    return res.rows[0]?.dead ?? false;
  },

  /**
   * Records that `consumer` handled the event, in the consumer's transaction.
   * False when it already had: the event is a redelivery, skip it.
   */
  async claimForConsumer(tx: Queryable, consumer: string, eventId: string): Promise<boolean> {
    const res = await tx.query(`INSERT INTO events.processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [consumer, eventId]);
    return res.rowCount === 1;
  },

  /** Whether the relay has anything to do now: one cheap query for an idle poll. */
  async hasWork(db: Queryable): Promise<boolean> {
    const res = await db.query<{ work: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM events.outbox WHERE published_at IS NULL)
           OR EXISTS (SELECT 1 FROM events.outbox
                       WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL
                         AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())) AS work`,
    );
    return res.rows[0].work;
  },

  async lag(db: Queryable): Promise<OutboxLag> {
    // One subquery per partial index: each count stays an index scan.
    const res = await db.query<{ undispatched: number; unpublished: number; dead: number; oldest: number | null }>(
      `SELECT (SELECT count(*) FROM events.outbox WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL)::int AS undispatched,
              (SELECT count(*) FROM events.outbox WHERE published_at IS NULL)::int AS unpublished,
              (SELECT count(*) FROM events.outbox WHERE dead_lettered_at IS NOT NULL)::int AS dead,
              EXTRACT(EPOCH FROM clock_timestamp() - LEAST(
                (SELECT created_at FROM events.outbox WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL ORDER BY id LIMIT 1),
                (SELECT created_at FROM events.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1)))::float8 AS oldest`,
    );
    const r = res.rows[0];
    return { undispatched: r.undispatched, unpublished: r.unpublished, oldest_pending_seconds: Math.max(0, Math.round(r.oldest ?? 0)), dead_lettered: r.dead };
  },

  /**
   * Deletes events delivered both ways and written before `before`, then
   * consumers' records as old whose event is gone. Dead letters, and their
   * records, stay until someone has dealt with them: a requeued one skips
   * the consumers that handled it.
   */
  async purge(db: Queryable, before: Date): Promise<{ events: number; processed: number }> {
    const events = await db.query(
      `DELETE FROM events.outbox WHERE created_at < $1 AND dispatched_at IS NOT NULL AND published_at IS NOT NULL`,
      [before],
    );
    const processed = await db.query(
      `DELETE FROM events.processed_events p
        WHERE p.processed_at < $1 AND NOT EXISTS (SELECT 1 FROM events.outbox o WHERE o.event_id = p.event_id)`,
      [before],
    );
    return { events: events.rowCount ?? 0, processed: processed.rowCount ?? 0 };
  },
};
