import { Router } from 'express';
import { pool } from '../../db';
import type { Queryable } from '../../shared/infrastructure/queryable';
import { eventBus } from '../../shared/events/event-bus';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { evRefs } from '../fleet';
import { settings } from '../settings';
import { liveTripsForVehicles } from '../trip';
import { EV_SESSION_KINDS, INTEGRATION_EVENTS, webhookDeliveries, type EvProviderSession, type EvSessionKind } from '../integration';
import { evRouter } from './api/ev.routes';
import { EvService } from './application/ev.service';
import { EvRepository } from './infrastructure/ev.repository';
import { EV_EVENTS } from './domain/ev';
import { DEFAULT_BATTERY_THRESHOLDS, type RangeEstimate } from './domain/range';

// EV fleet management (FMS-96, architecture §13, docs/ev.md): battery state, charging sessions and stations.
const service = new EvService({
  ev: new EvRepository(pool),
  vehicles: evRefs.vehicles,
  events: eventBus,
  // The low-charge and battery-health lines (FMS-98): settings, read at each reading so a change applies at once.
  thresholds: async () => ({
    lowSocPct: (await settings.get<number>('ev_low_soc_pct')) ?? DEFAULT_BATTERY_THRESHOLDS.lowSocPct,
    healthMinPct: (await settings.get<number>('ev_battery_health_min_pct')) ?? DEFAULT_BATTERY_THRESHOLDS.healthMinPct,
  }),
  // The km left on a vehicle's trip under way: its latest arrival estimate (FMS-86), else the trip's planned distance.
  tripsUnderWay: async (db, vehicleIds) => {
    const live = await liveTripsForVehicles(db, vehicleIds);
    return new Map([...live].map(([id, t]) => [id, { tripId: t.tripId, remainingKm: t.eta?.remainingKm ?? t.plannedDistanceKm }]));
  },
});

// FMS-98 (docs/ev.md#alerts): each battery reading is checked against the low-charge and health lines and, on a trip,
// the km left. BatteryThresholdExceeded goes to the alert engine's battery rule.
eventBus.subscribe(EV_EVENTS.batteryLogged, 'ev.battery-thresholds', async (event, tx) => {
  await service.onBatteryLogged(tx, event);
});

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

/**
 * For the assignment warning (trip) and the dispatch board (fleet), FMS-98: the range now of each vehicle (internal
 * ids) that has an estimate; vehicles without one (not electric, no readings, no capacity known) are left out.
 */
export const evRange = {
  async forVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, RangeEstimate>> {
    const out = new Map<string, RangeEstimate>();
    for (const [id, r] of await service.ranges(db, vehicleIds)) if (r.estimate) out.set(id, r.estimate);
    return out;
  },
};
export type { RangeEstimate } from './domain/range';
export { EV_EVENTS } from './domain/ev';
