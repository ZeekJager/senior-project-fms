import { DatabaseError } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  ROUTE_EVENTS,
  duplicateRouteName,
  routeDepotNotFound,
  routeNotFound,
  type Coordinates,
  type RouteStop,
  type RouteView,
} from '../domain/route';
import type { RouteRepository, RouteRow, RouteWrite } from '../infrastructure/route.repository';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

export interface RouteCreate {
  name: string;
  /** Public id of a depot in the caller's scope. Required: a route always belongs to a depot. */
  depot_id: string;
  origin_name?: string | null;
  origin?: Coordinates | null;
  destination_name?: string | null;
  destination?: Coordinates | null;
  stops?: RouteStop[];
  distance_km?: number | null;
  estimated_duration_seconds?: number | null;
}

/** PATCH: the fields sent. is_active false retires the route; true brings it back. */
export type RouteUpdate = Partial<RouteCreate> & { is_active?: boolean };

export interface RouteListQuery {
  page: number;
  page_size: number;
  depot_id?: string;
  search?: string;
  status: 'active' | 'retired' | 'all';
  sort_by: 'name' | 'distance_km' | 'updated_at';
  sort_order: 'asc' | 'desc';
}

/**
 * What the trip module needs from fleet: depots, vehicles and drivers by
 * public id (internal id, or null if unknown) and back. Connected by
 * src/modules/index.ts, since fleet imports trip and trip cannot import fleet.
 */
export interface FleetRefs {
  depots: {
    /** A live depot in the scope, share-locked. */
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  vehicles: {
    idOf(db: Queryable, publicId: string): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    /** For assignment: a vehicle in the scope with its state, share-locked. */
    forAssignment(db: Queryable, publicId: string, scope: Scope): Promise<{ id: string; publicId: string; status: string; maintenanceFlag: boolean } | null>;
  };
  drivers: {
    idOf(db: Queryable, publicId: string): Promise<string | null>;
    /** The driver profile of a user account (internal user id). */
    idOfUser(db: Queryable, userId: string): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    /** For assignment: a driver in the scope (home depot), share-locked. */
    forAssignment(db: Queryable, publicId: string, scope: Scope): Promise<{ id: string; publicId: string } | null>;
    /** Whether the driver may drive this vehicle at `at`, and every reason if not (FMS-76). */
    eligibility(db: Queryable, driverId: string, at: Date, vehicleId: string): Promise<{ eligible: boolean; reasons: string[] }>;
  };
}

/** What the trip module needs from maintenance (FMS-31), connected by src/modules/index.ts. */
export interface MaintenanceRefs {
  /** The public id of the open record behind a vehicle's maintenance flag, if any. */
  openRecordFor(db: Queryable, vehicleId: string): Promise<string | null>;
}

export interface RouteServiceDeps {
  routes: Pick<RouteRepository, 'inTransaction' | 'list' | 'findVisible' | 'findById' | 'insert' | 'update'>;
  fleet: () => FleetRefs;
  events: EventBus;
}

/** The unique index that keeps active route names distinct within a depot (migration 027). */
const UNIQUE_NAME = 'ux_trip_routes_depot_name';

/**
 * Planned routes (FMS-83, §9.2): reusable origin, destination, stops and
 * expected distance that trips are created from. Every route belongs to a
 * depot, and depot scope decides who sees it. A route is never deleted:
 * retiring it (is_active false) hides it from new trips, while trips that
 * used it keep their reference and their own copy of the plan.
 */
export class RouteService {
  constructor(private readonly deps: RouteServiceDeps) {}

  async list(caller: Caller, query: RouteListQuery): Promise<{ items: RouteView[]; total: number }> {
    const { routes } = this.deps;
    return routes.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let depotId: string | undefined;
      if (query.depot_id) {
        const resolved = await this.deps.fleet().depots.resolveInScope(client, query.depot_id, scope);
        if (!resolved) return { items: [], total: 0 };
        depotId = resolved;
      }
      const { rows, total } = await routes.list(client, {
        page: query.page,
        page_size: query.page_size,
        scope,
        depotId,
        search: query.search,
        status: query.status,
        sortBy: query.sort_by,
        sortOrder: query.sort_order,
      });
      return { items: await this.views(client, rows), total };
    });
  }

  async get(caller: Caller, routeId: string): Promise<RouteView> {
    const { routes } = this.deps;
    return routes.inTransaction(async (client) => {
      const row = await routes.findVisible(client, routeId, depotScope(caller.user));
      if (!row) throw routeNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  async create(caller: Caller, input: RouteCreate): Promise<RouteView> {
    const { routes } = this.deps;
    return routes.inTransaction(async (client) => {
      const depotId = await this.depotFor(client, caller, input.depot_id);
      const row = await uniqueName(() =>
        routes.insert(
          mutationContext(caller),
          {
            name: input.name,
            depot_id: depotId,
            origin_name: input.origin_name ?? null,
            ...coordinates('origin', input.origin ?? null),
            destination_name: input.destination_name ?? null,
            ...coordinates('destination', input.destination ?? null),
            stops: stopsJson(input.stops ?? []),
            distance_km: input.distance_km ?? null,
            estimated_duration_seconds: input.estimated_duration_seconds ?? null,
          },
          client,
        ),
      );
      const view = (await this.views(client, [await routes.findById(client, row.id as string)]))[0];
      await this.deps.events.publish(client, [
        routeEvent(caller, ROUTE_EVENTS.created, { route_id: view.id, depot_id: view.depot_id, name: view.name, distance_km: view.distance_km }),
      ]);
      return view;
    });
  }

  /** PATCH /routes/{id}: the fields sent. If-Match (expectedVersion) refuses a write over someone else's change. */
  async update(caller: Caller, routeId: string, patch: RouteUpdate, expectedVersion: number | null): Promise<RouteView> {
    const { routes } = this.deps;
    return routes.inTransaction(async (client) => {
      const row = await routes.findVisible(client, routeId, depotScope(caller.user), true);
      if (!row) throw routeNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();

      const data: RouteWrite = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.depot_id !== undefined) data.depot_id = await this.depotFor(client, caller, patch.depot_id);
      if (patch.origin_name !== undefined) data.origin_name = patch.origin_name;
      if (patch.origin !== undefined) Object.assign(data, coordinates('origin', patch.origin));
      if (patch.destination_name !== undefined) data.destination_name = patch.destination_name;
      if (patch.destination !== undefined) Object.assign(data, coordinates('destination', patch.destination));
      if (patch.stops !== undefined) data.stops = stopsJson(patch.stops);
      if (patch.distance_km !== undefined) data.distance_km = patch.distance_km;
      if (patch.estimated_duration_seconds !== undefined) data.estimated_duration_seconds = patch.estimated_duration_seconds;
      if (patch.is_active !== undefined) data.is_active = patch.is_active;

      const changed = changes(row, data);
      if (Object.keys(changed).length > 0) await uniqueName(() => routes.update(mutationContext(caller), row.id, changed, client));
      const view = (await this.views(client, [await routes.findById(client, row.id)]))[0];
      const changedFields = [...new Set(Object.keys(changed).map(apiField))].sort();
      if (changedFields.length > 0) {
        await this.deps.events.publish(client, [
          routeEvent(caller, ROUTE_EVENTS.updated, { route_id: view.id, depot_id: view.depot_id, changed_fields: changedFields, is_active: view.is_active }),
        ]);
      }
      return view;
    });
  }

  /** A depot in the caller's scope, or 400: a route without a valid depot is not saved. */
  private async depotFor(db: Queryable, caller: Caller, depotPublicId: string): Promise<string> {
    const id = await this.deps.fleet().depots.resolveInScope(db, depotPublicId, depotScope(caller.user));
    if (!id) throw routeDepotNotFound();
    return id;
  }

  private async views(db: Queryable, rows: RouteRow[]): Promise<RouteView[]> {
    const depots = await this.deps.fleet().depots.publicIds(db, [...new Set(rows.map((r) => r.depotId))]);
    return rows.map((r) => ({
      id: r.publicId,
      name: r.name,
      depot_id: depots.get(r.depotId) ?? '',
      origin_name: r.originName,
      origin: point(r.originLatitude, r.originLongitude),
      destination_name: r.destinationName,
      destination: point(r.destinationLatitude, r.destinationLongitude),
      stops: r.stops,
      distance_km: r.distanceKm,
      estimated_duration_seconds: r.estimatedDurationSeconds,
      is_active: r.isActive,
      version: r.version,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }
}

function point(latitude: number | null, longitude: number | null): Coordinates | null {
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function coordinates(prefix: 'origin' | 'destination', value: Coordinates | null): RouteWrite {
  return { [`${prefix}_latitude`]: value?.latitude ?? null, [`${prefix}_longitude`]: value?.longitude ?? null };
}

/** Stops as JSON with a fixed key order: jsonb reorders keys, so text compares need one. */
function stopsJson(stops: RouteStop[]): string {
  return JSON.stringify(stops.map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude })));
}

/** Only the columns whose value differs from the row, so an unchanged PATCH writes and publishes nothing. */
function changes(row: RouteRow, data: RouteWrite): RouteWrite {
  const current: Record<keyof RouteWrite, unknown> = {
    name: row.name,
    depot_id: row.depotId,
    origin_name: row.originName,
    origin_latitude: row.originLatitude,
    origin_longitude: row.originLongitude,
    destination_name: row.destinationName,
    destination_latitude: row.destinationLatitude,
    destination_longitude: row.destinationLongitude,
    stops: stopsJson(row.stops),
    distance_km: row.distanceKm,
    estimated_duration_seconds: row.estimatedDurationSeconds,
    is_active: row.isActive,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data) as [keyof RouteWrite, unknown][]) {
    if (value !== current[key]) out[key] = value;
  }
  return out as RouteWrite;
}

/** Column name to the API field it belongs to (origin_latitude is part of origin). */
function apiField(column: string): string {
  return column.replace(/_(latitude|longitude)$/, '');
}

/** The unique index on active names becomes 409 with field `name`, not a column list. */
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof DatabaseError && err.code === '23505' && err.constraint === UNIQUE_NAME) throw duplicateRouteName();
    throw err;
  }
}

/** A route event, ordered per route in the outbox (FMS-73). */
function routeEvent(caller: Caller, type: string, payload: { route_id: string } & Record<string, unknown>): DomainEvent {
  return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId }, { aggregate: aggregateKey('route', payload.route_id) });
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
