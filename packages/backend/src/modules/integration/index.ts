import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { integrationRouter, webhookRouter } from './api/integration.routes';
import { IntegrationService } from './application/integration.service';
import { ProviderRegistry } from './application/provider-registry';
import type { AdapterContext, ProviderAdapter } from './domain/adapter';
import { IntegrationRepository } from './infrastructure/integration.repository';

// The integration gateway (FMS-85, architecture §15): every external provider behind an adapter, with
// timeouts, retries and a circuit breaker on each call, signed webhooks, and a sync log per exchange.
// See docs/integrations.md.

const repo = new IntegrationRepository(pool);
const registry = new ProviderRegistry(config.integrations.secrets, logger);
const service = new IntegrationService({ repo, registry, events: eventBus, log: logger });

const router = Router();
router.use(integrationRouter(service));
router.use(webhookRouter(service));

export const integrationModule: AppModule = { name: 'integration', router };

/** What other modules (and the composition root) use of the gateway. */
export const integrationGateway = {
  /** Adds a provider integration, matched by `code` to its integration.external_providers row. */
  register: (adapter: ProviderAdapter): void => registry.register(adapter),
  /** A provider's client and API key, to call it from another module. 404 if unknown, 400 if switched off. */
  contextFor: (code: string, correlationId: string): Promise<AdapterContext> => service.contextFor(code, correlationId),
  /** Resolves when the manual syncs started so far have finished (tests, shutdown). */
  settled: (): Promise<void> => service.settled(),
  /** Counts for /health/ready: providers called, circuits open and half-open on this instance. */
  metrics: async (): Promise<Record<string, number>> => registry.metrics(),
  shutdown: (): void => registry.shutdown(),
};

/** For the consumer of IntegrationWebhookReceived: the stored delivery its event points at. */
export const webhookDeliveries = {
  async find(db: Queryable, syncLogId: string) {
    const row = await repo.delivery(db, syncLogId);
    if (!row) return null;
    return {
      provider_code: row.providerCode,
      provider_type: row.providerType,
      event_id: row.eventId,
      kind: row.metadata.kind ?? null,
      occurred_at: row.metadata.occurred_at ?? null,
      data: row.metadata.data ?? {},
    };
  },
};

export { keepsRawBody, WEBHOOK_PATHS } from './api/integration.routes';
export {
  PROVIDER_TYPES,
  ProviderCallError,
  WebhookPayloadError,
  type AdapterContext,
  type NormalizedWebhook,
  type ProviderAdapter,
  type ProviderClient,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderType,
  type SyncOutcome,
} from './domain/adapter';
export { INTEGRATION_EVENTS } from './domain/provider';
export { REPLAY_WINDOW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from './domain/webhook-signature';
export { mockProviderAdapter } from './infrastructure/mock-provider';
