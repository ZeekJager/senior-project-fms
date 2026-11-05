import type { PoolClient } from 'pg';
import type { Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { GEOFENCE_EVENTS } from '../domain/geofence';
import type { LineString } from '../domain/geometry';
import {
  evaluateLocation,
  fenceKey,
  INITIAL_LOCATION_STATE,
  ROAD_KEY,
  type LocationAction,
  type LocationState,
  type LocationThresholds,
} from '../domain/location-rules';
import { MAX_PING_GAP_MS } from '../domain/telemetry-rules';
import type { ActiveFence, GeofenceRepository } from '../infrastructure/geofence.repository';
import type { RuleStateStore } from '../infrastructure/rule-state.store';
import type { TelemetryFlagRepository } from '../infrastructure/telemetry-flag.repository';
import type { TrackingRepository } from '../infrastructure/tracking.repository';
import { publishFlagChanges, type FlagChange, type FlagEventCommon, type FlagEventRefs, type RulesVehicle } from './flag-events';
import { MAX_PINGS_PER_RUN, THRESHOLDS_TTL_MS } from './telemetry-rules.service';

/** A trip's road, from the trip module: its route's public id and line. */
export interface TripRoadRef {
  routeId: string;
  line: LineString;
}

export interface LocationRulesServiceDeps {
  tracking: Pick<TrackingRepository, 'pingsBetween'>;
  flags: Pick<TelemetryFlagRepository, 'locationThresholds' | 'ongoingLocation' | 'raise' | 'resolve'>;
  geofences: Pick<GeofenceRepository, 'activeForDepot'>;
  state: RuleStateStore<LocationState>;
  refs: FlagEventRefs & {
    vehicles: { byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<RulesVehicle[]> };
    /** The roads of trips (internal ids) whose route has one. */
    roads: { forTrips(db: Queryable, tripIds: readonly string[]): Promise<Map<string, TripRoadRef>> };
  };
  events: EventBus;
  now?: () => number;
}

/** A depot's fences are re-read at most this often; a change on this instance clears them at once (FMS-90). */
export const FENCES_TTL_MS = 30_000;
/** A trip's road is re-read at most this often: a route's waypoints can change while a trip is under way. */
export const ROADS_TTL_MS = 60_000;
/** Roads kept in memory at most; past it the oldest go first. */
const MAX_ROADS_CACHED = 5000;

/** How serious each flag is: leaving a yard or entering a no-go zone may be theft; straying from a route needs a call. */
const SEVERITY = { geofence_violation: 'high', route_deviation: 'medium' } as const;

/**
 * Geofences and route deviation (FMS-90, docs/geofences.md): on each VehicleLocationUpdated, the vehicle's pings
 * since the last ones checked go past its depot's active fences and its trip's road (domain/location-rules.ts), in
 * recorded order. Flags open and close in tracking.telemetry_flags on the event's transaction, each with
 * TelemetryFlagRaised or TelemetryFlagResolved, and an opened one with GeofenceViolated or RouteDeviationDetected
 * too. The counters between pings are kept in Redis (`location`), apart from the speeding and idling rules'.
 */
export class LocationRulesService {
  private readonly now: () => number;
  private readonly fenceCache = new Map<string, { value: ActiveFence[]; until: number }>();
  private readonly thresholdCache = new Map<string, { value: LocationThresholds; until: number }>();
  private readonly roadCache = new Map<string, { value: TripRoadRef | null; until: number }>();

  constructor(private readonly deps: LocationRulesServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The consumer of VehicleLocationUpdated. An event handled again starts from the counters before it, so it decides the same. */
  async onLocationUpdated(tx: PoolClient, event: DomainEvent): Promise<void> {
    const vehiclePublicId = typeof event.payload.vehicle_id === 'string' ? event.payload.vehicle_id : null;
    const upTo = Date.parse(String(event.payload.recorded_at));
    if (!vehiclePublicId || Number.isNaN(upTo)) return;
    const { tracking, flags, state, refs } = this.deps;
    const [vehicle] = await refs.vehicles.byPublicIds(tx, [vehiclePublicId], { kind: 'all' });
    if (!vehicle) return;

    const stored = await state.load(vehiclePublicId);
    const base = stored ? (stored.eventId === event.id ? stored.before : stored.after) : null;
    if (base?.lastAt != null && base.lastAt >= upTo) return; // an older position than the last checked

    const pings = await tracking.pingsBetween(tx, vehicle.id, base?.lastAt != null ? new Date(base.lastAt) : null, new Date(upTo), MAX_PING_GAP_MS, MAX_PINGS_PER_RUN);
    if (pings.length === 0) return;
    // One after another: the queries share the event's transaction.
    const fences = vehicle.depotId ? await this.fences(tx, vehicle.depotId) : [];
    const openRows = await flags.ongoingLocation(tx, vehicle.id);
    const roads = await this.roads(tx, [...new Set(pings.flatMap((p) => (p.tripId ? [p.tripId] : [])))]);
    if (fences.length === 0 && roads.size === 0 && openRows.length === 0) {
      await state.save(vehiclePublicId, { eventId: event.id, before: base, after: { ...(base ?? INITIAL_LOCATION_STATE), lastAt: pings[pings.length - 1].at } });
      return;
    }

    const open = new Set(openRows.map((r) => (r.flagType === 'route_deviation' ? ROAD_KEY : fenceKey(r.geofenceId!))));
    let start = base ?? INITIAL_LOCATION_STATE;
    // Counters lost (Redis emptied, 24 hours silent) while off route: carry on from the open flag's trip.
    const openRoad = openRows.find((r) => r.flagType === 'route_deviation');
    if (!start.road && openRoad?.tripId) start = { ...start, road: { tripId: openRoad.tripId, offCount: 0, offSince: null, onCount: 0, onSince: null, maxM: 0 } };
    const t = await this.thresholds(tx, vehicle.depotId);
    const lines = new Map([...roads].map(([tripId, r]) => [tripId, r.line]));
    const { state: next, actions } = evaluateLocation(start, open, pings, fences, lines, t);

    const changes = await this.apply(tx, vehicle.id, actions, fences);
    const byId = new Map(fences.map((f) => [f.id, f]));
    await publishFlagChanges(tx, this.deps, vehicle, changes, event.correlation_id, {
      geofencePublicIds: new Map(fences.map((f) => [f.id, f.publicId])),
      also: (change, common) => this.violationEvent(change, common, byId, roads, event.correlation_id),
    });
    await state.save(vehiclePublicId, { eventId: event.id, before: base, after: next });
  }

  /** Forgets the cached fences, after one was drawn, changed or removed: the next ping reads them again. */
  forgetFences(): void {
    this.fenceCache.clear();
  }

  /** Forgets the cached thresholds, after a change on the settings screen (FMS-80). */
  forgetThresholds(): void {
    this.thresholdCache.clear();
  }

  private async fences(db: Queryable, depotId: string): Promise<ActiveFence[]> {
    const hit = this.fenceCache.get(depotId);
    if (hit && hit.until > this.now()) return hit.value;
    const value = await this.deps.geofences.activeForDepot(db, depotId);
    this.fenceCache.set(depotId, { value, until: this.now() + FENCES_TTL_MS });
    return value;
  }

  private async thresholds(db: Queryable, depotId: string | null): Promise<LocationThresholds> {
    const key = depotId ?? 'fleet';
    const hit = this.thresholdCache.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const value = await this.deps.flags.locationThresholds(db, depotId);
    this.thresholdCache.set(key, { value, until: this.now() + THRESHOLDS_TTL_MS });
    return value;
  }

  /** The roads of the trips the pings carry, cached per trip (a trip without a road too). */
  private async roads(db: Queryable, tripIds: readonly string[]): Promise<Map<string, TripRoadRef>> {
    const out = new Map<string, TripRoadRef>();
    const missing: string[] = [];
    for (const id of tripIds) {
      const hit = this.roadCache.get(id);
      if (hit && hit.until > this.now()) {
        if (hit.value) out.set(id, hit.value);
      } else missing.push(id);
    }
    if (missing.length === 0) return out;
    const found = await this.deps.refs.roads.forTrips(db, missing);
    const until = this.now() + ROADS_TTL_MS;
    for (const id of missing) {
      if (this.roadCache.size >= MAX_ROADS_CACHED) this.roadCache.delete(this.roadCache.keys().next().value!);
      this.roadCache.set(id, { value: found.get(id) ?? null, until });
      const road = found.get(id);
      if (road) out.set(id, road);
    }
    return out;
  }

  /** Writes the flags the rules decided. One the database already had (or had already closed) changes nothing. */
  private async apply(tx: PoolClient, vehicleId: string, actions: readonly LocationAction[], fences: readonly ActiveFence[]): Promise<FlagChange[]> {
    const byId = new Map(fences.map((f) => [f.id, f]));
    const changes: FlagChange[] = [];
    for (const action of actions) {
      if (action.kind === 'raise') {
        const fence = action.geofenceId ? byId.get(action.geofenceId) : undefined;
        const flag = await this.deps.flags.raise(tx, {
          vehicleId,
          flagType: action.flagType,
          geofenceId: action.geofenceId,
          severity: SEVERITY[action.flagType],
          observedAt: new Date(action.observedAt),
          ping: action.ping,
          details: fence ? { ...action.details, geofence_name: fence.name } : action.details,
        });
        if (flag) changes.push({ kind: 'raised', flag });
      } else {
        const flag = await this.deps.flags.resolve(tx, vehicleId, action.flagType, new Date(action.resolvedAt), action.reason, {
          geofenceId: action.geofenceId,
          details: action.details,
        });
        if (flag) changes.push({ kind: 'resolved', flag });
      }
    }
    return changes;
  }

  /** GeofenceViolated or RouteDeviationDetected, for a flag that opened; the alert engine makes it an alert. */
  private violationEvent(
    change: FlagChange,
    common: FlagEventCommon,
    fences: ReadonlyMap<string, ActiveFence>,
    roads: ReadonlyMap<string, TripRoadRef>,
    correlationId: string,
  ): DomainEvent | null {
    if (change.kind !== 'raised') return null;
    const { flag } = change;
    const d = flag.details;
    const meta = { actor: null, correlationId };
    const aggregate = { aggregate: aggregateKey('vehicle', common.vehicle_id) };
    const position = { lat: d.lat ?? null, lng: d.lng ?? null };
    if (flag.flagType === 'geofence_violation') {
      const fence = flag.geofenceId ? fences.get(flag.geofenceId) : undefined;
      if (!fence) return null;
      return createEvent(GEOFENCE_EVENTS.violated, { ...common, geofence_id: fence.publicId, geofence_name: fence.name, kind: fence.kind, ...position }, meta, aggregate);
    }
    if (flag.flagType === 'route_deviation') {
      const road = flag.tripId ? roads.get(flag.tripId) : undefined;
      return createEvent(
        GEOFENCE_EVENTS.routeDeviationDetected,
        {
          ...common,
          route_id: road?.routeId ?? null,
          distance_m: d.distance_m ?? null,
          route_deviation_m: d.route_deviation_m ?? null,
          consecutive_pings: d.consecutive_pings ?? null,
          ...position,
        },
        meta,
        aggregate,
      );
    }
    return null;
  }
}
