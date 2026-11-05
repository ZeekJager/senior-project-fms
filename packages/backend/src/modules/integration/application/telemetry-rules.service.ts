import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { notFound, validationFailed } from '../../../shared/errors/app-error';
import type { DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  evaluatePings,
  FLAG_SEVERITY,
  INITIAL_STATE,
  MAX_PING_GAP_MS,
  type RuleAction,
  type RuleThresholds,
} from '../domain/telemetry-rules';
import type { RuleStateStore } from '../infrastructure/rule-state.store';
import type { TelemetryFlagRepository } from '../infrastructure/telemetry-flag.repository';
import type { TrackingRepository } from '../infrastructure/tracking.repository';
import { publishFlagChanges, type FlagChange, type RulesVehicle } from './flag-events';

export type { RulesVehicle } from './flag-events';

/** What the rules need from fleet and trip (connected in integration/index.ts). */
export interface TelemetryRulesRefs {
  vehicles: { byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<RulesVehicle[]> };
  trips: { partiesByIds(db: Queryable, tripIds: readonly string[]): Promise<Map<string, { publicId: string; driverId: string | null }>> };
  drivers: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
}

export interface TelemetryRulesServiceDeps {
  /** For reads outside an event's transaction (GET /vehicles/{vehicle_id}/telemetry-flags). */
  db: Queryable;
  tracking: TrackingRepository;
  flags: TelemetryFlagRepository;
  state: RuleStateStore;
  refs: TelemetryRulesRefs;
  events: EventBus;
  now?: () => number;
}

/** At most this many pings are read for one event; the rest wait for the vehicle's next event. */
export const MAX_PINGS_PER_RUN = 1000;
/**
 * Thresholds are re-read from the database at most this often per depot. A change from the settings screen
 * (FMS-80) clears them at once on the instance that saved it; the others follow within this.
 */
export const THRESHOLDS_TTL_MS = 30_000;

/** A flag as GET /vehicles/{vehicle_id}/telemetry-flags returns it. */
export interface TelemetryFlagView {
  flag_id: string;
  vehicle_id: string;
  trip_id: string | null;
  flag_type: string;
  /** The fence of a geofence violation (FMS-90), or null. */
  geofence: { geofence_id: string; name: string } | null;
  severity: string;
  status: string;
  observed_at: string;
  resolved_at: string | null;
  details: Record<string, unknown>;
}

export interface FlagQuery {
  types: string[] | null;
  from: Date | null;
  to: Date | null;
  ongoing: boolean | null;
  limit: number;
}

/**
 * The telemetry rules (FMS-46): on each VehicleLocationUpdated, the vehicle's pings since the last ones checked
 * go through the speeding and idling rules (domain/telemetry-rules.ts), in recorded order. Flags open and close
 * in tracking.telemetry_flags, each with TelemetryFlagRaised or TelemetryFlagResolved, on the event's
 * transaction. The counters between pings are kept in Redis, so a restart does not reset them.
 */
export class TelemetryRulesService {
  private readonly now: () => number;
  private readonly thresholdCache = new Map<string, { value: RuleThresholds; until: number }>();

  constructor(private readonly deps: TelemetryRulesServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The consumer of VehicleLocationUpdated. Pings up to the announced one are read: ingestion announces a
   * vehicle at most once per interval, so one event may cover several pings. An event handled again (at least
   * once delivery) starts from the counters before it, so it decides the same.
   */
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

    const t = await this.thresholds(tx, vehicle.depotId);
    const lookbackMs = t.idleMinutes * 60_000 + MAX_PING_GAP_MS;
    const pings = await tracking.pingsBetween(tx, vehicle.id, base?.lastAt != null ? new Date(base.lastAt) : null, new Date(upTo), lookbackMs, MAX_PINGS_PER_RUN);
    if (pings.length === 0) return;

    const open = await flags.ongoingTypes(tx, vehicle.id);
    const { state: next, actions } = evaluatePings(base ?? INITIAL_STATE, open, pings, t);
    const changes = await this.apply(tx, vehicle.id, actions);
    await publishFlagChanges(tx, this.deps, vehicle, changes, event.correlation_id);
    await state.save(vehiclePublicId, { eventId: event.id, before: base, after: next });
  }

  /** GET /vehicles/{vehicle_id}/telemetry-flags: a vehicle's flags in the caller's depot scope, newest first. */
  async listForVehicle(user: RequestUser, vehiclePublicId: string, query: FlagQuery): Promise<TelemetryFlagView[]> {
    const { db, refs, flags } = this.deps;
    if (query.from && query.to && query.from >= query.to) throw validationFailed([{ field: 'to', reason: 'before_from' }], '`to` must be after `from`.');
    const [vehicle] = await refs.vehicles.byPublicIds(db, [vehiclePublicId], depotScope(user));
    if (!vehicle) throw notFound('Vehicle not found.');
    const rows = await flags.listForVehicle(db, vehicle.id, query);
    const trips = await refs.trips.partiesByIds(db, [...new Set(rows.flatMap((r) => (r.tripId ? [r.tripId] : [])))]);
    return rows.map((r) => ({
      flag_id: r.publicId,
      vehicle_id: vehicle.publicId,
      trip_id: r.tripId ? (trips.get(r.tripId)?.publicId ?? null) : null,
      flag_type: r.flagType,
      geofence: r.geofencePublicId ? { geofence_id: r.geofencePublicId, name: r.geofenceName ?? '' } : null,
      severity: r.severity,
      status: r.status,
      observed_at: r.observedAt.toISOString(),
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      details: r.details,
    }));
  }

  /** Forgets the cached thresholds, after a change (FMS-80): the next ping reads them again. */
  forgetThresholds(): void {
    this.thresholdCache.clear();
  }

  /** Thresholds for a depot, cached for THRESHOLDS_TTL_MS: they change rarely, and pings arrive every few seconds. */
  private async thresholds(db: Queryable, depotId: string | null): Promise<RuleThresholds> {
    const key = depotId ?? 'fleet';
    const hit = this.thresholdCache.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const value = await this.deps.flags.thresholds(db, depotId);
    this.thresholdCache.set(key, { value, until: this.now() + THRESHOLDS_TTL_MS });
    return value;
  }

  /** Writes the flags the rules decided. One the database already had (or had already closed) changes nothing. */
  private async apply(tx: PoolClient, vehicleId: string, actions: readonly RuleAction[]): Promise<FlagChange[]> {
    const changes: FlagChange[] = [];
    for (const action of actions) {
      if (action.kind === 'raise') {
        const flag = await this.deps.flags.raise(tx, {
          vehicleId,
          flagType: action.flagType,
          severity: FLAG_SEVERITY[action.flagType],
          observedAt: new Date(action.observedAt),
          ping: action.ping,
          details: action.details,
        });
        if (flag) changes.push({ kind: 'raised', flag });
      } else {
        const flag = await this.deps.flags.resolve(tx, vehicleId, action.flagType, new Date(action.resolvedAt), action.reason);
        if (flag) changes.push({ kind: 'resolved', flag });
      }
    }
    return changes;
  }
}
