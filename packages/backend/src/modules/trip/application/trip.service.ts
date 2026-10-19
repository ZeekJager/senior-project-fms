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
  tripClosed,
  tripNotFound,
  tripRouteNotFound,
  tripRouteRetired,
  type TripStatus,
  type TripView,
} from '../domain/trip';
import type { RequestUser } from '../../../types/express';
import type { TripRepository, TripRow, TripVisibility, TripWrite } from '../infrastructure/trip.repository';
import { readAvailability, type AvailabilityRefusal } from '../domain/assignment';
import { assignRequired, canMove, dispatchOnly, invalidTripTransition, scheduleRequired, type CommandStatus } from '../domain/lifecycle';
import type { Caller, FleetRefs, MaintenanceRefs } from './route.service';

export interface TripCreate {
  /** Public id of an active route in the caller's depots. Its plan (ends, distance, time, stops) is copied onto the trip. */
  route_id: string;
  scheduled_start: Date;
  scheduled_end: Date;
}

/** PATCH: reschedule, or cancel with status "cancelled". Driver and vehicle are set by assignment (FMS-31). */
export interface TripUpdate {
  scheduled_start?: Date;
  scheduled_end?: Date;
  status?: 'cancelled';
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
}

export interface TripServiceDeps {
  trips: Pick<
    TripRepository,
    'inTransaction' | 'history' | 'findVisible' | 'findById' | 'stops' | 'routePlan' | 'routeId' | 'insert' | 'update' | 'insertStop' | 'overlapping' | 'underWay'
  >;
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
  constructor(private readonly deps: TripServiceDeps) {}

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

  async create(caller: Caller, input: TripCreate): Promise<TripView> {
    if (input.scheduled_end <= input.scheduled_start) throw invalidDateRange('scheduled_end', 'The trip must end after it starts.');
    const { trips } = this.deps;
    const ctx = mutationContext(caller);
    return trips.inTransaction(async (client) => {
      const visibility = await this.visibility(client, caller);
      if (visibility.kind !== 'all' && visibility.kind !== 'depot') throw tripRouteNotFound();
      const route = await trips.routePlan(client, input.route_id, visibility.kind === 'depot' ? visibility.depotId : null);
      if (!route) throw tripRouteNotFound();
      if (!route.isActive) throw tripRouteRetired();

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
          scheduled_end: input.scheduled_end,
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
   * PATCH /trips/{id}: reschedule an open trip (draft, scheduled, assigned),
   * or cancel it. A draft that gets both times becomes scheduled. A trip under
   * way is ended, not cancelled; a completed or cancelled trip never changes.
   */
  async update(caller: Caller, tripId: string, patch: TripUpdate, expectedVersion: number | null): Promise<TripView> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (row.status === 'en_route' && patch.status === 'cancelled') throw cannotCancelEnRoute();
      if (!OPEN_STATUSES.includes(row.status)) throw tripClosed(row.status);

      const start = patch.scheduled_start ?? row.scheduledStart;
      const end = patch.scheduled_end ?? row.scheduledEnd;
      if (start && end && end <= start) throw invalidDateRange('scheduled_end', 'The trip must end after it starts.');

      const data: TripWrite = {};
      if (patch.scheduled_start && patch.scheduled_start.getTime() !== row.scheduledStart?.getTime()) data.scheduled_start = patch.scheduled_start;
      if (patch.scheduled_end && patch.scheduled_end.getTime() !== row.scheduledEnd?.getTime()) data.scheduled_end = patch.scheduled_end;
      const rescheduled = Object.keys(data).sort();
      if (patch.status === 'cancelled') data.status = 'cancelled';
      else if (row.status === 'draft' && start && end) data.status = 'scheduled';

      if (Object.keys(data).length > 0) await trips.update(mutationContext(caller), row.id, data, client);
      const view = (await this.views(client, [await trips.findById(client, row.id)]))[0];

      const events: DomainEvent[] = [];
      if (rescheduled.length > 0) events.push(tripEvent(caller, TRIP_EVENTS.updated, { trip_id: view.id, changed_fields: rescheduled, status: view.status }));
      if (patch.status === 'cancelled') {
        events.push(tripEvent(caller, TRIP_EVENTS.cancelled, { trip_id: view.id, previous_status: row.status, route_id: view.route_id, driver_id: view.driver_id, vehicle_id: view.vehicle_id }));
      }
      if (events.length > 0) await this.deps.events.publish(client, events);
      return view;
    });
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
  async assign(caller: Caller, tripId: string, input: TripAssignment): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    const { trips } = this.deps;
    return trips.inTransaction(async (client) => {
      const row = await trips.findVisible(client, tripId, await this.visibility(client, caller), true);
      if (!row) throw tripNotFound();
      if (input.version !== row.version) throw staleVersion();
      if (!ASSIGNABLE_STATUSES.includes(row.status) || !row.scheduledStart || !row.scheduledEnd) throw notAssignable(row.status);
      const start = row.scheduledStart;
      const end = row.scheduledEnd;
      const scope = depotScope(caller.user);
      const fleet = this.deps.fleet();

      // Share-locked: a maintenance flag, status change or retirement cannot land mid-assignment.
      const vehicle = await fleet.vehicles.forAssignment(client, input.vehicle_id, scope);
      if (!vehicle) throw assignmentRefNotFound('vehicle_id');
      const driver = await fleet.drivers.forAssignment(client, input.driver_id, scope);
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

      const warnings = [
        ...availability.warnings,
        ...(await this.overruns(client, 'driver_id', driver.id, row.id, start)),
        ...(await this.overruns(client, 'vehicle_id', vehicle.id, row.id, start)),
      ];

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
          }),
        ]);
      }
      return { trip: view, warnings };
    });
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
   * before `actual_start`, whatever the clocks say), and the actual duration.
   */
  async end(caller: Caller, tripId: string, expectedVersion: number | null = null): Promise<{ trip: TripView; warnings: AssignmentWarning[] }> {
    return this.move(caller, tripId, 'completed', expectedVersion, async (_client, row) => {
      const startedAt = row.actualStart;
      const end = startedAt && this.now() < startedAt ? startedAt : this.now();
      const duration = startedAt ? Math.round((end.getTime() - startedAt.getTime()) / 1000) : undefined;
      return {
        data: { status: 'completed', actual_end: end, ...(duration !== undefined ? { actual_duration_seconds: duration } : {}) },
        event: TRIP_EVENTS.completed,
        payload: (view) => ({
          ...lifecyclePayload(view),
          actual_start: startedAt?.toISOString() ?? null,
          actual_end: end.toISOString(),
          duration_seconds: duration ?? null,
        }),
        warnings: [],
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

  private async views(db: Queryable, rows: TripRow[]): Promise<TripView[]> {
    const fleet = this.deps.fleet();
    const ids = (pick: (r: TripRow) => string | null) => [...new Set(rows.flatMap((r) => (pick(r) ? [pick(r) as string] : [])))];
    // Sequential: `db` is often a transaction's client, which runs one query at a time.
    const depots = await fleet.depots.publicIds(db, ids((r) => r.depotId));
    const vehicles = await fleet.vehicles.publicIds(db, ids((r) => r.vehicleId));
    const drivers = await fleet.drivers.publicIds(db, ids((r) => r.driverId));
    const stops = await this.deps.trips.stops(db, rows.map((r) => r.id));
    return rows.map((r) => ({
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
      stops: stops
        .filter((s) => s.tripId === r.id)
        .map((s) => ({
          id: s.id,
          sequence_number: s.sequenceNumber,
          name: s.name,
          latitude: s.latitude,
          longitude: s.longitude,
          status: s.status,
          planned_arrival: s.plannedArrival,
          actual_arrival: s.actualArrival,
        })),
      version: r.version,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
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

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
