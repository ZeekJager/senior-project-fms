import type { PoolClient } from 'pg';
import { depotScope, ownDriverScope } from '../../../shared/authz/scope';
import type { AppError } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  ASSIGNABLE_STATUSES,
  OPEN_STATUSES,
  TRIP_EVENTS,
  assignmentRefNotFound,
  cannotCancelEnRoute,
  depotMismatch,
  driverNotEligible,
  driverOverlap,
  notAssignable,
  vehicleFlagged,
  vehicleNotActive,
  vehicleOverlap,
  type AssignmentWarning,
  decodeCursor,
  encodeCursor,
  invalidDateRange,
  LIVE_POSITION_STALE_MS,
  stopNotFound,
  tripClosed,
  tripNotFound,
  tripNotUnderWay,
  type TripLiveState,
  type TripStopView,
  tripRouteNotFound,
  tripRouteRetired,
  type TripStatus,
  type TripSummary,
  type TripView,
} from '../domain/trip';
import type { RequestUser } from '../../../types/express';
import type { StopRow, TripRepository, TripRow, TripVisibility, TripWrite } from '../infrastructure/trip.repository';
import { distanceWrite, type TripDistanceService } from './distance.service';
import { readAvailability, type AvailabilityRefusal } from '../domain/assignment';
import {
  DEFAULT_EXCEPTION_POLICIES,
  approvalRequired,
  exceptionDecided,
  exceptionNotFound,
  exceptionOutdated,
  heldWarnings,
  ownRequest,
  uncovered,
  type AssignmentExceptionView,
  type ExceptionPolicies,
} from '../domain/exception';
import type { AssignmentExceptionRepository, ExceptionRow } from '../infrastructure/assignment-exception.repository';
import { cargoFixed, jobLoad, overPayload, type CargoKind } from '../domain/job-load';
import { assignRequired, canMove, dispatchOnly, invalidTripTransition, scheduleRequired, type CommandStatus } from '../domain/lifecycle';
import type { Caller, FleetRefs, MaintenanceRefs } from './route.service';
import type { Coordinates, RouteStop } from '../domain/route';
import type { RouteRepository } from '../infrastructure/route.repository';
import {
  MAX_SHIFTED,
  RESCHEDULABLE_STATUSES,
  STAFFED_STATUSES,
  endRequired,
  reasonRequired,
  scheduleClash,
  shiftNeeded,
  shiftedBy,
  startFixed,
  adhocDepotRequired,
  tooManyShifted,
  type Slot,
} from '../domain/schedule';

/** A vehicle's newest position as GET /trips/{id}/live shows it (FMS-95), from tracking.vehicle_current_location. */
export interface LivePosition {
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  recordedAt: Date;
}

export type PositionLookup = (db: Queryable, vehicleId: string) => Promise<LivePosition | null>;

/** A trip nobody planned (FMS-139): where it goes, saved as a one-off route of the depot. */
export interface AdhocRoute {
  origin_name: string;
  origin?: Coordinates | null;
  destination_name: string;
  destination?: Coordinates | null;
  stops?: RouteStop[];
}

export interface TripCreate {
  /** Public id of an active route in the caller's depots. Its plan (ends, distance, time, stops) is copied onto the trip. */
  route_id?: string;
  /** Instead of route_id (FMS-139): a one-off route, in `depot_id` (default: the caller's own depot). */
  route?: AdhocRoute;
  depot_id?: string;
  scheduled_start: Date;
  /** Default: the start plus the route's estimated time; required when the route has none. */
  scheduled_end?: Date;
  /** What it carries (FMS-153): optional; `general` when not given. */
  cargo_weight_kg?: number | null;
  cargo_kind?: CargoKind;
}

/** PATCH: reschedule, or cancel with status "cancelled". Driver and vehicle are set by assignment (FMS-31). */
export interface TripUpdate {
  scheduled_start?: Date;
  scheduled_end?: Date;
  status?: 'cancelled';
  /** Why the times change (FMS-139): required once a driver or vehicle waits on them (assigned, en route). */
  reason?: string;
  /** Move the trips this change runs into later instead of refusing it (FMS-139). */
  shift_following?: boolean;
  /** The cargo (FMS-153), before the trip starts; null clears the weight. Never above the assigned vehicle's payload. */
  cargo_weight_kg?: number | null;
  cargo_kind?: CargoKind;
}

/** A trip moved later because a change ran into it (FMS-139). */
export interface ShiftedTrip {
  trip_id: string;
  scheduled_start: string;
  scheduled_end: string;
}

export interface TripHistoryQuery {
  status?: TripStatus[];
  driver_id?: string;
  vehicle_id?: string;
  route_id?: string;
  depot_id?: string;
  from?: Date;
  to?: Date;
  sort_order: 'asc' | 'desc';
  page_size: number;
  cursor?: string;
}

/** POST /trips/{id}/assign: who drives what, against the version the dispatcher saw. */
export interface TripAssignment {
  driver_id: string;
  vehicle_id: string;
  version: number;
  /** Why, when the assignment raises a warning the depot holds for approval (FMS-151): the request is sent with it. */
  exception_reason?: string;
}

/** A depot's exception policies (FMS-151): its own, else the fleet's. The integration module's (it keeps the thresholds). */
export type ExceptionPolicyLookup = (db: Queryable, depotId: string | null) => Promise<ExceptionPolicies>;

/** The users named on a request (FMS-151): public ids and names, by internal id. The auth module's directory. */
export interface UserNames {
  findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]>;
}

/**
 * POST /trips/{id}/assign: the trip assigned with its warnings, or (`exception`) the assignment held for approval
 * (FMS-151): the trip unchanged, and the warnings held.
 */
export interface AssignOutcome {
  trip: TripView;
  warnings: AssignmentWarning[];
  exception: AssignmentExceptionView | null;
}

type ExceptionStore = Pick<AssignmentExceptionRepository, 'latestByTrips' | 'find' | 'lock' | 'pendingOf' | 'insert' | 'update'>;

/** Without the store (unit tests): no requests, and none can be made, as nothing holds an assignment without policies. */
const NO_EXCEPTIONS: ExceptionStore = {
  latestByTrips: async () => [],
  find: async () => null,
  lock: () => Promise.reject(new Error('trip: no exception store')),
  pendingOf: async () => null,
  insert: () => Promise.reject(new Error('trip: no exception store')),
  update: () => Promise.reject(new Error('trip: no exception store')),
};

export interface TripServiceDeps {
  trips: Pick<
    TripRepository,
    | 'inTransaction'
    | 'history'
    | 'findVisible'
    | 'findById'
    | 'stops'
    | 'etas'
    | 'routePlan'
    | 'routeId'
    | 'insert'
    | 'update'
    | 'insertStop'
    | 'overlapping'
    | 'underWay'
    | 'clashing'
    | 'lockStop'
    | 'completeStop'
  >;
  /**
   * The vehicles' newest positions (internal vehicle ids), for GET /trips/{id}/live (FMS-95): the integration module's,
   * connected by src/modules/index.ts (it imports trip). Null when not connected: the live state has no position.
   */
  positions?: () => PositionLookup | null;
  /** Measures a trip's distance as it ends (FMS-145). Absent (unit tests): the trip ends unmeasured, for the job. */
  distance?: Pick<TripDistanceService, 'measure'>;
  /** One-off routes for unplanned trips (FMS-139). */
  routes: Pick<RouteRepository, 'insert'>;
  /** Assignments held for approval (FMS-151). Absent (unit tests): none. */
  exceptions?: ExceptionStore;
  /** Each depot's exception policies (FMS-151), connected by src/modules/index.ts; not connected, every warning only warns. */
  policies?: () => ExceptionPolicyLookup | null;
  /** Names of who asked and who decided (FMS-151). Absent (unit tests): none. */
  users?: UserNames;
  /** The fleet and maintenance modules' lookups, connected by src/modules/index.ts. */
  fleet: () => FleetRefs;
  maintenance: () => MaintenanceRefs;
  events: EventBus;
  /** Minutes a driver or vehicle needs after a trip under way before the next (TRIP_OVERRUN_GRACE_MINUTES). */
  overrunGraceMinutes: number;
  now?: () => Date;
}

/**
 * Trips (FMS-30, §9.2): the scheduling record that connects a route, a time
 * window and, once assigned (FMS-31), a driver and a vehicle. A trip is
 * created from a route, whose plan it copies; it is never deleted, and
 * cancelling keeps the row. Staff see their depots' trips (the route's
 * depot); a driver sees only the trips they drive.
 */
export class TripService {
  private readonly exceptions: ExceptionStore;
  private readonly users: UserNames;

  constructor(private readonly deps: TripServiceDeps) {
    this.exceptions = deps.exceptions ?? NO_EXCEPTIONS;
    this.users = deps.users ?? { findByIds: async () => [] };
  }

  /** Trip history, newest first (sort_order=asc for earliest first), with keyset paging. */
  async history(caller: Caller, query: TripHistoryQuery): Promise<{ items: TripView[]; nextCursor: string | null }> {
    if (query.from && query.to && query.to <= query.from) throw invalidDateRange('to', '`to` must be after `from`.');
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const visibility = await this.visibility(client, caller);
      const fleet = this.deps.fleet();
      // Public ids to internal ids: undefined when not filtered, null when not found.
      // A filter naming something unknown (or outside scope) matches nothing: an empty page, not an error.
      // One after another: queries on one client never run concurrently.
      const driverId = query.driver_id ? await fleet.drivers.idOf(client, query.driver_id) : undefined;
      const vehicleId = query.vehicle_id ? await fleet.vehicles.idOf(client, query.vehicle_id) : undefined;
      const routeId = query.route_id ? await trips.routeId(client, query.route_id) : undefined;
      const depotId = query.depot_id ? await fleet.depots.resolveInScope(client, query.depot_id, depotScope(caller.user)) : undefined;
      if ([driverId, vehicleId, routeId, depotId].includes(null)) return { items: [], nextCursor: null };

      const { rows, more } = await trips.history(client, {
        visibility,
        statuses: query.status,
        driverId: driverId ?? undefined,
        vehicleId: vehicleId ?? undefined,
        routeId: routeId ?? undefined,
        depotId: depotId ?? undefined,
        from: query.from,
        to: query.to,
        order: query.sort_order,
        after,
        limit: query.page_size,
      });
      const last = rows[rows.length - 1];
      return { items: await this.views(client, rows), nextCursor: more && last ? encodeCursor({ at: last.at, id: last.id }) : null };
    });
  }

  async get(caller: Caller, tripId: string): Promise<TripView> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller));
      if (!row) throw tripNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /**
   * For other modules (fuel logs name a trip): the trip with this public id if
   * `user` may see it (staff: their depots' trips; a driver: their own), with
   * the internal ids to compare against. Null when missing or out of scope.
   */
  async refVisibleTo(db: Queryable, user: RequestUser, publicId: string): Promise<{ id: string; vehicleId: string | null; driverId: string | null } | null> {
    const row = await this.deps.trips.findVisible(db, publicId, await this.visibility(db, { user, correlationId: '' }));
    return row ? { id: row.id, vehicleId: row.vehicleId, driverId: row.driverId } : null;
  }

  /**
   * For the real-time gateway (FMS-43): the trip's current summary, read with
   * no caller. The gateway decides who receives it from `depot_id` and
   * `driver_id`. Null when there is no such trip.
   */
  async summary(db: Queryable, publicId: string): Promise<TripSummary | null> {
    const row = await this.deps.trips.findVisible(db, publicId, { kind: 'all' });
    if (!row) return null;
    const [v] = await this.views(db, [row]);
    return {
      trip_id: v.id,
      status: v.status,
      route_name: v.route_name,
      depot_id: v.depot_id,
      vehicle_id: v.vehicle_id,
      driver_id: v.driver_id,
      scheduled_start: v.scheduled_start,
      scheduled_end: v.scheduled_end,
      actual_start: v.actual_start,
      actual_end: v.actual_end,
      eta: v.eta,
      version: v.version,
      updated_at: v.updated_at,
    };
  }

  async create(caller: Caller, input: TripCreate): Promise<TripView> {
    if (input.scheduled_end && input.scheduled_end <= input.scheduled_start) throw invalidDateRange('scheduled_end', 'The trip must end after it starts.');
    const { trips } = this.deps;
    const ctx = mutationContext(caller);
    return trips.inTransaction(async (client) => {
      const visibility = await this.visibility(client, caller);
      if (visibility.kind !== 'all' && visibility.kind !== 'depot') throw tripRouteNotFound();
      const routeId = input.route ? await this.adhocRoute(client, caller, input.route, input.depot_id) : input.route_id!;
      const route = await trips.routePlan(client, routeId, visibility.kind === 'depot' ? visibility.depotId : null);
      if (!route) throw tripRouteNotFound();
      if (!route.isActive) throw tripRouteRetired();
      // No end given: the route's estimated time from the start (FMS-139).
      const end = input.scheduled_end ?? (route.estimatedDurationSeconds ? new Date(input.scheduled_start.getTime() + route.estimatedDurationSeconds * 1000) : null);
      if (!end) throw endRequired();

      const row = await trips.insert(
        ctx,
        {
          route_id: route.id,
          status: 'scheduled',
          origin: route.originName,
          destination: route.destinationName,
          planned_distance_km: route.distanceKm,
          planned_duration_seconds: route.estimatedDurationSeconds,
          scheduled_start: input.scheduled_start,
          scheduled_end: end,
          // No vehicle yet: the payload is checked when one is assigned.
          cargo_weight_kg: input.cargo_weight_kg ?? null,
          cargo_kind: input.cargo_kind ?? 'general',
        },
        client,
      );
      const tripId = row.id as string;
      for (const [i, stop] of route.stops.entries()) await trips.insertStop(ctx, tripId, i + 1, stop, client);

      const view = (await this.views(client, [await trips.findById(client, tripId)]))[0];
      await this.deps.events.publish(client, [
        tripEvent(caller, TRIP_EVENTS.created, {
          trip_id: view.id,
          route_id: view.route_id,
          depot_id: view.depot_id,
          scheduled_start: view.scheduled_start?.toISOString() ?? null,
          scheduled_end: view.scheduled_end?.toISOString() ?? null,
        }),
      ]);
      return view;
    });
  }

  /**
   * PATCH /trips/{id}: reschedule a trip (draft, scheduled, assigned; an en-route trip its end only, FMS-139), or
   * cancel it. A draft that gets both times becomes scheduled. A trip under way is ended, not cancelled; a
   * completed or cancelled trip never changes. Once a driver or vehicle waits on the times (assigned, en route),
   * a change needs a reason and may not run into their other trips: it is refused naming the trip, or, with
   * `shift_following`, that trip and any it then runs into move later (docs/flexible-dispatch.md).
   */
  async update(caller: Caller, tripId: string, patch: TripUpdate, expectedVersion: number | null): Promise<{ trip: TripView; shifted: ShiftedTrip[] }> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (row.status === 'en_route' && patch.status === 'cancelled') throw cannotCancelEnRoute();
      // The cargo (FMS-153) is set before the trip starts.
      const recargo = patch.cargo_weight_kg !== undefined || patch.cargo_kind !== undefined;
      if (recargo && !OPEN_STATUSES.includes(row.status)) throw cargoFixed(row.status);
      const retiming = patch.scheduled_start !== undefined || patch.scheduled_end !== undefined;
      if (!(retiming && patch.status === undefined ? RESCHEDULABLE_STATUSES : OPEN_STATUSES).includes(row.status)) throw tripClosed(row.status);
      if (row.status === 'en_route' && patch.scheduled_start && patch.scheduled_start.getTime() !== row.scheduledStart?.getTime()) throw startFixed();

      const start = patch.scheduled_start ?? row.scheduledStart;
      const end = patch.scheduled_end ?? row.scheduledEnd;
      if (start && end && end <= start) throw invalidDateRange('scheduled_end', 'The trip must end after it starts.');
      if (row.status === 'en_route' && end && row.actualStart && end <= row.actualStart) throw invalidDateRange('scheduled_end', 'The trip must end after it started.');

      const data: TripWrite = {};
      if (patch.scheduled_start && patch.scheduled_start.getTime() !== row.scheduledStart?.getTime()) data.scheduled_start = patch.scheduled_start;
      if (patch.scheduled_end && patch.scheduled_end.getTime() !== row.scheduledEnd?.getTime()) data.scheduled_end = patch.scheduled_end;
      const rescheduled = Object.keys(data).sort();
      const staffed = STAFFED_STATUSES.includes(row.status);
      const reason = patch.reason?.trim() || null;
      if (rescheduled.length > 0 && staffed && !reason) throw reasonRequired();
      if (patch.cargo_kind !== undefined && patch.cargo_kind !== row.cargoKind) data.cargo_kind = patch.cargo_kind;
      if (patch.cargo_weight_kg !== undefined && patch.cargo_weight_kg !== row.cargoWeightKg) data.cargo_weight_kg = patch.cargo_weight_kg;
      const recargoed = (['cargo_kind', 'cargo_weight_kg'] as const).filter((f) => f in data);
      // Never more than the assigned vehicle carries, when its payload is recorded.
      if (data.cargo_weight_kg != null && row.vehicleId) {
        const capacity = (await this.deps.fleet().vehicles.payloadCapacities(client, [row.vehicleId])).get(row.vehicleId) ?? null;
        if (capacity !== null && data.cargo_weight_kg > capacity) throw overPayload('cargo_weight_kg', data.cargo_weight_kg, capacity);
      }
      if (patch.status === 'cancelled') data.status = 'cancelled';
      else if (row.status === 'draft' && start && end) data.status = 'scheduled';

      // The trips this change runs into: refused, or moved later first (latest first, so no step overlaps).
      const shifted = rescheduled.length > 0 && staffed && start && end ? await this.shiftPlan(client, row, start, end, patch.shift_following === true) : [];
      const ctx = mutationContext(caller);
      for (const s of [...shifted].sort((a, b) => b.start.getTime() - a.start.getTime())) {
        await trips.update(ctx, s.id, { scheduled_start: s.start, scheduled_end: s.end }, client);
      }
      if (Object.keys(data).length > 0) await trips.update(ctx, row.id, data, client);
      // A cancelled trip's request waiting for approval (FMS-151) is withdrawn.
      if (patch.status === 'cancelled') await this.withdrawPending(client, caller, row.id);
      const view = (await this.views(client, [await trips.findById(client, row.id)]))[0];

      const events: DomainEvent[] = [];
      if (rescheduled.length > 0 || recargoed.length > 0) {
        const changed = [...rescheduled, ...recargoed].sort();
        events.push(tripEvent(caller, TRIP_EVENTS.updated, { trip_id: view.id, changed_fields: changed, status: view.status, ...(reason ? { reason } : {}) }));
      }
      for (const s of shifted) {
        events.push(
          tripEvent(caller, TRIP_EVENTS.updated, {
            trip_id: s.publicId,
            changed_fields: ['scheduled_end', 'scheduled_start'],
            status: s.status,
            reason: `Moved later: trip ${view.id} now ends at ${end!.toISOString()}.${reason ? ` ${reason}` : ''}`,
            shifted_by_trip_id: view.id,
          }),
        );
      }
      if (patch.status === 'cancelled') {
        events.push(tripEvent(caller, TRIP_EVENTS.cancelled, { trip_id: view.id, previous_status: row.status, route_id: view.route_id, driver_id: view.driver_id, vehicle_id: view.vehicle_id }));
      }
      if (events.length > 0) await this.deps.events.publish(client, events);
      return {
        trip: view,
        shifted: shifted.map((s) => ({ trip_id: s.publicId, scheduled_start: s.start.toISOString(), scheduled_end: s.end.toISOString() })),
      };
    });
  }

  /**
   * The trips that must move for `row` to take [start, end] (FMS-139): each assigned trip of the same driver or
   * vehicle it runs into, moved later to start a turnaround after it, and then the trips those run into. Without
   * `shift` the first one is refused (409 naming it and the minutes it would move). A trip under way, or one that
   * starts before this one, cannot be moved: always refused.
   */
  private async shiftPlan(client: Queryable, row: TripRow, start: Date, end: Date, shift: boolean): Promise<Slot[]> {
    const own: Slot = { id: row.id, publicId: row.publicId, driverId: row.driverId, vehicleId: row.vehicleId, status: row.status, start, end };
    const moved = new Map<string, Slot>([[own.id, own]]);
    const queue: Slot[] = [own];
    while (queue.length > 0) {
      const slot = queue.shift()!;
      for (const other of await this.deps.trips.clashing(client, slot.driverId, slot.vehicleId, slot.start, slot.end, [...moved.keys()])) {
        const field = slot.driverId !== null && other.driverId === slot.driverId ? 'driver_id' : 'vehicle_id';
        const shiftMs = shiftNeeded(slot.end, other.start);
        const shiftable = other.status === 'assigned' && other.start.getTime() >= slot.start.getTime();
        if (!shift || !shiftable) throw scheduleClash(field, other, shiftMs, shiftable);
        const later = shiftedBy(other, shiftMs);
        moved.set(later.id, later);
        if (moved.size > MAX_SHIFTED + 1) throw tooManyShifted();
        queue.push(later);
      }
    }
    moved.delete(own.id);
    return [...moved.values()];
  }

  /** A one-off route for an unplanned trip (FMS-139), in a depot of the caller's: its public id. */
  private async adhocRoute(client: PoolClient, caller: Caller, route: AdhocRoute, depotPublicId: string | undefined): Promise<string> {
    const scope = depotScope(caller.user);
    const fleet = this.deps.fleet();
    const depotId = depotPublicId
      ? await fleet.depots.resolveInScope(client, depotPublicId, scope)
      : scope.kind === 'depot'
        ? scope.depotId
        : null;
    if (!depotId) throw adhocDepotRequired(depotPublicId !== undefined);
    const stops = route.stops ?? [];
    const row = await this.deps.routes.insert(
      mutationContext(caller),
      {
        name: `${route.origin_name} → ${route.destination_name}`.slice(0, 255),
        depot_id: depotId,
        origin_name: route.origin_name,
        origin_latitude: route.origin?.latitude ?? null,
        origin_longitude: route.origin?.longitude ?? null,
        destination_name: route.destination_name,
        destination_latitude: route.destination?.latitude ?? null,
        destination_longitude: route.destination?.longitude ?? null,
        stops: JSON.stringify(stops.map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude }))),
        is_adhoc: true,
      },
      client,
    );
    return String(row.public_id);
  }

  /**
   * POST /trips/{id}/assign (FMS-31): a driver and vehicle for a scheduled
   * trip, or new ones for an assigned trip. Checks, in order:
   *
   * - the version the dispatcher saw (409 CONFLICT_CONCURRENT_MODIFICATION);
   * - the vehicle is in scope and active, and BR-2 not flagged for maintenance
   *   (409 CONFLICT_VEHICLE_FLAGGED naming the open record);
   * - the driver is in scope and eligible for this vehicle on the trip's start
   *   (409 CONFLICT_DRIVER_NOT_ELIGIBLE with every reason);
   * - BR-1 and BR-3: neither is on another assigned or en-route trip that
   *   overlaps, touching ends included (409 naming that trip).
   *
   * The trip row is locked first, so two assignments of one trip run one after
   * the other and the second sees the new version. Two trips claiming one
   * driver or vehicle at once both pass the checks; the exclusion constraints
   * reject the second when it saves (409, mapped from 23P01). The vehicle and
   * driver rows are share-locked, so a maintenance flag or a retirement cannot
   * land in between.
   *
   * A trip still under way that runs into this one is a warning, never a block.
   */
  async assign(caller: Caller, tripId: string, input: TripAssignment): Promise<AssignOutcome> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      if (input.version !== row.version) throw staleVersion();
      const checked = await this.checkAssignment(client, caller, row, input.driver_id, input.vehicle_id);
      const ctx = mutationContext(caller);

      // FMS-151: a warning the depot holds is an exception a fleet manager approves, with the dispatcher's reason.
      const held = heldWarnings(checked.warnings, await this.policiesFor(client, row.depotId));
      if (held.length > 0) {
        const reason = input.exception_reason?.trim();
        if (!reason) throw approvalRequired(held);
        // A new request replaces the one waiting.
        await this.withdrawPending(client, caller, row.id);
        const created = await this.exceptions.insert(
          ctx,
          {
            trip_id: row.id,
            driver_id: checked.driver.id,
            vehicle_id: checked.vehicle.id,
            warnings: JSON.stringify(held),
            reason,
            requested_by: caller.user.id,
          },
          client,
        );
        const view = (await this.views(client, [row]))[0];
        const exception = view.exception!;
        await this.deps.events.publish(client, [
          tripEvent(caller, TRIP_EVENTS.exceptionRequested, {
            trip_id: view.id,
            exception_id: String(created.public_id),
            depot_id: view.depot_id,
            proposed_driver_id: input.driver_id,
            proposed_vehicle_id: input.vehicle_id,
            warnings: held.map((w) => w.warning),
            reason,
            scheduled_start: checked.start.toISOString(),
            route_name: view.route_name,
          }),
        ]);
        return { trip: view, warnings: held, exception };
      }

      // Assigned without needing approval: a request still waiting is moot.
      await this.withdrawPending(client, caller, row.id);
      const view = await this.applyAssignment(client, caller, row, checked, null);
      return { trip: view, warnings: checked.warnings, exception: null };
    });
  }

  /**
   * POST /assignment-exceptions/{id}/approve (FMS-151): a fleet manager approves a held assignment, and the trip is
   * assigned to the driver and vehicle asked for. Every rule is checked again now: a safety rule refuses as an
   * assignment would, and a held warning the request did not ask about is 409 (refuse it; the dispatcher asks again).
   * Never by the one who asked. The approval covers that trip and those warnings only.
   */
  async approveException(caller: Caller, exceptionId: string, note: string | undefined): Promise<{ exception: AssignmentExceptionView; trip: TripView; warnings: AssignmentWarning[] }> {
    return this.decide(caller, exceptionId, async (client, row, ex) => {
      if (ex.requestedBy !== null && String(ex.requestedBy) === String(caller.user.id)) throw ownRequest();
      const fleet = this.deps.fleet();
      const driverPublicId = (await fleet.drivers.publicIds(client, [ex.driverId])).get(ex.driverId)!;
      const vehiclePublicId = (await fleet.vehicles.publicIds(client, [ex.vehicleId])).get(ex.vehicleId)!;
      const checked = await this.checkAssignment(client, caller, row, driverPublicId, vehiclePublicId);
      const missing = uncovered(heldWarnings(checked.warnings, await this.policiesFor(client, row.depotId)), ex.warnings);
      if (missing.length > 0) throw exceptionOutdated(missing);
      await this.exceptions.update(
        mutationContext(caller),
        ex.id,
        { status: 'approved', decided_by: caller.user.id, decided_at: this.now(), decision_reason: note?.trim() || null },
        client,
      );
      const trip = await this.applyAssignment(client, caller, row, checked, ex.publicId);
      return { trip, warnings: checked.warnings, decision: 'approved' };
    });
  }

  /** POST /assignment-exceptions/{id}/refuse (FMS-151): the trip stays as it is; the dispatchers are told why. */
  async refuseException(caller: Caller, exceptionId: string, reason: string): Promise<{ exception: AssignmentExceptionView; trip: TripView; warnings: AssignmentWarning[] }> {
    return this.decide(caller, exceptionId, async (client, row, ex) => {
      await this.exceptions.update(
        mutationContext(caller),
        ex.id,
        { status: 'refused', decided_by: caller.user.id, decided_at: this.now(), decision_reason: reason.trim() },
        client,
      );
      return { trip: (await this.views(client, [await this.deps.trips.findById(client, row.id)]))[0], warnings: [], decision: 'refused' };
    });
  }

  /**
   * A decision on a waiting request: the trip locked first (as an assignment locks it), in the caller's depots
   * (else 404), then the request; one already decided is 409. AssignmentExceptionDecided goes out with it.
   */
  private async decide(
    caller: Caller,
    exceptionId: string,
    step: (client: PoolClient, row: TripRow, ex: ExceptionRow) => Promise<{ trip: TripView; warnings: AssignmentWarning[]; decision: 'approved' | 'refused' }>,
  ): Promise<{ exception: AssignmentExceptionView; trip: TripView; warnings: AssignmentWarning[] }> {
    const { trips } = this.deps;
    const { exceptions } = this;
    return trips.inTransaction(async (client) => {
      const found = await exceptions.find(client, exceptionId);
      if (!found) throw exceptionNotFound();
      const row = await trips.findVisible(client, found.tripPublicId, await this.visibility(client, caller), true);
      if (!row) throw exceptionNotFound();
      const ex = await exceptions.lock(client, found.id);
      if (ex.status !== 'pending') throw exceptionDecided(ex.status);
      const { trip, warnings, decision } = await step(client, row, ex);
      const [exception] = await this.exceptionViews(client, [await exceptions.lock(client, ex.id)]);
      await this.deps.events.publish(client, [
        tripEvent(caller, TRIP_EVENTS.exceptionDecided, {
          trip_id: trip.id,
          exception_id: ex.publicId,
          depot_id: trip.depot_id,
          decision,
          reason: exception.decision_reason,
          requested_by: exception.requested_by,
          route_name: trip.route_name,
          scheduled_start: trip.scheduled_start?.toISOString() ?? null,
        }),
      ]);
      return { exception, trip, warnings };
    });
  }

  /** The trip's request still waiting, withdrawn: a new request, an assignment that needs none, or a cancelled trip. */
  private async withdrawPending(client: PoolClient, caller: Caller, tripId: string): Promise<void> {
    const pending = await this.exceptions.pendingOf(client, tripId);
    if (pending) await this.exceptions.update(mutationContext(caller), pending.id, { status: 'withdrawn', decided_by: caller.user.id, decided_at: this.now() }, client);
  }

  private async policiesFor(db: Queryable, depotId: string | null): Promise<ExceptionPolicies> {
    const lookup = this.deps.policies?.() ?? null;
    return lookup ? lookup(db, depotId) : DEFAULT_EXCEPTION_POLICIES;
  }

  /**
   * Every assignment rule for this driver and vehicle on the trip (FMS-31), on the locked trip row: the safety
   * rules throw; the warnings come back. Read the same way for an assignment and for an approval (FMS-151).
   */
  private async checkAssignment(client: PoolClient, caller: Caller, row: TripRow, driverPublicId: string, vehiclePublicId: string) {
    const { trips } = this.deps;
    if (!ASSIGNABLE_STATUSES.includes(row.status) || !row.scheduledStart || !row.scheduledEnd) throw notAssignable(row.status);
    const start = row.scheduledStart;
    const end = row.scheduledEnd;
    const scope = depotScope(caller.user);
    const fleet = this.deps.fleet();

    // Share-locked: a maintenance flag, status change or retirement cannot land mid-assignment.
    const vehicle = await fleet.vehicles.forAssignment(client, vehiclePublicId, scope);
    if (!vehicle) throw assignmentRefNotFound('vehicle_id');
    // FMS-153: never more cargo than the vehicle carries. A safety rule: never held for approval (FMS-151).
    if (row.cargoWeightKg !== null && vehicle.payloadCapacityKg !== null && row.cargoWeightKg > vehicle.payloadCapacityKg) {
      throw overPayload('vehicle_id', row.cargoWeightKg, vehicle.payloadCapacityKg);
    }
    const driver = await fleet.drivers.forAssignment(client, driverPublicId, scope);
    if (!driver) throw assignmentRefNotFound('driver_id');

    // Fleet availability (FMS-76), read on this transaction after the locks: the
    // vehicle's status and flag (BR-2), the trip's depot, the driver's attendance.
    // At the trip's start: what it reads here does not depend on the window's end.
    const answer = await fleet.availability.check(client, {
      vehicleIds: [vehicle.id],
      driverIds: [driver.id],
      window: { start, end: start },
      excludeTripId: row.publicId,
      ...(row.depotId ? { depotId: row.depotId } : {}),
    });
    const availability = readAvailability(answer.vehicles.get(vehicle.id)!, answer.drivers.get(driver.id)!);
    if (availability.refusal) throw await this.refusal(client, availability.refusal, vehicle.id);

    const eligibility = await fleet.drivers.eligibility(client, driver.id, start, vehicle.id);
    if (!eligibility.eligible) throw driverNotEligible(eligibility.reasons);

    const driverClash = await trips.overlapping(client, 'driver_id', driver.id, start, end, row.id);
    if (driverClash) throw driverOverlap(driverClash);
    const vehicleClash = await trips.overlapping(client, 'vehicle_id', vehicle.id, start, end, row.id);
    if (vehicleClash) throw vehicleOverlap(vehicleClash);

    const warnings: AssignmentWarning[] = [
      ...availability.warnings,
      ...(await this.overruns(client, 'driver_id', driver.id, row.id, start)),
      ...(await this.overruns(client, 'vehicle_id', vehicle.id, row.id, start)),
    ];
    return { driver, vehicle, start, end, warnings };
  }

  /** The checked driver and vehicle onto the trip, audited, and TripAssigned (naming the approved request, if any). */
  private async applyAssignment(
    client: PoolClient,
    caller: Caller,
    row: TripRow,
    checked: { driver: { id: string }; vehicle: { id: string }; start: Date; end: Date },
    exceptionId: string | null,
  ): Promise<TripView> {
    const { trips } = this.deps;
    const fleet = this.deps.fleet();
    const { driver, vehicle, start, end } = checked;
    const changed = row.driverId !== driver.id || row.vehicleId !== vehicle.id || row.status !== 'assigned';
    if (changed) await trips.update(mutationContext(caller), row.id, { driver_id: driver.id, vehicle_id: vehicle.id, status: 'assigned' }, client);
    const view = (await this.views(client, [await trips.findById(client, row.id)]))[0];
    if (changed) {
      const previousDriver = row.driverId ? ((await fleet.drivers.publicIds(client, [row.driverId])).get(row.driverId) ?? null) : null;
      const previousVehicle = row.vehicleId ? ((await fleet.vehicles.publicIds(client, [row.vehicleId])).get(row.vehicleId) ?? null) : null;
      await this.deps.events.publish(client, [
        tripEvent(caller, TRIP_EVENTS.assigned, {
          trip_id: view.id,
          driver_id: view.driver_id,
          vehicle_id: view.vehicle_id,
          previous_driver_id: previousDriver,
          previous_vehicle_id: previousVehicle,
          route_id: view.route_id,
          depot_id: view.depot_id,
          scheduled_start: start.toISOString(),
          scheduled_end: end.toISOString(),
          ...(exceptionId ? { exception_id: exceptionId } : {}),
        }),
      ]);
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // Lifecycle commands (FMS-32): each is one move in TRIP_TRANSITIONS.

  /**
   * POST /trips/{id}/start: assigned → en_route, `actual_start` now. The
   * trip's driver (their own trips only) or dispatch. The rules that held at
   * assignment are read again, as things may have changed since: the vehicle
   * may have been flagged (a pre-trip inspection), taken out of service or
   * moved to another depot, the driver's licence may have expired. Another
   * trip of the driver or vehicle still under way is a warning, not a block
   * (FMS-31 overrun rule), and so is the driver's attendance.
   */
  async start(caller: Caller, tripId: string, expectedVersion: number | null = null): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    return this.move(caller, tripId, 'en_route', expectedVersion, async (client, row) => {
      const now = this.now();
      const fleet = this.deps.fleet();
      const vehicleId = row.vehicleId!;
      const driverId = row.driverId!;
      const answer = await fleet.availability.check(client, {
        vehicleIds: [vehicleId],
        driverIds: [driverId],
        window: { start: now, end: now },
        excludeTripId: row.publicId,
        ...(row.depotId ? { depotId: row.depotId } : {}),
      });
      const availability = readAvailability(answer.vehicles.get(vehicleId)!, answer.drivers.get(driverId)!);
      if (availability.refusal) throw await this.refusal(client, availability.refusal, vehicleId);
      const eligibility = await fleet.drivers.eligibility(client, driverId, now, vehicleId);
      if (!eligibility.eligible) throw driverNotEligible(eligibility.reasons);
      const warnings = [
        ...availability.warnings,
        ...(await this.overruns(client, 'driver_id', driverId, row.id, now)),
        ...(await this.overruns(client, 'vehicle_id', vehicleId, row.id, now)),
      ];
      return {
        data: { status: 'en_route', actual_start: now },
        event: TRIP_EVENTS.started,
        payload: (view) => ({ ...lifecyclePayload(view), actual_start: now.toISOString() }),
        warnings,
      };
    });
  }

  /**
   * POST /trips/{id}/end: en_route → completed, `actual_end` now (never
   * before `actual_start`, whatever the clocks say), the actual duration, and
   * the actual distance measured from the positions stored during the trip
   * (FMS-145), all in the one audited change.
   */
  async end(caller: Caller, tripId: string, expectedVersion: number | null = null): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    return this.move(caller, tripId, 'completed', expectedVersion, async (client, row) => {
      const startedAt = row.actualStart;
      const end = startedAt && this.now() < startedAt ? startedAt : this.now();
      const duration = startedAt ? Math.round((end.getTime() - startedAt.getTime()) / 1000) : undefined;
      const distance = (await this.deps.distance?.measure(client, { id: row.id, vehicleId: row.vehicleId }, startedAt, end)) ?? null;
      return {
        data: {
          status: 'completed',
          actual_end: end,
          ...(duration !== undefined ? { actual_duration_seconds: duration } : {}),
          ...(distance ? distanceWrite(distance, this.now()) : {}),
        },
        event: TRIP_EVENTS.completed,
        payload: (view) => ({
          ...lifecyclePayload(view),
          actual_start: startedAt?.toISOString() ?? null,
          actual_end: end.toISOString(),
          duration_seconds: duration ?? null,
          actual_distance_km: view.actual_distance_km,
          actual_distance_source: view.actual_distance_source,
        }),
        warnings: [],
      };
    });
  }

  /**
   * POST /trips/{id}/stops/{stop_id}/complete (FMS-95): the work at a stop is done. trip:execute: the trip's driver
   * (their own trips; anyone else's is 404) or dispatch in the trip's depot. Only while the trip is under way (409
   * trip_not_under_way); stops may be completed in any order. The stop is completed now, by the caller, and reached
   * now unless GPS already had it there, so the next estimate (FMS-86) routes past it. Audited; TripStopCompleted,
   * which the console receives as `trip.updated`. A stop already completed is returned as it is (`changed` false).
   */
  async completeStop(caller: Caller, tripId: string, stopId: string, notes?: string): Promise<{ stop: TripStopView; changed: boolean }> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      const stop = await trips.lockStop(client, row.id, stopId);
      if (!stop) throw stopNotFound();
      if (stop.status === 'completed') return { stop: stopView(stop, false), changed: false };
      if (row.status !== 'en_route') throw tripNotUnderWay(row.status);

      const at = this.now();
      await trips.completeStop(mutationContext(caller), stop, at, notes, client);
      const done = (await trips.stops(client, [row.id])).find((s) => s.id === stop.id)!;
      const [view] = await this.views(client, [row]);
      await this.deps.events.publish(client, [
        tripEvent(caller, TRIP_EVENTS.stopCompleted, {
          trip_id: view.id,
          stop_id: done.id,
          sequence_number: done.sequenceNumber,
          name: done.name,
          depot_id: view.depot_id,
          driver_id: view.driver_id,
          vehicle_id: view.vehicle_id,
          completed_at: at.toISOString(),
          // Whether GPS had the vehicle there first (FMS-86), or the completion is its only arrival.
          reached_by_gps: stop.actualArrival !== null,
        }),
      ]);
      return { stop: stopView(done, false), changed: true };
    });
  }

  /**
   * GET /trips/{id}/live (FMS-95): where a trip stands now, for whoever may read it (trip:read; a driver their own).
   * While under way: the vehicle's newest position (stale after 2 minutes), the next stop not yet reached with its
   * estimate, how many stops are reached and completed, and the trip's estimate (FMS-86). Otherwise the same without
   * a position.
   */
  async live(caller: Caller, tripId: string): Promise<TripLiveState> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller));
      if (!row) throw tripNotFound();
      const [view] = await this.views(client, [row]);
      const now = this.now();
      const lookup = row.status === 'en_route' && row.vehicleId ? (this.deps.positions?.() ?? null) : null;
      const position = lookup ? await lookup(client, row.vehicleId!) : null;
      const next = view.stops.find((s) => s.status === 'planned');
      return {
        trip_id: view.id,
        status: view.status,
        vehicle_id: view.vehicle_id,
        driver_id: view.driver_id,
        position: position
          ? {
              lat: position.lat,
              lng: position.lng,
              speed_kmh: position.speedKmh,
              heading: position.heading,
              recorded_at: position.recordedAt,
              stale: now.getTime() - position.recordedAt.getTime() > LIVE_POSITION_STALE_MS,
            }
          : null,
        next_stop: next ? { stop_id: next.id, sequence_number: next.sequence_number, name: next.name, eta: next.eta } : null,
        stops: {
          total: view.stops.length,
          reached: view.stops.filter((s) => s.actual_arrival !== null).length,
          completed: view.stops.filter((s) => s.status === 'completed').length,
        },
        eta: view.eta,
        actual_start: view.actual_start,
        scheduled_end: view.scheduled_end,
        as_of: now,
      };
    });
  }

  /**
   * POST /trips/{id}/status: the explicit form of the same moves.
   * `en_route` is start and `completed` is end. `scheduled` (from a draft
   * with both times) and `cancelled` are dispatch decisions: trip:write.
   * `assigned` is the assignment itself: 409, use POST /trips/{id}/assign.
   */
  async changeStatus(
    caller: Caller,
    tripId: string,
    status: CommandStatus,
    expectedVersion: number | null = null,
  ): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    if (status === 'en_route') return this.start(caller, tripId, expectedVersion);
    if (status === 'completed') return this.end(caller, tripId, expectedVersion);
    if (status !== 'assigned' && !caller.user.permissions.includes('trip:write')) throw dispatchOnly();
    return this.move(caller, tripId, status, expectedVersion, async (_client, row) => {
      if (status === 'assigned') throw assignRequired(row.status);
      if (status === 'scheduled') {
        if (!row.scheduledStart || !row.scheduledEnd) throw scheduleRequired();
        return {
          data: { status: 'scheduled' },
          event: TRIP_EVENTS.updated,
          payload: (view) => ({ changed_fields: ['status'], status: view.status }),
          warnings: [],
        };
      }
      return {
        data: { status: 'cancelled' },
        event: TRIP_EVENTS.cancelled,
        payload: (view) => ({ previous_status: row.status, route_id: view.route_id, driver_id: view.driver_id, vehicle_id: view.vehicle_id }),
        warnings: [],
      };
    });
  }

  /**
   * One lifecycle move, in one transaction: the trip row locked (a driver
   * sees only their own trips; anyone else's is 404), If-Match checked, the
   * move checked against TRIP_TRANSITIONS (409 with the allowed moves), then
   * the step's own rules, the audited update and its event.
   */
  private async move(
    caller: Caller,
    tripId: string,
    to: TripStatus,
    expectedVersion: number | null,
    step: (client: PoolClient, row: TripRow) => Promise<{
      data: TripWrite;
      event: string;
      payload: (view: TripView) => Record<string, unknown>;
      warnings: AssignmentWarning[];
    }>,
  ): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (!canMove(row.status, to)) throw invalidTripTransition(row.status, to);
      const { data, event, payload, warnings } = await step(client, row);
      await trips.update(mutationContext(caller), row.id, data, client);
      if (to === 'cancelled') await this.withdrawPending(client, caller, row.id);
      const view = (await this.views(client, [await trips.findById(client, row.id)]))[0];
      await this.deps.events.publish(client, [tripEvent(caller, event, { trip_id: view.id, ...payload(view) })]);
      return { trip: view, warnings };
    });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The error for an availability refusal; BR-2 names the open maintenance record behind the flag. */
  private async refusal(db: Queryable, refusal: AvailabilityRefusal, vehicleId: string): Promise<AppError> {
    switch (refusal.kind) {
      case 'depot':
        return depotMismatch(refusal.field);
      case 'vehicle_not_active':
        return vehicleNotActive(refusal.status);
      case 'vehicle_flagged':
        return vehicleFlagged(await this.deps.maintenance().openRecordFor(db, vehicleId));
    }
  }

  /**
   * Overrun (FMS-31): a trip of this driver or vehicle still under way is
   * expected to end at its scheduled end, or now if it is already late. If
   * that plus the grace buffer runs past this trip's start, warn: assignment
   * and start still go ahead. (A hard block would throw here instead.)
   */
  private async overruns(db: Queryable, field: 'driver_id' | 'vehicle_id', id: string, tripId: string, start: Date): Promise<AssignmentWarning[]> {
    const now = (this.deps.now ?? (() => new Date()))();
    const graceMs = this.deps.overrunGraceMinutes * 60_000;
    const warnings: AssignmentWarning[] = [];
    for (const other of await this.deps.trips.underWay(db, field, id, tripId)) {
      const expectedEnd = new Date(Math.max(other.scheduledEnd?.getTime() ?? now.getTime(), now.getTime()));
      if (expectedEnd.getTime() + graceMs > start.getTime()) {
        warnings.push({ warning: 'PREVIOUS_TRIP_OVERRUN', field, trip_id: other.publicId, expected_end: expectedEnd.toISOString() });
      }
    }
    return warnings;
  }

  /** Staff: their depots' trips (via the route). A driver (and nothing else): the trips they drive. */
  private async visibility(db: Queryable, caller: Caller): Promise<TripVisibility> {
    const own = ownDriverScope(caller.user);
    if (own.kind === 'own') {
      const driverId = await this.deps.fleet().drivers.idOfUser(db, own.userId);
      return driverId ? { kind: 'driver', driverId } : { kind: 'none' };
    }
    if (own.kind === 'none') return { kind: 'none' };
    const scope = depotScope(caller.user);
    if (scope.kind === 'all') return { kind: 'all' };
    return scope.kind === 'depot' ? { kind: 'depot', depotId: scope.depotId } : { kind: 'none' };
  }

  /** Requests as the API returns them: public ids, and the names of who asked and who decided. */
  private async exceptionViews(db: Queryable, rows: ExceptionRow[]): Promise<AssignmentExceptionView[]> {
    if (rows.length === 0) return [];
    const fleet = this.deps.fleet();
    const drivers = await fleet.drivers.publicIds(db, [...new Set(rows.map((e) => e.driverId))]);
    const vehicles = await fleet.vehicles.publicIds(db, [...new Set(rows.map((e) => e.vehicleId))]);
    const userIds = [...new Set(rows.flatMap((e) => [e.requestedBy, e.decidedBy].filter((u): u is string => u !== null).map(String)))];
    const users = new Map((await this.users.findByIds(db, userIds)).map((u) => [String(u.id), u]));
    const who = (id: string | null) => (id === null ? undefined : users.get(String(id)));
    return rows.map((e) => ({
      id: e.publicId,
      trip_id: e.tripPublicId,
      status: e.status,
      driver_id: drivers.get(e.driverId) ?? '',
      vehicle_id: vehicles.get(e.vehicleId) ?? '',
      warnings: e.warnings,
      reason: e.reason,
      requested_by: who(e.requestedBy)?.publicId ?? null,
      requested_by_name: who(e.requestedBy)?.fullName ?? null,
      requested_at: e.requestedAt,
      decided_by: who(e.decidedBy)?.publicId ?? null,
      decided_by_name: who(e.decidedBy)?.fullName ?? null,
      decided_at: e.decidedAt,
      decision_reason: e.decisionReason,
    }));
  }

  private async views(db: Queryable, rows: TripRow[]): Promise<TripView[]> {
    const fleet = this.deps.fleet();
    const ids = (pick: (r: TripRow) => string | null) => [...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : [])))];
    // Sequential: `db` is often a transaction's client, which runs one query at a time.
    const depots = await fleet.depots.publicIds(db, ids((r) => r.depotId));
    const vehicles = await fleet.vehicles.publicIds(db, ids((r) => r.vehicleId));
    const drivers = await fleet.drivers.publicIds(db, ids((r) => r.driverId));
    const stops = await this.deps.trips.stops(db, rows.map((r) => r.id));
    const etas = await this.deps.trips.etas(db, rows.filter((r) => r.status === 'en_route').map((r) => r.id));
    // The newest request of each open trip, while it waits or once refused (FMS-151).
    const open = rows.filter((r) => r.status === 'scheduled' || r.status === 'assigned').map((r) => r.id);
    const latest = (await this.exceptions.latestByTrips(db, open)).filter((e) => e.status === 'pending' || e.status === 'refused');
    const exceptions = new Map((await this.exceptionViews(db, latest)).map((v, i) => [String(latest[i].tripId), v]));
    // The job load (FMS-153) needs the vehicles' payloads, only for trips that carry something.
    const payloads = await fleet.vehicles.payloadCapacities(db, ids((r) => (r.cargoWeightKg !== null ? r.vehicleId : null)));
    return rows.map((r) => {
      const own = stops.filter((s) => s.tripId === r.id);
      const eta = r.status === 'en_route' ? etas.get(String(r.id)) : undefined;
      const next = own.find((s) => s.eta !== null);
      const load = jobLoad({
        plannedDistanceKm: r.plannedDistanceKm,
        plannedDurationSeconds: r.plannedDurationSeconds,
        scheduledStart: r.scheduledStart,
        scheduledEnd: r.scheduledEnd,
        stopCount: own.length,
        cargoWeightKg: r.cargoWeightKg,
        payloadCapacityKg: r.vehicleId ? (payloads.get(String(r.vehicleId)) ?? null) : null,
      });
      return {
      id: r.publicId,
      route_id: r.routePublicId,
      route_name: r.routeName,
      depot_id: r.depotId ? (depots.get(r.depotId) ?? null) : null,
      vehicle_id: r.vehicleId ? (vehicles.get(r.vehicleId) ?? null) : null,
      driver_id: r.driverId ? (drivers.get(r.driverId) ?? null) : null,
      status: r.status,
      origin: r.origin,
      destination: r.destination,
      planned_distance_km: r.plannedDistanceKm,
      planned_duration_seconds: r.plannedDurationSeconds,
      scheduled_start: r.scheduledStart,
      scheduled_end: r.scheduledEnd,
      actual_start: r.actualStart,
      actual_end: r.actualEnd,
      actual_distance_km: r.actualDistanceKm,
      actual_distance_source: r.actualDistanceSource,
      cargo_weight_kg: r.cargoWeightKg,
      cargo_kind: r.cargoKind,
      job_load: load.level,
      job_load_reasons: load.reasons,
      stops: own.map((s) => stopView(s, !!eta)),
      eta: eta
        ? {
            arrival_at: eta.arrivalAt,
            remaining_km: eta.remainingKm,
            remaining_seconds: eta.remainingSeconds,
            next_stop: next ? { stop_id: next.id, name: next.name, eta: next.eta! } : null,
            position_at: eta.positionAt,
            updated_at: eta.computedAt,
          }
        : null,
      exception: exceptions.get(String(r.id)) ?? null,
      version: r.version,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      };
    });
  }
}

/** A trip event, ordered per trip in the outbox (FMS-73). */
/** What TripStarted and TripCompleted say about the trip: who, with what, from where. */
function lifecyclePayload(view: TripView): Record<string, unknown> {
  return { driver_id: view.driver_id, vehicle_id: view.vehicle_id, route_id: view.route_id, depot_id: view.depot_id, scheduled_start: view.scheduled_start?.toISOString() ?? null };
}

function tripEvent(caller: Caller, type: string, payload: { trip_id: string } & Record<string, unknown>): DomainEvent {
  return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId }, { aggregate: aggregateKey('trip', payload.trip_id) });
}

/** A stop as the API returns it; its estimate only while the trip has one (under way). */
function stopView(s: StopRow, withEta: boolean): TripStopView {
  return {
    id: s.id,
    sequence_number: s.sequenceNumber,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    status: s.status,
    planned_arrival: s.plannedArrival,
    actual_arrival: s.actualArrival,
    eta: withEta ? s.eta : null,
    completed_at: s.completedAt,
  };
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
