import type Redis from 'ioredis';
import { isReady } from '../cache/redis';
import { envelopeOf, type DomainEvent } from './domain-event';

/** Puts committed events where the real-time layer listens (Redis pub/sub, §19). */
export interface EventBroadcaster {
  /** Rejects when the event could not be handed over; the relay tries again later, in order. */
  publish(event: DomainEvent): Promise<void>;
}

/**
 * One channel per event type, `<prefix>:events:<EventType>` (channelFor):
 * the real-time gateway subscribes to the types it forwards, or to
 * `<prefix>:events:*`. The message is the JSON envelope without the
 * outbox's ordering key. Pub/sub keeps nothing: a gateway that was not
 * connected when an event went out never gets it, so a client that
 * reconnects reloads its state over the API.
 */
export class RedisEventBroadcaster implements EventBroadcaster {
  constructor(
    private readonly client: Redis,
    private readonly channelFor: (type: string) => string,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (!isReady(this.client)) throw new Error('redis is not connected');
    await this.client.publish(this.channelFor(event.type), JSON.stringify(envelopeOf(event)));
  }
}
