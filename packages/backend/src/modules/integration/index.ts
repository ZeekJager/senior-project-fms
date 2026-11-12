import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { cache, redis } from '../../shared/cache';
import { validationFailed } from '../../shared/errors/app-error';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import { withTransaction } from '../../shared/infrastructure/transaction';
import { logger } from '../../shared/logging/logger';
import type { MutationContext } from '../../shared/infrastructure/audited-mutation';
import type { AppModule } from '../../shared/module';
import type { RequestUser } from '../../types/express';
import { userDirectory } from '../auth';
import { trackingRefs, VEHICLE_EVENTS } from '../fleet';
import { enRouteTripOfDriver, liveTripsForVehicles, tripPartiesByIds, tripRoadsByIds, tripSpansOfDriver, tripSpansOfVehicles, TRIP_EVENTS, type DelayMargins } from '../trip';
import { deviceRouter } from './api/device.routes';
import { geofenceRouter } from './api/geofence.routes';
import { integrationRouter, webhookRouter } from './api/integration.routes';
import { ruleThresholdRouter } from './api/rule-threshold.routes';
import { trackingRouter } from './api/tracking.routes';
import { DeviceService } from './application/device.service';
import { GeofenceService } from './application/geofence.service';
import { IngestionService } from './application/ingestion.service';
import { IntegrationService } from './application/integration.service';
import { LiveMapService } from './application/live-map.service';
import { LocationRulesService } from './application/location-rules.service';
import { trackingRetentionJob } from './application/tracking-retention.job';
import { RuleThresholdService } from './application/rule-threshold.service';
import { NotificationGateway } from './application/notification-gateway';
import { TelemetryRulesService, THRESHOLDS_TTL_MS } from './application/telemetry-rules.service';
import { TrackHistoryService } from './application/track-history.service';
import { ProviderRegistry, type InternalService } from './application/provider-registry';
import type { AdapterContext, NotificationChannel, OutboundMessage, ProviderAdapter, ProviderClient } from './domain/adapter';
import { TRACKING_EVENTS, type PingInput } from './domain/gps';
import type { LocationState } from './domain/location-rules';
import { INTEGRATION_EVENTS, type CircuitState } from './domain/provider';
import { DeviceRepository } from './infrastructure/device.repository';
import { fmsTelematicsAdapter, POSITIONS_KIND } from './infrastructure/fms-telematics.adapter';
import { GeofenceRepository } from './infrastructure/geofence.repository';
import { IntegrationRepository } from './infrastructure/integration.repository';
import { notificationAdapter } from './infrastructure/notification.adapter';
import { MemoryRuleStateStore, RedisRuleStateStore } from './infrastructure/rule-state.store';
import { RuleThresholdRepository } from './infrastructure/rule-threshold.repository';
import { TelemetryFlagRepository } from './infrastructure/telemetry-flag.repository';
import { TrackingRepository } from './infrastructure/tracking.repository';

// The integration gateway (FMS-85, architecture §15): every external provider behind an adapter, with
// timeouts, retries and a circuit breaker on each call, signed webhooks, and a sync log per exchange.
// See docs/integrations.md.

const repo = new IntegrationRepository(pool);
const registry = new ProviderRegistry(config.integrations.secrets, logger);
const service = new IntegrationService({ repo, registry, events: eventBus, log: logger });

// Telematics providers without an adapter of their own speak the FMS telematics format (FMS-88).
registry.registerForType('telematics', fmsTelematicsAdapter);
// Notification providers (FMS-93): SMTP email, the FMS SMS format, or Web Push, by their configuration.channel.
registry.registerForType('notification', (code) => notificationAdapter(code));
const notifications = new NotificationGateway({ repo, registry, log: logger });

const devices = new DeviceRepository(pool);
const tracking = new TrackingRepository();
const ingestion = new IngestionService({
  tracking,
  devices,
  refs: {
    vehicles: trackingRefs.vehicles,
    drivers: trackingRefs.drivers,
    trips: { enRouteOfDriver: enRouteTripOfDriver, spansOfDriver: tripSpansOfDriver, spansOfVehicles: tripSpansOfVehicles },
    meters: trackingRefs.meters,
  },
  events: eventBus,
  eventIntervalSeconds: config.tracking.eventIntervalSeconds,
});

// The device registry (FMS-138, docs/telematics.md): which provider device reports for which vehicle.
const deviceService = new DeviceService({
  devices,
  providers: repo,
  ingestion,
  refs: { vehicles: { byPublicIds: trackingRefs.vehicles.byPublicIds, idsInScope: trackingRefs.vehicles.idsInScope, refsByIds: trackingRefs.vehicles.refsByIds } },
});

// A telematics webhook's positions become pings for that provider's devices, after the receipt has
// committed (at least once: the pings' unique key makes a redelivery a no-op). Today's counts get what
// was stored and refused, and the registry the device ids linked to no vehicle (FMS-138).
eventBus.subscribe(INTEGRATION_EVENTS.webhookReceived, 'integration.telematics-pings', async (event, tx) => {
  if (event.payload.provider_type !== 'telematics' || event.payload.kind !== POSITIONS_KIND) return;
  const delivery = await repo.delivery(tx, event.payload.sync_log_id as string);
  const provider = delivery && (await repo.findProviderByCode(tx, delivery.providerCode));
  if (!delivery || !provider) return;
  const positions = (delivery.metadata.data?.positions ?? []) as PingInput[];
  await deviceService.ingestDelivery(tx, provider, positions, event.correlation_id);
});

// The live map's snapshot (FMS-45), cached for a few seconds. A trip starting, ending or changing, or a
// vehicle changing, drops it after commit, so a screen re-reading on trip.updated sees the change.
const liveMap = new LiveMapService({
  db: pool,
  tracking,
  refs: {
    vehicles: { liveMap: trackingRefs.vehicles.liveMap },
    drivers: { names: trackingRefs.drivers.names },
    depots: trackingRefs.depots,
    trips: { liveForVehicles: liveTripsForVehicles },
  },
  cache,
});
// The telemetry rules (FMS-46): each announced position runs the vehicle's new pings through the speeding and
// idling rules, which open and close tracking.telemetry_flags on the event's transaction. The counters between
// pings live in Redis (in process without it), so a restart does not reset them. docs/telemetry-rules.md.
const memoryRuleState = new MemoryRuleStateStore();
const flagRepository = new TelemetryFlagRepository();
const telemetryRules = new TelemetryRulesService({
  db: pool,
  tracking,
  flags: flagRepository,
  state: redis
    ? new RedisRuleStateStore(redis, memoryRuleState, (err, op) => logger.warn({ err, op }, 'telemetry rule state: Redis failed; counting in process'))
    : memoryRuleState,
  refs: {
    vehicles: { byPublicIds: trackingRefs.vehicles.byPublicIds },
    trips: { partiesByIds: tripPartiesByIds },
    drivers: { publicIds: trackingRefs.drivers.publicIds },
  },
  events: eventBus,
});
eventBus.subscribe(TRACKING_EVENTS.locationUpdated, 'integration.telemetry-rules', (event, tx) => telemetryRules.onLocationUpdated(tx, event));

// Geofences and route deviation (FMS-90): the same pings against the depot's fences and the trip's road, with
// counters of their own in Redis. docs/geofences.md.
const geofenceRepository = new GeofenceRepository();
const memoryLocationState = new MemoryRuleStateStore<LocationState>();
const locationRules = new LocationRulesService({
  tracking,
  flags: flagRepository,
  geofences: geofenceRepository,
  state: redis
    ? new RedisRuleStateStore<LocationState>(redis, memoryLocationState, (err, op) => logger.warn({ err, op }, 'location rule state: Redis failed; counting in process'), 'location')
    : memoryLocationState,
  refs: {
    vehicles: { byPublicIds: trackingRefs.vehicles.byPublicIds },
    trips: { partiesByIds: tripPartiesByIds },
    drivers: { publicIds: trackingRefs.drivers.publicIds },
    roads: { forTrips: tripRoadsByIds },
  },
  events: eventBus,
});
eventBus.subscribe(TRACKING_EVENTS.locationUpdated, 'integration.location-rules', (event, tx) => locationRules.onLocationUpdated(tx, event));

const geofences = new GeofenceService({
  db: pool,
  geofences: geofenceRepository,
  flags: flagRepository,
  transaction: (fn) => withTransaction(pool, fn),
  refs: {
    depots: trackingRefs.depots,
    vehicles: { byIds: trackingRefs.vehicles.byIds },
    trips: { partiesByIds: tripPartiesByIds },
    drivers: { publicIds: trackingRefs.drivers.publicIds },
    users: userDirectory,
  },
  events: eventBus,
  onChange: () => locationRules.forgetFences(),
});

// Their thresholds from the settings screen (FMS-80): the fleet's and each depot's, admin only.
const thresholdRepository = new RuleThresholdRepository();
// The trip delay margins (FMS-147), for the trip module's ETA, cached as the rules cache theirs.
const delayMarginCache = new Map<string, { value: DelayMargins; until: number }>();
async function tripDelayMargins(db: Queryable, depotId: string | null): Promise<DelayMargins> {
  const key = depotId ?? 'fleet';
  const hit = delayMarginCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await thresholdRepository.delayMargins(db, depotId);
  delayMarginCache.set(key, { value, until: Date.now() + THRESHOLDS_TTL_MS });
  return value;
}
const ruleThresholds = new RuleThresholdService({
  db: pool,
  thresholds: thresholdRepository,
  transaction: (fn) => withTransaction(pool, fn),
  refs: { depots: trackingRefs.depots, users: userDirectory },
  onChange: () => {
    telemetryRules.forgetThresholds();
    locationRules.forgetThresholds();
    delayMarginCache.clear();
  },
});

// A vehicle's GPS history (FMS-136): its stored pings, a page at a time, for the vehicle page's trip map.
const trackHistory = new TrackHistoryService({
  db: pool,
  tracking,
  refs: { vehicles: { byPublicIds: trackingRefs.vehicles.byPublicIds }, trips: { partiesByIds: tripPartiesByIds } },
});

// A flag opening or closing also drops the live map's snapshot, so its legend counts it at once.
for (const type of [...Object.values(TRIP_EVENTS), ...Object.values(VEHICLE_EVENTS), TRACKING_EVENTS.flagRaised, TRACKING_EVENTS.flagResolved]) {
  eventBus.subscribe(type, 'integration.live-map-cache', () => liveMap.invalidate());
}

const router = Router();
router.use(integrationRouter(service));
router.use(webhookRouter(service));
router.use(deviceRouter(deviceService));
router.use(trackingRouter(ingestion, liveMap, telemetryRules, trackHistory));
router.use(ruleThresholdRouter(ruleThresholds));
router.use(geofenceRouter(geofences));

export const integrationModule: AppModule = {
  name: 'integration',
  router,
  jobs: [
    // FMS-104: pings and flags older than the retention period are deleted (docs/driver-data-protection.md).
    trackingRetentionJob({ db: pool, tracking, flags: flagRepository, retention: config.tracking.retention }),
  ],
};

/** What other modules (and the composition root) use of the gateway. */
export const integrationGateway = {
  /** Adds a provider integration, matched by `code` to its integration.external_providers row. */
  register: (adapter: ProviderAdapter): void => registry.register(adapter),
  /** A provider's client and API key, to call it from another module. 404 if unknown, 400 if switched off. */
  contextFor: (code: string, correlationId: string): Promise<AdapterContext> => service.contextFor(code, correlationId),
  /**
   * A client for a service of the stack itself, set up from the environment (the ML service, FMS-55):
   * a timeout on each attempt, retries for idempotent calls, and a breaker per service on this instance.
   */
  internalClient: (service: InternalService, correlationId: string): ProviderClient => registry.internalClient(service, correlationId),
  /** Resolves when the manual syncs started so far have finished (tests, shutdown). */
  settled: (): Promise<void> => service.settled(),
  /** Counts for /health/ready: providers called, circuits open and half-open on this instance. */
  metrics: async (): Promise<Record<string, number>> => registry.metrics(),
  /** Each active provider's circuit on this instance, for the system health sampler (FMS-143); closed when not called yet. */
  circuits: async (): Promise<{ code: string; name: string; state: CircuitState; latencyMeanMs: number | null }[]> =>
    (await repo.listProviders(repo.pool()))
      .filter((p) => p.isActive)
      .map((p) => {
        const circuit = registry.circuitOf(p);
        return { code: p.code, name: p.name, state: circuit?.state ?? 'closed', latencyMeanMs: circuit && circuit.window.calls > 0 ? circuit.latency_mean_ms : null };
      }),
  shutdown: (): void => registry.shutdown(),
};

/**
 * The notification channels (FMS-93, docs/notification-channels.md), for the alert engine: which of email, SMS and
 * push are on, and one message at a time through the channel's provider.
 */
export const notificationGateway = {
  channels: (db?: Queryable): Promise<Set<NotificationChannel>> => notifications.channels(db),
  pushPublicKey: (db?: Queryable): Promise<string | null> => notifications.pushPublicKey(db),
  destinationProblem: (channel: NotificationChannel, to: OutboundMessage['to'], db?: Queryable): Promise<string | null> =>
    notifications.destinationProblem(channel, to, db),
  send: (message: OutboundMessage, correlationId: string) => notifications.send(message, correlationId),
  codes: (db: Queryable, ids: readonly string[]): Promise<Map<string, string>> => notifications.codes(db, ids),
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
/** For the engine-hours job (FMS-126, fleet): each vehicle's ignition-on seconds in a window, from its devices' pings. */
export const ignitionTime = {
  seconds: (db: Queryable, start: Date, end: Date, maxGapSeconds: number) => tracking.ignitionSeconds(db, start, end, maxGapSeconds),
};

/** For the fuel anomaly rules (FMS-82): where a vehicle (internal id) was around a time, from its stored pings. */
/** For a driver's data export (FMS-104): the pings recorded on their trips. */
export const driverLocationData = {
  forTrips: (db: Queryable, tripIds: readonly string[], limit: number) => tracking.forTrips(db, tripIds, limit),
};

export const trackingLookups = {
  positionNear: (db: Queryable, vehicleId: string, at: Date, windowMs: number) => tracking.nearest(db, vehicleId, at, windowMs),
  /** For a trip's live state (FMS-95, trip): a vehicle's newest position. */
  currentPosition: (db: Queryable, vehicleId: string) => tracking.currentPosition(db, vehicleId),
  /** For a trip's actual distance (FMS-145, trip): the positions recorded during it, and how many there are now. */
  tripTrack: (db: Queryable, trip: { tripId: string; vehicleId: string; start: Date; end: Date }, limit: number) => tracking.tripTrack(db, trip, limit),
  tripTrackCounts: (db: Queryable, trips: readonly { tripId: string; vehicleId: string; start: Date; end: Date }[]) => tracking.tripTrackCounts(db, trips),
  /** For the trip delay alert (FMS-147, trip): a depot's margins (internal id; null: the fleet's), kept with the thresholds. */
  tripDelayMargins,
  /** For assignment (FMS-151, trip): a depot's exception policies, read on the assignment's transaction, never cached. */
  exceptionPolicies: (db: Queryable, depotId: string | null) => thresholdRepository.exceptionPolicies(db, depotId),
};

export const gpsDevices = {
  register: (input: { vehicleId: string; identifier: string; providerId?: string | null; model?: string | null }, ctx: MutationContext) =>
    ingestion.registerDevice(input, ctx),
  /**
   * Links a telematics provider's device (provider public id) to a vehicle, as POST /integrations/devices does, for
   * any vehicle (the GPS simulator, FMS-138). `replace` takes the vehicle's other device out of service.
   */
  link: (input: { providerId: string; identifier: string; vehicleId: string; model?: string | null; replace?: boolean }, ctx: MutationContext) =>
    deviceService.linkAsSystem(
      { provider_id: input.providerId, device_identifier: input.identifier, vehicle_id: input.vehicleId, device_model: input.model, replace: input.replace ?? false },
      ctx,
    ),
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
  DeliveryRefused,
  NOTIFICATION_CHANNELS,
  PROVIDER_TYPES,
  ProviderCallError,
  WebhookPayloadError,
  type AdapterContext,
  type DeliveryReceipt,
  type NormalizedWebhook,
  type NotificationChannel,
  type OutboundMessage,
  type PushTarget,
  type ProviderAdapter,
  type ProviderClient,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderType,
  type SyncOutcome,
} from './domain/adapter';
export type { InternalService } from './application/provider-registry';
export { INTEGRATION_EVENTS } from './domain/provider';
export { MAX_PINGS_PER_BATCH, TRACKING_EVENTS, type PingInput } from './domain/gps';
export { GEOFENCE_EVENTS } from './domain/geofence';
export { LIVE_MAP_CACHE_TTL_SECONDS, type VehicleLocation } from './domain/live-map';
export { fmsTelematicsAdapter } from './infrastructure/fms-telematics.adapter';
export { REPLAY_WINDOW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from './domain/webhook-signature';
export { mockProviderAdapter } from './infrastructure/mock-provider';
export { notificationAdapter, type NotificationAdapterOptions } from './infrastructure/notification.adapter';
export type { SendOutcome } from './application/notification-gateway';
export { generateVapidKeys, vapidKeysMatch, type VapidKeys } from './domain/web-push';
