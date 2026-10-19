import type { PoolClient } from 'pg';
import type { DomainEvent } from './domain-event';
import { CONSUMER_RE, type EventHandler } from './subscribers';

interface Projection {
  name: string;
  handler: EventHandler;
}

/**
 * Read models kept inside the publishing transaction (EventBus.project).
 * Unlike a consumer, a projection has no processed_events row and no
 * redelivery: it runs once, with the change, and commits or rolls back with it.
 */
export class ProjectionRegistry {
  private readonly byType = new Map<string, Projection[]>();

  /** Returns a function that removes the projection. */
  register(type: string, name: string, handler: EventHandler): () => void {
    if (!CONSUMER_RE.test(name)) throw new Error(`Projection name must be <module>.<purpose> in lower case, got '${name}'`);
    const list = this.byType.get(type) ?? [];
    if (list.some((p) => p.name === name)) throw new Error(`'${name}' already projects ${type}`);
    const projection = { name, handler };
    this.byType.set(type, [...list, projection]);
    return () => {
      this.byType.set(
        type,
        (this.byType.get(type) ?? []).filter((p) => p !== projection),
      );
    };
  }

  namesOf(type: string): string[] {
    return (this.byType.get(type) ?? []).map((p) => p.name);
  }

  /** Each event, in order, to each projection of its type, in registration order, on `tx`. A failure propagates: the change fails with it. */
  async apply(tx: PoolClient, events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const { handler } of [...(this.byType.get(event.type) ?? [])]) await handler(event, tx);
    }
  }
}
