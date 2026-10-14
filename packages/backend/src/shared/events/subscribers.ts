import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../infrastructure/transaction';
import type { DomainEvent } from './domain-event';
import { outboxStore } from './outbox';

/**
 * Reacts to an event. `tx` is the transaction that records the event as
 * handled by this consumer: database work done on it commits with that
 * record, so a redelivery finds the work done. Work done elsewhere (another
 * service's own transaction, a Redis call) may run again if the process dies
 * before the commit, so it must be safe to repeat.
 */
export type EventHandler = (event: DomainEvent, tx: PoolClient) => Promise<void> | void;

interface Subscription {
  consumer: string;
  handler: EventHandler;
}

const CONSUMER_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** One or more consumers failed an event; the others have recorded it as handled. */
export class DispatchError extends Error {
  constructor(readonly failures: { consumer: string; error: unknown }[]) {
    super(failures.map((f) => `${f.consumer}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join('; '));
    this.name = 'DispatchError';
  }
}

/**
 * Who reacts to which event type (FMS-73). Each subscription has a consumer
 * name, `<module>.<purpose>` (`fleet.vehicle-cache`), which events.processed_events
 * is keyed on, so the name must stay the same across releases: a renamed
 * consumer would see every retained event as new.
 */
export class SubscriberRegistry {
  private readonly byType = new Map<string, Subscription[]>();

  /** Returns a function that removes the subscription. */
  subscribe(type: string, consumer: string, handler: EventHandler): () => void {
    if (!CONSUMER_RE.test(consumer)) throw new Error(`Consumer name must be <module>.<purpose> in lower case, got '${consumer}'`);
    const list = this.byType.get(type) ?? [];
    if (list.some((s) => s.consumer === consumer)) throw new Error(`'${consumer}' already subscribes to ${type}`);
    const subscription = { consumer, handler };
    this.byType.set(type, [...list, subscription]);
    return () => {
      this.byType.set(
        type,
        (this.byType.get(type) ?? []).filter((s) => s !== subscription),
      );
    };
  }

  consumersOf(type: string): string[] {
    return (this.byType.get(type) ?? []).map((s) => s.consumer);
  }

  /**
   * Hands the event to each consumer of its type, one at a time, in
   * subscription order. Each runs in its own transaction with its
   * processed_events row: a consumer that has handled the event before is
   * skipped, a failing one rolls back (its record too, so it gets the event
   * again) without stopping the rest. Throws DispatchError if any failed.
   */
  async dispatch(db: Pool, event: DomainEvent): Promise<void> {
    const failures: { consumer: string; error: unknown }[] = [];
    for (const { consumer, handler } of [...(this.byType.get(event.type) ?? [])]) {
      try {
        await withTransaction(db, async (tx) => {
          if (await outboxStore.claimForConsumer(tx, consumer, event.id)) await handler(event, tx);
        });
      } catch (error) {
        failures.push({ consumer, error });
      }
    }
    if (failures.length > 0) throw new DispatchError(failures);
  }
}
