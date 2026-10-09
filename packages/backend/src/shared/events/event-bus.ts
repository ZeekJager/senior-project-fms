import { logger } from '../logging/logger';
import { InProcessEventBus, type EventBus } from './in-process-event-bus';

export type { EventBus, EventHandler } from './in-process-event-bus';

/** The application's event bus. A failing handler is logged for its owner. */
export const eventBus: EventBus = new InProcessEventBus((err, event) => {
  logger.error({ err, eventId: event.id, eventType: event.type }, 'event handler failed');
});
