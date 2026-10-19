import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { TripCursor, TripStatus } from '../domain/trip';
import type { RouteStop } from '../domain/route';

/**
 * Which trips a caller sees (FMS-30). Staff see their depots' trips through
 * the route's depot; a driver sees only trips they drive.
 */
export type TripVisibility = { kind: 'all' } | { kind: 'depot'; depotId: string } | { kind: 'driver'; driverId: string } | { kind: 'none' };

/** A trip.trips row joined to its route (internal ids). Numerics are read as float8. */
export interface TripRow {
  id: string;
  publicId: string;
  routeId: string | null;
  routePublicId: string | null;
  routeName: string | null;
  depotId: string | null;
  vehicleId: string | null;
  driverId: string | null;
  status: TripStatus;
  origin: string | null;
  destination: string | null;
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  actualDistanceKm: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** The history key (scheduled_start, or created_at for an unscheduled draft) in UTC with microseconds, for the cursor. */
  at: string;
}

export interface StopRow {
  id: string;
  tripId: string;
  sequenceNumber: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: 'planned' | 'arrived' | 'completed' | 'skipped';
  plannedArrival: Date | null;
  actualArrival: Date | null;
}

/** A route as a trip needs it: scope, state and the plan to copy. */
export interface RoutePlan {
  id: string;
  publicId: string;
  depotId: string;
  isActive: boolean;
  originName: string | null;
  destinationName: string | null;
  distanceKm: number | null;
  estimatedDurationSeconds: number | null;
  stops: RouteStop[];
}

export interface TripWrite {
  route_id?: string;
  status?: TripStatus;
  driver_id?: string;
  vehicle_id?: string;
  origin?: string | null;
  destination?: string | null;
  planned_distance_km?: number | null;
  planned_duration_seconds?: number | null;
  scheduled_start?: Date;
  scheduled_end?: Date;
}

export interface TripHistoryFilter {
  visibility: TripVisibility;
  statuses?: TripStatus[];
  driverId?: string;
  vehicleId?: string;
  routeId?: string;
  depotId?: string;
  /** Trips starting at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
  order: 'asc' | 'desc';
  after?: TripCursor;
  limit: number;
}

/** The history key: when the trip starts, or was created if it is an unscheduled draft (idx_trip_trips_history). */
const AT = 'COALESCE(t.scheduled_start, t.created_at)';

const ROW_SQL = `
  SELECT t.id, t.public_id AS "publicId", t.route_id AS "routeId", r.public_id AS "routePublicId", r.name AS "routeName",
         r.depot_id AS "depotId", t.vehicle_id AS "vehicleId", t.driver_id AS "driverId", t.status,
         t.origin, t.destination, t.planned_distance_km::float8 AS "plannedDistanceKm",
         t.planned_duration_seconds AS "plannedDurationSeconds", t.scheduled_start AS "scheduledStart",
         t.scheduled_end AS "scheduledEnd", t.actual_start AS "actualStart", t.actual_end AS "actualEnd",
         t.actual_distance_km::float8 AS "actualDistanceKm", t.version, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
         to_char(${AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM trip.trips t
    LEFT JOIN trip.routes r ON r.id = t.route_id`;

function visibilitySql(v: TripVisibility, add: (value: unknown) => string): string {
  switch (v.kind) {
    case 'all':
      return 'TRUE';
    case 'depot':
      return `r.depot_id = ${add(v.depotId)}`;
    case 'driver':
      return `t.driver_id = ${add(v.driverId)}`;
    default:
      return 'FALSE';
  }
}

/** trip.trips, their stops, and the routes they are planned from (FMS-30). */
export class TripRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** One page of history, plus whether another follows. Keyset paging: rows written meanwhile never shift a page. */
  async history(db: Queryable, f: TripHistoryFilter): Promise<{ rows: TripRow[]; more: boolean }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [visibilitySql(f.visibility, add)];
    if (f.statuses?.length) where.push(`t.status = ANY(${add(f.statuses)}::trip.trip_status[])`);
    if (f.driverId) where.push(`t.driver_id = ${add(f.driverId)}`);
    if (f.vehicleId) where.push(`t.vehicle_id = ${add(f.vehicleId)}`);
    if (f.routeId) where.push(`t.route_id = ${add(f.routeId)}`);
    if (f.depotId) where.push(`r.depot_id = ${add(f.depotId)}`);
    if (f.from) where.push(`${AT} >= ${add(f.from)}`);
    if (f.to) where.push(`${AT} < ${add(f.to)}`);
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    if (f.after) where.push(`(${AT}, t.id) ${f.order === 'asc' ? '>' : '<'} (${add(f.after.at)}::timestamptz, ${add(f.after.id)}::bigint)`);
    const res = await db.query<TripRow>(`${ROW_SQL} WHERE ${where.join(' AND ')} ORDER BY ${AT} ${dir}, t.id ${dir} LIMIT ${add(f.limit + 1)}`, params);
    return { rows: res.rows.slice(0, f.limit), more: res.rows.length > f.limit };
  }

  async findVisible(db: Queryable, publicId: string, visibility: TripVisibility, lock = false): Promise<TripRow | null> {
    const params: unknown[] = [publicId];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const res = await db.query<TripRow>(`${ROW_SQL} WHERE t.public_id = $1 AND ${visibilitySql(visibility, add)}${lock ? ' FOR UPDATE OF t' : ''}`, params);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<TripRow> {
    const res = await db.query<TripRow>(`${ROW_SQL} WHERE t.id = $1`, [id]);
    return res.rows[0];
  }

  /** Public ids by internal id, for other modules' responses (fuel logs name their trip). */
  async publicIdsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const res = await db.query<{ id: string; publicId: string }>('SELECT id, public_id AS "publicId" FROM trip.trips WHERE id = ANY($1::bigint[])', [ids]);
    return new Map(res.rows.map((r) => [r.id, r.publicId]));
  }

  /** Stops of these trips, in travel order. */
  async stops(db: Queryable, tripIds: readonly string[]): Promise<StopRow[]> {
    if (tripIds.length === 0) return [];
    const res = await db.query<StopRow>(
      `SELECT s.public_id AS id, s.trip_id AS "tripId", s.sequence_number AS "sequenceNumber", s.name,
              s.latitude::float8 AS latitude, s.longitude::float8 AS longitude, s.status,
              s.planned_arrival AS "plannedArrival", s.actual_arrival AS "actualArrival"
         FROM trip.trip_stops s WHERE s.trip_id = ANY($1::bigint[]) ORDER BY s.trip_id, s.sequence_number`,
      [tripIds],
    );
    return res.rows;
  }

  /** A route by public id with its plan, if it is in the depot scope (null depotId: any depot). Share-locked: it cannot be retired mid-create. */
  async routePlan(db: Queryable, publicId: string, depotId: string | null): Promise<RoutePlan | null> {
    const res = await db.query<RoutePlan>(
      `SELECT id, public_id AS "publicId", depot_id AS "depotId", is_active AS "isActive", origin_name AS "originName",
              destination_name AS "destinationName", distance_km::float8 AS "distanceKm",
              estimated_duration_seconds AS "estimatedDurationSeconds", stops
         FROM trip.routes WHERE public_id = $1 AND ($2::bigint IS NULL OR depot_id = $2) FOR SHARE`,
      [publicId, depotId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * The first assigned or en-route trip of this driver or vehicle, other than
   * `exceptTripId`, whose window touches [start, end] (FMS-31 BR-1, BR-3).
   * Both ends count, as in ex_trip_driver_overlap and ex_trip_vehicle_overlap
   * (migration 030): a 0-minute gap is an overlap.
   */
  async overlapping(db: Queryable, column: 'driver_id' | 'vehicle_id', id: string, start: Date, end: Date, exceptTripId: string): Promise<string | null> {
    const res = await db.query<{ public_id: string }>(
      `SELECT public_id FROM trip.trips
        WHERE ${column} = $1 AND id <> $2 AND status IN ('assigned', 'en_route')
          AND tstzrange(scheduled_start, scheduled_end, '[]') && tstzrange($3, $4, '[]')
        ORDER BY scheduled_start, id LIMIT 1`,
      [id, exceptTripId, start, end],
    );
    return res.rows[0]?.public_id ?? null;
  }

  /** En-route trips of this driver or vehicle other than `exceptTripId`, for the overrun warning. */
  async underWay(db: Queryable, column: 'driver_id' | 'vehicle_id', id: string, exceptTripId: string): Promise<{ publicId: string; scheduledEnd: Date | null }[]> {
    const res = await db.query<{ publicId: string; scheduledEnd: Date | null }>(
      `SELECT public_id AS "publicId", scheduled_end AS "scheduledEnd" FROM trip.trips
        WHERE ${column} = $1 AND id <> $2 AND status = 'en_route' ORDER BY scheduled_end NULLS LAST, id`,
      [id, exceptTripId],
    );
    return res.rows;
  }

  /** A route's internal id by public id, for the history filter. */
  async routeId(db: Queryable, publicId: string): Promise<string | null> {
    const res = await db.query<{ id: string }>('SELECT id FROM trip.routes WHERE public_id = $1', [publicId]);
    return res.rows[0]?.id ?? null;
  }

  insert(ctx: MutationContext, data: TripWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'trip.trips', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: TripWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'trip.trips', 'UPDATE', id, { ...data }, client);
  }

  insertStop(ctx: MutationContext, tripId: string, sequence: number, stop: RouteStop, client: PoolClient): Promise<Row> {
    return this.mutate(
      ctx,
      'trip.trip_stops',
      'INSERT',
      null,
      { trip_id: tripId, sequence_number: sequence, name: stop.name, stop_type: 'waypoint', latitude: stop.latitude, longitude: stop.longitude },
      client,
    );
  }
}
