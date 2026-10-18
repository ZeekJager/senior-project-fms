/**
 * Domain events in integration tests (FMS-73). A service writes its events
 * into events.outbox inside the test's transaction, so:
 *
 *   await api.post('/vehicles', ...);
 *   expect((await publishedEvents('VehicleRegistered')).map((e) => e.payload)) ...
 *
 * Consumers run only when the relay delivers; a test of a reaction (the
 * driver-account copy, the expiry check on upload) delivers first:
 *
 *   await deliverEvents();
 */
import { pool } from '../../src/db';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { createOutboxRelay } from '../../src/shared/events/event-bus';
import type { OutboxRelayOptions } from '../../src/shared/events/outbox-relay';

/** What this test published, oldest first; only the given types if any. */
export async function publishedEvents(...types: string[]): Promise<DomainEvent[]> {
  const res = await pool.query<{
    event_id: string;
    event_type: string;
    event_version: number;
    occurred_at: Date;
    actor_id: string | null;
    correlation_id: string;
    payload: Record<string, unknown>;
    aggregate_key: string | null;
  }>(
    `SELECT event_id, event_type, event_version, occurred_at, actor_id, correlation_id, payload, aggregate_key
       FROM events.outbox WHERE cardinality($1::text[]) = 0 OR event_type = ANY($1) ORDER BY id`,
    [types],
  );
  return res.rows.map((r) => ({
    id: r.event_id,
    type: r.event_type,
    version: r.event_version,
    occurred_at: r.occurred_at.toISOString(),
    actor: r.actor_id,
    correlation_id: r.correlation_id,
    payload: r.payload,
    aggregate: r.aggregate_key,
  }));
}

/**
 * Runs relay passes on the test's connection until one does nothing, so
 * events that consumers publish in turn are delivered too. A consumer that
 * fails is left for its retry, which a test sees as an undispatched row.
 */
export async function deliverEvents(options: Partial<OutboxRelayOptions> = {}): Promise<void> {
  const relay = createOutboxRelay({ log: () => {}, ...options });
  for (let pass = 0; pass < 20; pass++) {
    const done = await relay.runOnce();
    if (!done || done.published + done.dispatched + done.deadLettered === 0) return;
  }
  throw new Error('deliverEvents: still delivering after 20 passes; does a consumer publish in a loop?');
}
