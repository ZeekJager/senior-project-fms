import type { PoolClient } from 'pg';
import { config } from '../../config';
import { pool } from '../../db';
import { redis } from '../cache';
import { logger } from '../logging/logger';
import { RedisEventBroadcaster } from './broadcaster';
import type { DomainEvent } from './domain-event';
import { appendToOutbox } from './outbox';
import { OutboxRelay, type OutboxRelayOptions } from './outbox-relay';
import { SubscriberRegistry, type EventHandler } from './subscribers';

export type { EventHandler } from './subscribers';

/**
 * How modules publish and react to domain events (CONVENTIONS.md, Events).
 *
 * `publish` writes the events into the outbox on the caller's transaction,
 * the one that makes the change: a rolled-back change publishes nothing, a
 * committed one cannot lose its events. Publish at the end of that
 * transaction, after the aggregate's row is written (and so locked): the
 * outbox order is then the order of the changes. Delivery comes after
 * commit, from the relay, at least once.
 */
export interface EventBus {
  publish(tx: PoolClient, events: readonly DomainEvent[]): Promise<void>;
  /**
   * `consumer` names the reaction, `<module>.<purpose>`, unique per event
   * type and stable across releases: a redelivered event is skipped by name.
   * Returns a function that removes the subscription.
   */
  subscribe(type: string, consumer: string, handler: EventHandler): () => void;
}

export class OutboxEventBus implements EventBus {
  constructor(readonly subscribers: SubscriberRegistry = new SubscriberRegistry()) {}

  publish(tx: PoolClient, events: readonly DomainEvent[]): Promise<void> {
    return appendToOutbox(tx, events);
  }

  subscribe(type: string, consumer: string, handler: EventHandler): () => void {
    return this.subscribers.subscribe(type, consumer, handler);
  }
}

/** The application's event bus. */
export const eventBus = new OutboxEventBus();

/** `<prefix>:events:<EventType>`: the Redis channel an event type is published on (CONVENTIONS.md, Redis). */
export function eventChannel(type: string): string {
  return [config.redis?.keyPrefix ?? 'fms', 'events', type].join(':');
}

/**
 * The relay for this process: the app's pool, consumers and Redis. Started
 * by src/server.ts (every instance; one relays at a time). Tests run passes
 * themselves with `runOnce()`.
 */
export function createOutboxRelay(options: Partial<OutboxRelayOptions> = {}): OutboxRelay {
  return new OutboxRelay({
    db: pool,
    subscribers: eventBus.subscribers,
    broadcaster: redis ? new RedisEventBroadcaster(redis, eventChannel) : null,
    log: (level, message, fields) => logger[level](fields, message),
    ...options,
  });
}
