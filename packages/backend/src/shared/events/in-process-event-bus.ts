import type { DomainEvent } from './domain-event';

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

/**
 * Publishes domain events to the modules that react to them. Callers publish
 * only after their transaction has committed, so a rolled-back change
 * publishes nothing (CONVENTIONS.md, Events).
 */
export interface EventBus {
  publish(events: readonly DomainEvent[]): Promise<void>;
  /** Returns a function that removes the handler. */
  subscribe(type: string, handler: EventHandler): () => void;
}

/**
 * Delivers events to handlers in this process, in order, one handler at a
 * time. Until FMS-73 this is the bus, and it is at most once: an event is lost
 * if the process dies between the commit and the publish. FMS-73 replaces it
 * with a transactional outbox and Redis pub/sub behind the same interface.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  /** `onHandlerError` sees a handler's failure; the publish itself never fails. */
  constructor(private readonly onHandlerError: (err: unknown, event: DomainEvent) => void) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of [...(this.handlers.get(event.type) ?? [])]) {
        try {
          await handler(event);
        } catch (err) {
          // The change is already committed: a failing consumer must not turn
          // the request into an error, nor stop the other consumers.
          this.onHandlerError(err, event);
        }
      }
    }
  }

  subscribe(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
}
