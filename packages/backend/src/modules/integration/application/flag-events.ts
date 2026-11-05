import type { PoolClient } from 'pg';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { TRACKING_EVENTS } from '../domain/gps';
import type { FlagRecord } from '../infrastructure/telemetry-flag.repository';

/** A vehicle as the rules need it, from the fleet module. */
export interface RulesVehicle {
  id: string;
  publicId: string;
  depotId: string | null;
  depotPublicId: string | null;
}

/** A flag the rules opened or closed. */
export interface FlagChange {
  kind: 'raised' | 'resolved';
  flag: FlagRecord;
}

/** What the events need from trip (a flag's trip and driver) and of the fences (connected in integration/index.ts). */
export interface FlagEventRefs {
  trips: { partiesByIds(db: Queryable, tripIds: readonly string[]): Promise<Map<string, { publicId: string; driverId: string | null }>> };
  drivers: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
}

/** The ids every flag event carries, in public ids. */
export interface FlagEventCommon {
  flag_id: string;
  vehicle_id: string;
  depot_id: string | null;
  trip_id: string | null;
  driver_id: string | null;
  flag_type: string;
  severity: string;
  observed_at: string;
}

/**
 * TelemetryFlagRaised and TelemetryFlagResolved, in public ids, in the order the flags changed, on the rules'
 * transaction (FMS-46). A geofence flag names its fence (`geofence_id`, FMS-90). `also` adds an event of its
 * own for a change (GeofenceViolated, RouteDeviationDetected), right after that change's.
 */
export async function publishFlagChanges(
  tx: PoolClient,
  deps: { refs: FlagEventRefs; events: EventBus },
  vehicle: RulesVehicle,
  changes: readonly FlagChange[],
  correlationId: string,
  options: { geofencePublicIds?: ReadonlyMap<string, string>; also?: (change: FlagChange, common: FlagEventCommon) => DomainEvent | null } = {},
): Promise<void> {
  if (changes.length === 0) return;
  const { refs, events } = deps;
  const trips = await refs.trips.partiesByIds(tx, [...new Set(changes.flatMap((c) => (c.flag.tripId ? [c.flag.tripId] : [])))]);
  const drivers = await refs.drivers.publicIds(tx, [...new Set([...trips.values()].flatMap((t) => (t.driverId ? [t.driverId] : [])))]);
  const meta = { actor: null, correlationId };
  const aggregate = { aggregate: aggregateKey('vehicle', vehicle.publicId) };
  await events.publish(
    tx,
    changes.flatMap((change) => {
      const { kind, flag } = change;
      const trip = flag.tripId ? trips.get(flag.tripId) : undefined;
      const common: FlagEventCommon = {
        flag_id: flag.publicId,
        vehicle_id: vehicle.publicId,
        depot_id: vehicle.depotPublicId,
        trip_id: trip?.publicId ?? null,
        driver_id: trip?.driverId ? (drivers.get(trip.driverId) ?? null) : null,
        flag_type: flag.flagType,
        severity: flag.severity,
        observed_at: flag.observedAt.toISOString(),
      };
      const fence = flag.geofenceId ? { geofence_id: options.geofencePublicIds?.get(flag.geofenceId) ?? null } : {};
      const event =
        kind === 'raised'
          ? createEvent(TRACKING_EVENTS.flagRaised, { ...common, ...fence, details: flag.details }, meta, aggregate)
          : createEvent(TRACKING_EVENTS.flagResolved, { ...common, ...fence, resolved_at: flag.resolvedAt!.toISOString(), details: flag.details }, meta, aggregate);
      const extra = options.also?.(change, common);
      return extra ? [event, extra] : [event];
    }),
  );
}
