import { depotScope, ownDriverScope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  OPEN_STATUSES,
  TRIP_EVENTS,
  cannotCancelEnRoute,
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
import type { Caller, FleetRefs } from './route.service';

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

export interface TripServiceDeps {
  trips: Pick<TripRepository, 'inTransaction' | 'history' | 'findVisible' | 'findById' | 'stops' | 'routePlan' | 'routeId' | 'insert' | 'update' | 'insertStop'>;
  /** The fleet module's lookups, connected by src/modules/index.ts. */
  fleet: () => FleetRefs;
  events: EventBus;
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
function tripEvent(caller: Caller, type: string, payload: { trip_id: string } & Record<string, unknown>): DomainEvent {
  return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId }, { aggregate: aggregateKey('trip', payload.trip_id) });
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
