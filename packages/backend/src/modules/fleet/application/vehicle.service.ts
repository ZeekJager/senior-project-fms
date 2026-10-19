import type { PoolClient } from 'pg';
import { depotScope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { Cache } from '../../../shared/cache/cache';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  canTransition,
  invalidStatusTransition,
  vehicleUnderWay,
  type AvailabilityWindow,
  type StatusChangeSource,
  type StatusChangeWarning,
  type VehicleStatusView,
} from '../domain/availability';
import type { AvailabilityService } from './availability.service';
import type { Caller } from './caller';
import {
  VEHICLE_EVENTS,
  depotNotFound,
  fuelEfficiencyRequired,
  odometerRegression,
  requiresFuelEfficiency,
  vehicleInUse,
  vehicleNotFound,
  vehicleRetired,
  type FuelType,
  type VehicleStatus,
  type VehicleTrip,
  type VehicleType,
  type VehicleView,
} from '../domain/vehicle';
import type { availabilityStore } from '../infrastructure/availability.repository';
import type { LockedVehicle, VehicleListQuery, VehicleRepository, VehicleWrite } from '../infrastructure/vehicle.repository';

export type { Caller } from './caller';

/** Fields of POST /vehicles, after validation and normalization. */
export interface VehicleCreate {
  registration_number: string;
  vin?: string | null;
  make: string;
  model: string;
  year?: number | null;
  vehicle_type: VehicleType;
  fuel_type: FuelType;
  fuel_efficiency_ml_per_km?: number | null;
  /** The depot's public id. */
  depot_id: string;
  odometer_km?: number;
}

/** Fields of PATCH /vehicles/{id}: any subset of the writable ones. */
export type VehicleUpdate = Partial<VehicleCreate>;

export interface VehicleServiceDeps {
  vehicles: Pick<
    VehicleRepository,
    | 'inTransaction'
    | 'findView'
    | 'findViewWithDepot'
    | 'findViewById'
    | 'list'
    | 'resolveDepot'
    | 'lockForWrite'
    | 'lockById'
    | 'hasActiveAssignment'
    | 'insert'
    | 'update'
    | 'retire'
    | 'findRef'
    | 'setStatus'
    | 'recordStatusChange'
    | 'lastStatusChange'
  >;
  /**
   * The trip module's answers (through its index.ts): is the vehicle on an
   * assigned or en-route trip, and which (en route first). Read live, not from
   * the read model: taking a vehicle off the road must see a trip that started
   * a moment ago.
   */
  trips: {
    vehicleHasActiveTrip(db: Queryable, vehicleId: string): Promise<boolean>;
    activeTripsForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, VehicleTrip>>;
  };
  events: EventBus;
  /** GET /vehicles/{id} reads through it (FMS-72); writes invalidate after commit. */
  cache: Cache;
  availability: AvailabilityService;
  assignments: Pick<typeof availabilityStore, 'vehicleAssignments' | 'assignedAfter'>;
  /** Public ids of users by internal id (the auth module): who changed a status. */
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  /** The maintenance module's open record behind a flag, connected by src/modules/index.ts (maintenance imports fleet). */
  maintenance: () => { openRecordFor(db: Queryable, vehicleId: string): Promise<string | null> } | null;
  now?: () => Date;
}

/**
 * How long a cached vehicle may be served. Writes through this service,
 * maintenance events and a trip's assignment, start, end and cancellation
 * (fleet.vehicle-cache) invalidate it at once; the TTL bounds what nothing
 * invalidates yet (a reschedule's new start time).
 */
export const VEHICLE_CACHE_TTL_SECONDS = 60;

interface CachedVehicle {
  view: VehicleView;
  /** Internal: checked against the caller's depot scope. */
  depotId: string;
}

/** JSON loses Dates: put them back. */
function reviveVehicle(raw: unknown): CachedVehicle | null {
  if (raw === null) return null;
  const entry = raw as CachedVehicle;
  const view = entry.view;
  return {
    depotId: entry.depotId,
    view: {
      ...view,
      created_at: new Date(view.created_at),
      updated_at: new Date(view.updated_at),
      current_trip: view.current_trip
        ? { ...view.current_trip, scheduled_start: view.current_trip.scheduled_start ? new Date(view.current_trip.scheduled_start) : null }
        : null,
    },
  };
}

/**
 * Register, update and retire vehicles (FMS-15). Every write is limited to
 * the caller's depot scope, writes one audit row, and writes its event into
 * the outbox in the same transaction (delivered after commit, FMS-73).
 */
export class VehicleService {
  constructor(private readonly deps: VehicleServiceDeps) {}

  list(caller: Caller, query: VehicleListQuery): Promise<{ items: VehicleView[]; total: number }> {
    const { vehicles } = this.deps;
    return vehicles.inTransaction((client) => vehicles.list(client, query, depotScope(caller.user)));
  }

  /**
   * GET /vehicles/{id}. Fleet-wide and depot-scoped callers read through the
   * cache (a hit needs no PostgreSQL, the depot scope is checked against the
   * cached depot); a driver's own-vehicle scope reads PostgreSQL. Out of
   * scope or unknown: 404 either way.
   */
  async get(caller: Caller, vehicleId: string): Promise<VehicleView> {
    const { vehicles, cache } = this.deps;
    const scope = depotScope(caller.user);
    if (scope.kind === 'all' || scope.kind === 'depot') {
      const entry = await cache.getOrSet(
        this.cacheKey(vehicleId),
        VEHICLE_CACHE_TTL_SECONDS,
        () => vehicles.inTransaction((client) => vehicles.findViewWithDepot(client, vehicleId)),
        reviveVehicle,
      );
      if (!entry || (scope.kind === 'depot' && entry.depotId !== scope.depotId)) throw vehicleNotFound();
      return entry.view;
    }
    const view = await vehicles.inTransaction((client) => vehicles.findView(client, vehicleId, scope));
    if (!view) throw vehicleNotFound();
    return view;
  }

  /** Drops a vehicle's cached view; call after the change has committed. */
  async invalidate(vehicleId: string): Promise<void> {
    await this.deps.cache.delete(this.cacheKey(vehicleId));
  }

  private cacheKey(vehicleId: string): string {
    return this.deps.cache.key('fleet', 'vehicle', vehicleId);
  }

  async create(caller: Caller, input: VehicleCreate): Promise<VehicleView> {
    const { vehicles } = this.deps;
    if (requiresFuelEfficiency(input.fuel_type) && input.fuel_efficiency_ml_per_km == null) throw fuelEfficiencyRequired();

    const view = await vehicles.inTransaction(async (client) => {
      const depotId = await this.depotInScope(client, input.depot_id, caller);
      const row = await vehicles.insert(mutationContext(caller), { ...toColumns(input), depot_id: depotId }, client);
      const created = await vehicles.findViewById(client, row.id as string);
      await this.publish(client, caller, VEHICLE_EVENTS.registered, { vehicle_id: created.id, depot_id: created.depot_id });
      return created;
    });
    return view;
  }

  /** `expectedVersion` (from If-Match): refuse with 409 CONFLICT_CONCURRENT_MODIFICATION if the vehicle has changed since. */
  async update(caller: Caller, vehicleId: string, patch: VehicleUpdate, expectedVersion: number | null = null): Promise<VehicleView> {
    const { vehicles } = this.deps;
    const view = await vehicles.inTransaction(async (client) => {
      const current = await vehicles.lockForWrite(client, vehicleId, depotScope(caller.user));
      if (!current) throw vehicleNotFound();
      if (expectedVersion !== null && expectedVersion !== current.version) throw staleVersion();
      if (!current.isActive) throw vehicleRetired();

      // The fuel-efficiency rule holds for the vehicle after the change, so a
      // PATCH that makes an electric vehicle diesel must also give an efficiency.
      const fuelType = patch.fuel_type ?? current.fuelType;
      const efficiency = 'fuel_efficiency_ml_per_km' in patch ? patch.fuel_efficiency_ml_per_km : current.fuelEfficiencyMlPerKm;
      if (requiresFuelEfficiency(fuelType) && efficiency == null) throw fuelEfficiencyRequired();

      // An odometer only goes up; a lower reading needs the correction workflow (api-contract §17).
      if (patch.odometer_km !== undefined && patch.odometer_km < current.odometerKm) throw odometerRegression();

      const data: VehicleWrite = toColumns(patch);
      if (patch.depot_id !== undefined) data.depot_id = await this.depotInScope(client, patch.depot_id, caller);

      await vehicles.update(mutationContext(caller), current.id, data, client);
      const updated = await vehicles.findViewById(client, current.id);
      await this.publish(client, caller, VEHICLE_EVENTS.updated, {
        vehicle_id: updated.id,
        depot_id: updated.depot_id,
        changed_fields: Object.keys(patch).sort(),
      });
      return updated;
    });

    await this.invalidate(view.id);
    return view;
  }

  /**
   * Soft-retires a vehicle (DELETE /vehicles/{id}). Blocked while the vehicle
   * is on an assigned or en-route trip or assigned to a driver. Retiring an
   * already retired vehicle changes nothing and succeeds, so a retried DELETE
   * is safe.
   *
   * The vehicle row stays locked until commit, so the check and the retirement
   * cannot interleave with a change to this vehicle. Trip assignment must lock
   * the vehicle row too (and refuse a retired vehicle), which closes the race
   * from that side.
   */
  async retire(caller: Caller, vehicleId: string): Promise<void> {
    const { vehicles } = this.deps;
    const retired = await vehicles.inTransaction(async (client) => {
      const current = await vehicles.lockForWrite(client, vehicleId, depotScope(caller.user));
      if (!current) throw vehicleNotFound();
      if (!current.isActive) return null;
      return this.retireLocked(client, caller, current, null);
    });

    if (retired) await this.invalidate(retired.id);
  }

  /**
   * The maintenance workflow (FMS-22) on its own transaction, with the vehicle
   * (internal id) already locked: `inWorkshop` says whether any of its work is
   * in progress now. Work starting moves an active vehicle to `maintenance`,
   * unless it is on a trip under way; the last work ending moves it back to
   * `active`, but only if maintenance put it there: a status someone set by
   * hand stays until someone changes it. Recorded and published like any
   * status change, as source `maintenance` with the record. Returns the new
   * status, or null when nothing changed.
   */
  async followWorkshop(client: PoolClient, caller: Caller, vehicleId: string, inWorkshop: boolean, recordId: string): Promise<VehicleStatus | null> {
    const { vehicles, trips } = this.deps;
    const current = await vehicles.lockById(client, vehicleId);
    if (!current || !current.isActive) return null;
    let to: VehicleStatus;
    let reason: string;
    if (inWorkshop) {
      if (current.status !== 'active') return null;
      if ((await trips.activeTripsForVehicles(client, [current.id])).get(current.id)?.status === 'en_route') return null;
      to = 'maintenance';
      reason = 'Maintenance work started.';
    } else {
      if (current.status !== 'maintenance') return null;
      if ((await vehicles.lastStatusChange(client, current.id))?.source !== 'maintenance') return null;
      to = 'active';
      reason = 'Maintenance work finished.';
    }
    await vehicles.setStatus(mutationContext(caller), current.id, to, client);
    const view = await vehicles.findViewById(client, current.id);
    await this.recordStatusChange(client, caller, current, view, to, reason, { source: 'maintenance', maintenanceRecordId: recordId });
    return to;
  }

  /** Retires a locked, live vehicle: in-use check, audited change, status history, VehicleRetired and VehicleStatusChanged. */
  private async retireLocked(client: PoolClient, caller: Caller, current: LockedVehicle, reason: string | null): Promise<VehicleView> {
    const { vehicles, trips } = this.deps;
    if ((await trips.vehicleHasActiveTrip(client, current.id)) || (await vehicles.hasActiveAssignment(client, current.id))) {
      throw vehicleInUse();
    }
    await vehicles.retire(mutationContext(caller), current.id, client);
    const view = await vehicles.findViewById(client, current.id);
    await this.publish(client, caller, VEHICLE_EVENTS.retired, { vehicle_id: view.id, depot_id: view.depot_id });
    await this.recordStatusChange(client, caller, current, view, 'retired', reason);
    return view;
  }

  /**
   * POST /vehicles/{id}/status (FMS-76): active, maintenance, inactive (out of
   * service) or retired, with a reason. Allowed moves are STATUS_TRANSITIONS;
   * retired is final, and retiring has the same in-use rule as DELETE. A
   * vehicle under way cannot be taken off the road (409 naming the trip); one
   * with trips assigned ahead can, and each such trip comes back as a warning.
   * The same status again changes nothing. Every change is audited, kept in
   * fleet.vehicle_status_history with its reason, and published as
   * VehicleStatusChanged.
   */
  async changeStatus(
    caller: Caller,
    vehicleId: string,
    input: { status: VehicleStatus; reason: string },
    expectedVersion: number | null = null,
  ): Promise<{ status: VehicleStatusView; warnings: StatusChangeWarning[] }> {
    const { vehicles, trips } = this.deps;
    const warnings: StatusChangeWarning[] = [];
    const changed = await vehicles.inTransaction(async (client) => {
      const current = await vehicles.lockForWrite(client, vehicleId, depotScope(caller.user));
      if (!current) throw vehicleNotFound();
      if (expectedVersion !== null && expectedVersion !== current.version) throw staleVersion();
      if (input.status === current.status) return false;
      if (!canTransition(current.status, input.status)) throw invalidStatusTransition(current.status, input.status);

      if (input.status === 'retired') {
        await this.retireLocked(client, caller, current, input.reason);
        return true;
      }
      if (input.status !== 'active') {
        const trip = (await trips.activeTripsForVehicles(client, [current.id])).get(current.id);
        if (trip?.status === 'en_route') throw vehicleUnderWay(trip.id);
        for (const ahead of await this.deps.assignments.assignedAfter(client, current.id, this.now())) {
          warnings.push({ warning: 'ASSIGNED_TRIP_AFFECTED', trip_id: ahead.tripId, start: ahead.start });
        }
      }
      await vehicles.setStatus(mutationContext(caller), current.id, input.status, client);
      const view = await vehicles.findViewById(client, current.id);
      await this.recordStatusChange(client, caller, current, view, input.status, input.reason);
      return true;
    });
    if (changed) await this.invalidate(vehicleId);
    return { status: await this.status(caller, vehicleId), warnings };
  }

  /**
   * GET /vehicles/{id}/status (FMS-76): status, maintenance, availability for
   * a window (default: now), the trip under way or next, and the last status
   * change. Same scope as GET /vehicles/{id}: out of scope is 404.
   */
  async status(caller: Caller, vehicleId: string, window?: AvailabilityWindow): Promise<VehicleStatusView> {
    const { vehicles, availability, assignments } = this.deps;
    const now = this.now();
    const span = window ?? { start: now, end: now };
    return vehicles.inTransaction(async (client) => {
      const ref = await vehicles.findRef(client, { publicId: vehicleId }, depotScope(caller.user));
      if (!ref) throw vehicleNotFound();
      const view = await vehicles.findViewById(client, ref.id);
      const answer = (await availability.check(client, { vehicleIds: [ref.id], window: span })).vehicles.get(ref.id)!;
      const { current, next } = await assignments.vehicleAssignments(client, ref.id, now);
      const last = await vehicles.lastStatusChange(client, ref.id);
      const changedBy = last?.changedBy ? ((await this.deps.users.findByIds(client, [last.changedBy]))[0]?.publicId ?? null) : null;
      const openRecord = view.maintenance_flag ? ((await this.deps.maintenance()?.openRecordFor(client, ref.id)) ?? null) : null;
      const assignment = (a: typeof current) => (a ? { trip_id: a.tripId, status: a.status, start: a.start, end: a.end } : null);
      return {
        vehicle_id: view.id,
        registration_number: view.registration_number,
        depot_id: view.depot_id,
        status: view.status,
        maintenance: { flagged: view.maintenance_flag, in_workshop: view.status === 'maintenance', open_record_id: openRecord },
        availability: { ...answer, window: { start: span.start, end: span.end } },
        current_assignment: assignment(current),
        next_assignment: assignment(next),
        last_status_change: last
          ? {
              from_status: last.fromStatus,
              to_status: last.toStatus,
              reason: last.reason,
              source: last.source,
              maintenance_record_id: last.maintenanceRecordId,
              changed_at: last.changedAt,
              changed_by: changedBy,
            }
          : null,
        version: view.version,
        updated_at: view.updated_at,
      };
    });
  }

  /** History row, then VehicleStatusChanged, on the change's transaction. */
  private async recordStatusChange(
    client: PoolClient,
    caller: Caller,
    before: LockedVehicle,
    after: VehicleView,
    to: VehicleStatus,
    reason: string | null,
    origin: { source: StatusChangeSource; maintenanceRecordId: string | null } = { source: 'manual', maintenanceRecordId: null },
  ): Promise<void> {
    const ctx = mutationContext(caller);
    const row = await this.deps.vehicles.recordStatusChange(ctx, { vehicleId: before.id, from: before.status, to, reason, changedBy: caller.user.id, ...origin }, client);
    await this.publish(client, caller, VEHICLE_EVENTS.statusChanged, {
      vehicle_id: after.id,
      depot_id: after.depot_id,
      previous_status: before.status,
      new_status: to,
      changed_at: (row.changed_at as Date).toISOString(),
      changed_by: caller.user.publicId,
      reason,
      source: origin.source,
      maintenance_record_id: origin.maintenanceRecordId,
    });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** A depot the caller may put vehicles in, or 400: an unknown depot and one outside the scope look the same. */
  private async depotInScope(client: PoolClient, depotPublicId: string, caller: Caller): Promise<string> {
    const depotId = await this.deps.vehicles.resolveDepot(client, depotPublicId, depotScope(caller.user));
    if (!depotId) throw depotNotFound();
    return depotId;
  }

  /** Into the outbox on the change's transaction (FMS-73); ordered per vehicle. */
  private publish(client: PoolClient, caller: Caller, type: string, payload: { vehicle_id: string } & Record<string, unknown>): Promise<void> {
    const ctx = { actor: caller.user.publicId, correlationId: caller.correlationId };
    return this.deps.events.publish(client, [createEvent(type, payload, ctx, { aggregate: aggregateKey('vehicle', payload.vehicle_id) })]);
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

/** API field names to fleet.vehicles columns. `depot_id` is resolved separately (public id to internal id). */
function toColumns(input: VehicleUpdate): VehicleWrite {
  const data: VehicleWrite = {};
  if (input.registration_number !== undefined) data.registration_number = input.registration_number;
  if (input.vin !== undefined) data.vin = input.vin;
  if (input.make !== undefined) data.make = input.make;
  if (input.model !== undefined) data.model = input.model;
  if (input.year !== undefined) data.model_year = input.year;
  if (input.vehicle_type !== undefined) data.vehicle_type = input.vehicle_type;
  if (input.fuel_type !== undefined) data.fuel_type = input.fuel_type;
  if (input.fuel_efficiency_ml_per_km !== undefined) data.fuel_efficiency_ml_per_km = input.fuel_efficiency_ml_per_km;
  if (input.odometer_km !== undefined) data.odometer_km = input.odometer_km;
  return data;
}
