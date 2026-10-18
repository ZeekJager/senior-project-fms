import type { PoolClient } from 'pg';
import type { DomainEvent } from './domain-event';
import type { EventBus } from './event-bus';

/**
 * For unit tests of a service over fakes: records what it publishes, in
 * order, and whether it published inside its transaction (`tx` is the
 * client the fake transaction handed out). Subscriptions are accepted and
 * never called; consumers are tested through the relay.
 */
export class RecordingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  readonly clients: PoolClient[] = [];

  async publish(tx: PoolClient, events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.published.push(event);
      this.clients.push(tx);
    }
  }

  subscribe(): () => void {
    return () => {};
  }
}
