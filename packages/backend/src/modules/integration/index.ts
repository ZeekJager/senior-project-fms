import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { validationFailed } from '../../shared/errors/app-error';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import { logger } from '../../shared/logging/logger';
import type { MutationContext } from '../../shared/infrastructure/audited-mutation';
import type { AppModule } from '../../shared/module';
import type { RequestUser } from '../../types/express';
import { trackingRefs } from '../fleet';
import { enRouteTripOfDriver, enRouteTripsForVehicles } from '../trip';
import { integrationRouter, webhookRouter } from './api/integration.routes';
import { trackingRouter } from './api/tracking.routes';
import { IngestionService } from './application/ingestion.service';
import { IntegrationService } from './application/integration.service';
import { ProviderRegistry } from './application/provider-registry';
import type { AdapterContext, ProviderAdapter } from './domain/adapter';
import type { PingInput } from './domain/gps';
import { INTEGRATION_EVENTS } from './domain/provider';
import { DeviceRepository } from './infrastructure/device.repository';
import { fmsTelematicsAdapter, POSITIONS_KIND } from './infrastructure/fms-telematics.adapter';
import { IntegrationRepository } from './infrastructure/integration.repository';
import { TrackingRepository } from './infrastructure/tracking.repository';

// The integration gateway (FMS-85, architecture §15): every external provider behind an adapter, with
// timeouts, retries and a circuit breaker on each call, signed webhooks, and a sync log per exchange.
// See docs/integrations.md.

const repo = new IntegrationRepository(pool);
const registry = new ProviderRegistry(config.integrations.secrets, logger);
const service = new IntegrationService({ repo, registry, events: eventBus, log: logger });

// Telematics providers without an adapter of their own speak the FMS telematics format (FMS-88).
registry.registerForType('telematics', fmsTelematicsAdapter);

const devices = new DeviceRepository(pool);
const ingestion = new IngestionService({
  tracking: new TrackingRepository(),
  devices,
  refs: {
    vehicles: trackingRefs.vehicles,
    drivers: trackingRefs.drivers,
    trips: { enRouteForVehicles: enRouteTripsForVehicles, enRouteOfDriver: enRouteTripOfDriver },
  },
  events: eventBus,
  eventIntervalSeconds: config.tracking.eventIntervalSeconds,
});

// A telematics webhook's positions become pings for that provider's devices, after the receipt has
// committed (at least once: the pings' unique key makes a redelivery a no-op).
eventBus.subscribe(INTEGRATION_EVENTS.webhookReceived, 'integration.telematics-pings', async (event, tx) => {
  if (event.payload.provider_type !== 'telematics' || event.payload.kind !== POSITIONS_KIND) return;
  const delivery = await repo.delivery(tx, event.payload.sync_log_id as string);
  const provider = delivery && (await repo.findProviderByCode(tx, delivery.providerCode));
  if (!delivery || !provider) return;
  const positions = (delivery.metadata.data?.positions ?? []) as PingInput[];
  await ingestion.ingest({ kind: 'provider', providerId: provider.id, providerCode: provider.code }, positions, event.correlation_id, tx);
});

const router = Router();
router.use(integrationRouter(service));
router.use(webhookRouter(service));
router.use(trackingRouter(ingestion));

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

/**
 * The legacy socket `location_update` (api-contract §11.2, off unless REALTIME_LEGACY_LOCATION): one position,
 * stamped on arrival, for the driver's own trip under way, through the same ingestion as the API.
 */
export async function legacyLocationIngest(
  user: RequestUser,
  location: { tripId: string; lat: number; lng: number; speedKmh?: number | null; bearing?: number | null; accuracyM?: number | null },
): Promise<void> {
  const result = await ingestion.ingest(
    { kind: 'phone', user, tripId: location.tripId },
    [{ recorded_at: new Date().toISOString(), lat: location.lat, lng: location.lng, speed_kmh: location.speedKmh ?? 0, heading: location.bearing ?? null, accuracy_m: location.accuracyM ?? null }],
    randomUUID(),
  );
  const [refused] = result.rejected;
  if (refused) throw validationFailed([{ field: 'location', reason: refused.reason }], 'The position was not recorded.');
}

/** GPS devices (FMS-88): install one in a vehicle and get its token, shown once (scripts/gps-device.ts, the simulator). */
export const gpsDevices = {
  register: (input: { vehicleId: string; identifier: string; providerId?: string | null; model?: string | null }, ctx: MutationContext) =>
    ingestion.registerDevice(input, ctx),
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
export { MAX_PINGS_PER_BATCH, TRACKING_EVENTS, type PingInput } from './domain/gps';
export { fmsTelematicsAdapter } from './infrastructure/fms-telematics.adapter';
export { REPLAY_WINDOW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from './domain/webhook-signature';
export { mockProviderAdapter } from './infrastructure/mock-provider';
