import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { evRefs } from '../fleet';
import { EV_SESSION_KINDS, INTEGRATION_EVENTS, webhookDeliveries, type EvProviderSession, type EvSessionKind } from '../integration';
import { evRouter } from './api/ev.routes';
import { EvService } from './application/ev.service';
import { EvRepository } from './infrastructure/ev.repository';

// EV fleet management (FMS-96, architecture §13, docs/ev.md): battery state, charging sessions and stations.
const service = new EvService({ ev: new EvRepository(pool), vehicles: evRefs.vehicles, events: eventBus });

// A charging provider's session events (FMS-97, docs/ev.md#the-charging-webhook): each webhook the integration
// gateway stored for an ev_charging provider creates or moves its session, after the receipt has committed. Delivery
// is at least once; the session's provider id makes a redelivery change nothing.
eventBus.subscribe(INTEGRATION_EVENTS.webhookReceived, 'ev.charging-webhooks', async (event, tx) => {
  if (event.payload.provider_type !== 'ev_charging' || !EV_SESSION_KINDS.includes(event.payload.kind as EvSessionKind)) return;
  const delivery = await webhookDeliveries.find(tx, event.payload.sync_log_id as string);
  if (!delivery) return;
  const outcome = await service.applyProviderSession(tx, {
    providerId: delivery.provider_id,
    providerCode: delivery.provider_code,
    synthetic: delivery.data.synthetic === true,
    kind: delivery.kind as EvSessionKind,
    correlationId: event.correlation_id,
    session: delivery.data.session as EvProviderSession,
  });
  if (outcome.result === 'skipped') {
    logger.warn({ provider: delivery.provider_code, event_id: delivery.event_id, reason: outcome.reason }, 'ev.provider_session_skipped');
  }
});

const router = Router();
router.use(evRouter(service));

export const evModule: AppModule = { name: 'ev', router };
export { EV_EVENTS } from './domain/ev';
