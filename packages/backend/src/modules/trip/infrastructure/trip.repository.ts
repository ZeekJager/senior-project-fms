import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { Slot } from '../domain/schedule';
import { Repository } from '../../../shared/infrastructure/repository';
import type { TripCursor, TripStatus } from '../domain/trip';
import type { Coordinates, RouteStop } from '../domain/route';
import type { DelayState } from '../domain/delay';
import type { CargoKind } from '../domain/job-load';
import { ETA_INTERVAL_SECONDS, type EtaResult, type EtaStop } from '../domain/eta';

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
  /** How the distance was measured (FMS-145); null with a distance entered before, or with none. */
  actualDistanceSource: 'odometer' | 'gps' | null;
  /** FMS-153. */
  cargoWeightKg: number | null;
  cargoKind: CargoKind;
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
  /** Expected arrival from the vehicle's latest position (FMS-86); null once reached or before an estimate. */
  eta: Date | null;
  /** When it was marked done (FMS-95). */
  completedAt: Date | null;
}

/** A trip's latest estimate (FMS-86), keyed by internal trip id. */
export interface EtaRow {
  tripId: string;
  arrivalAt: Date | null;
  remainingKm: number | null;
  remainingSeconds: number | null;
  positionAt: Date;
  computedAt: Date;
}

/** A trip as its estimate needs it: state, the route's destination and the stops; for the delay alert (FMS-147), its end and parties. */
export interface EtaTrip {
  id: string;
  publicId: string;
  status: TripStatus;
  destination: Coordinates | null;
  stops: EtaStop[];
  /** The route's depot, vehicle and driver: internal ids. */
  depotId: string | null;
  vehicleId: string | null;
  driverId: string | null;
  scheduledEnd: Date | null;
  /** Where it is going, as the trip names it. */
  destinationName: string | null;
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
  /** Set by the lifecycle commands (FMS-32): start, end. */
  actual_start?: Date;
  actual_end?: Date;
  actual_duration_seconds?: number;
  /** Measured at the end and after (FMS-145): the distance, how, from how many positions, when. */
  actual_distance_km?: number | null;
  actual_distance_source?: 'odometer' | 'gps' | null;
  actual_distance_points?: number;
  actual_distance_measured_at?: Date;
  /** FMS-153: set on create and by PATCH before the trip starts. */
  cargo_weight_kg?: number | null;
  cargo_kind?: CargoKind;
}

/** A trip as the distance limits count it (FMS-156). Internal ids. */
export interface CountedTripRow {
  id: string;
  publicId: string;
  driverId: string;
  vehicleId: string | null;
  status: TripStatus;
  scheduledStart: Date;
  scheduledEnd: Date | null;
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  actualDistanceKm: number | null;
  cargoWeightKg: number | null;
  stopCount: number;
}

/** A completed trip whose distance may be measured (FMS-145). Internal ids. */
export interface DistanceCandidate {
  id: string;
  vehicleId: string | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  actualDistanceKm: number | null;
  actualDistanceSource: 'odometer' | 'gps' | null;
  /** Positions it was last measured from; null if never measured. */
  actualDistancePoints: number | null;
}

const CANDIDATE_SQL = `
  SELECT id::text AS id, vehicle_id::text AS "vehicleId", actual_start AS "actualStart", actual_end AS "actualEnd",
         actual_distance_km::float8 AS "actualDistanceKm", actual_distance_source AS "actualDistanceSource",
         actual_distance_points AS "actualDistancePoints"
    FROM trip.trips`;

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
         t.actual_distance_km::float8 AS "actualDistanceKm", t.actual_distance_source AS "actualDistanceSource",
         t.cargo_weight_kg::float8 AS "cargoWeightKg", t.cargo_kind AS "cargoKind",
         t.version, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
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

  /** Internal ids by public id, for another module's foreign key (an alert's trip). Unknown ones are left out. */
  async idsByPublicIds(db: Queryable, publicIds: readonly string[]): Promise<Map<string, string>> {
    if (publicIds.length === 0) return new Map();
    const res = await db.query<{ id: string; publicId: string }>('SELECT id, public_id AS "publicId" FROM trip.trips WHERE public_id = ANY($1::uuid[])', [publicIds]);
    return new Map(res.rows.map((r) => [r.publicId, r.id]));
  }

  /** Stops of these trips, in travel order. */
  async stops(db: Queryable, tripIds: readonly string[]): Promise<StopRow[]> {
    if (tripIds.length === 0) return [];
    const res = await db.query<StopRow>(
      `SELECT s.public_id AS id, s.trip_id AS "tripId", s.sequence_number AS "sequenceNumber", s.name,
              s.latitude::float8 AS latitude, s.longitude::float8 AS longitude, s.status,
              s.planned_arrival AS "plannedArrival", s.actual_arrival AS "actualArrival", s.eta, s.completed_at AS "completedAt"
         FROM trip.trip_stops s WHERE s.trip_id = ANY($1::bigint[]) ORDER BY s.trip_id, s.sequence_number`,
      [tripIds],
    );
    return res.rows;
  }

  /** A stop of a trip (internal trip id) by its public id, row-locked; with its internal id for the write. */
  async lockStop(client: PoolClient, tripId: string, stopPublicId: string): Promise<(StopRow & { internalId: string }) | null> {
    const res = await client.query<StopRow & { internalId: string }>(
      `SELECT s.id AS "internalId", s.public_id AS id, s.trip_id AS "tripId", s.sequence_number AS "sequenceNumber", s.name,
              s.latitude::float8 AS latitude, s.longitude::float8 AS longitude, s.status,
              s.planned_arrival AS "plannedArrival", s.actual_arrival AS "actualArrival", s.eta, s.completed_at AS "completedAt"
         FROM trip.trip_stops s WHERE s.trip_id = $1 AND s.public_id = $2::uuid FOR UPDATE`,
      [tripId, stopPublicId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Marks a stop done (FMS-95): completed now, by the user; reached now unless GPS already had it, so the estimate
   * (FMS-86) treats it as behind the vehicle. Audited.
   */
  completeStop(ctx: MutationContext, stop: { internalId: string; actualArrival: Date | null }, at: Date, notes: string | undefined, client: PoolClient): Promise<Row> {
    return this.mutate(
      ctx,
      'trip.trip_stops',
      'UPDATE',
      stop.internalId,
      { status: 'completed', completed_at: at, completed_by: ctx.userId, actual_arrival: stop.actualArrival ?? at, eta: null, ...(notes !== undefined ? { notes } : {}) },
      client,
    );
  }

  /** The latest estimate of these trips (internal ids), for those that have one. */
  async etas(db: Queryable, tripIds: readonly string[]): Promise<Map<string, EtaRow>> {
    if (tripIds.length === 0) return new Map();
    const res = await db.query<EtaRow>(
      `SELECT trip_id AS "tripId", arrival_at AS "arrivalAt", remaining_km::float8 AS "remainingKm", remaining_seconds AS "remainingSeconds",
              position_at AS "positionAt", computed_at AS "computedAt"
         FROM trip.trip_etas WHERE trip_id = ANY($1::bigint[]) AND computed_at IS NOT NULL`,
      [tripIds],
    );
    return new Map(res.rows.map((r) => [String(r.tripId), { ...r, tripId: String(r.tripId) }]));
  }

  /** A trip by public id with what its estimate needs (FMS-86). The destination is the route's, as its stops were copied from it. */
  async etaTrip(db: Queryable, publicId: string): Promise<EtaTrip | null> {
    const trip = await db.query<{
      id: string;
      publicId: string;
      status: TripStatus;
      lat: number | null;
      lng: number | null;
      depotId: string | null;
      vehicleId: string | null;
      driverId: string | null;
      scheduledEnd: Date | null;
      destinationName: string | null;
    }>(
      `SELECT t.id, t.public_id AS "publicId", t.status, r.destination_latitude::float8 AS lat, r.destination_longitude::float8 AS lng,
              r.depot_id AS "depotId", t.vehicle_id AS "vehicleId", t.driver_id AS "driverId", t.scheduled_end AS "scheduledEnd",
              coalesce(t.destination, r.destination_name) AS "destinationName"
         FROM trip.trips t LEFT JOIN trip.routes r ON r.id = t.route_id WHERE t.public_id = $1`,
      [publicId],
    );
    const row = trip.rows[0];
    if (!row) return null;
    const stops = await db.query<{ id: string; sequenceNumber: number; lat: number | null; lng: number | null; actualArrival: Date | null }>(
      `SELECT public_id AS id, sequence_number AS "sequenceNumber", latitude::float8 AS lat, longitude::float8 AS lng, actual_arrival AS "actualArrival"
         FROM trip.trip_stops WHERE trip_id = $1 ORDER BY sequence_number`,
      [row.id],
    );
    const point = (lat: number | null, lng: number | null): Coordinates | null => (lat === null || lng === null ? null : { latitude: lat, longitude: lng });
    return {
      id: String(row.id),
      publicId: row.publicId,
      status: row.status,
      destination: point(row.lat, row.lng),
      stops: stops.rows.map((s) => ({ id: s.id, sequenceNumber: s.sequenceNumber, coordinates: point(s.lat, s.lng), actualArrival: s.actualArrival })),
      depotId: row.depotId === null ? null : String(row.depotId),
      vehicleId: row.vehicleId === null ? null : String(row.vehicleId),
      driverId: row.driverId === null ? null : String(row.driverId),
      scheduledEnd: row.scheduledEnd,
      destinationName: row.destinationName,
    };
  }

  /** How late a trip was last alerted as, and how many times it fell late (FMS-147). Its estimate row is locked by claimEstimate. */
  async delayState(db: Queryable, tripId: string): Promise<DelayState> {
    const res = await db.query<DelayState>('SELECT delay_level AS level, delay_episode AS episode FROM trip.trip_etas WHERE trip_id = $1', [tripId]);
    return res.rows[0] ?? { level: null, episode: 0 };
  }

  async saveDelayState(db: Queryable, tripId: string, state: DelayState): Promise<void> {
    await db.query('UPDATE trip.trip_etas SET delay_level = $2, delay_episode = $3 WHERE trip_id = $1', [tripId, state.level, state.episode]);
  }

  /**
   * Claims the next estimate of a trip for a position: true when none was looked at yet, or the last one was
   * ETA_INTERVAL_SECONDS of position time before it. Locks the trip's estimate row until the transaction ends,
   * so two positions handled at once make one estimate.
   */
  async claimEstimate(db: Queryable, tripId: string, positionAt: Date): Promise<boolean> {
    const res = await db.query(
      `INSERT INTO trip.trip_etas (trip_id, checked_at_position) VALUES ($1, $2)
       ON CONFLICT (trip_id) DO UPDATE SET checked_at_position = EXCLUDED.checked_at_position
        WHERE trip.trip_etas.checked_at_position <= EXCLUDED.checked_at_position - make_interval(secs => $3)
       RETURNING trip_id`,
      [tripId, positionAt, ETA_INTERVAL_SECONDS],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Stops the vehicle has reached (public ids): arrived at `at`, no estimate any more. One already reached keeps its time. */
  async markStopsReached(db: Queryable, tripId: string, stopIds: readonly string[], at: Date): Promise<void> {
    if (stopIds.length === 0) return;
    await db.query(
      `UPDATE trip.trip_stops SET status = 'arrived', actual_arrival = $3, eta = NULL
        WHERE trip_id = $1 AND public_id = ANY($2::uuid[]) AND actual_arrival IS NULL`,
      [tripId, stopIds, at],
    );
  }

  /** A new estimate: each stop ahead gets its time, every other stop none, and the trip its arrival and what is left. */
  async saveEstimate(db: Queryable, tripId: string, result: EtaResult, positionAt: Date, computedAt: Date): Promise<void> {
    await db.query(
      `UPDATE trip.trip_stops s SET eta = v.eta
         FROM (SELECT s2.id, e.eta FROM trip.trip_stops s2
                 LEFT JOIN unnest($2::uuid[], $3::timestamptz[]) AS e(public_id, eta) ON e.public_id = s2.public_id
                WHERE s2.trip_id = $1) v
        WHERE s.id = v.id AND s.eta IS DISTINCT FROM v.eta`,
      [tripId, result.stops.map((s) => s.id), result.stops.map((s) => s.eta)],
    );
    await db.query(
      `UPDATE trip.trip_etas SET arrival_at = $2, remaining_km = $3, remaining_seconds = $4, position_at = $5, computed_at = $6 WHERE trip_id = $1`,
      [tripId, result.arrivalAt, result.remainingKm, result.remainingSeconds, positionAt, computedAt],
    );
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

  /**
   * Assigned and en-route trips of this driver or this vehicle whose window touches [start, end], except
   * `exceptIds`, earliest first and locked: the trips a time change runs into (FMS-139).
   */
  async clashing(db: Queryable, driverId: string | null, vehicleId: string | null, start: Date, end: Date, exceptIds: readonly string[]): Promise<Slot[]> {
    if (!driverId && !vehicleId) return [];
    const res = await db.query<Slot>(
      `SELECT id, public_id AS "publicId", driver_id AS "driverId", vehicle_id AS "vehicleId", status,
              scheduled_start AS start, scheduled_end AS "end"
         FROM trip.trips
        WHERE (driver_id = $1 OR vehicle_id = $2) AND status IN ('assigned', 'en_route') AND NOT (id = ANY($5::bigint[]))
          AND tstzrange(scheduled_start, scheduled_end, '[]') && tstzrange($3, $4, '[]')
        ORDER BY scheduled_start, id
          FOR UPDATE`,
      [driverId, vehicleId, start, end, exceptIds],
    );
    return res.rows.map((r) => ({ ...r, id: String(r.id), driverId: r.driverId === null ? null : String(r.driverId), vehicleId: r.vehicleId === null ? null : String(r.vehicleId) }));
  }

  /**
   * The drivers' trips that count against the distance limits (FMS-156): assigned, under way or completed, starting in
   * [from, to), other than `exceptTripId`; with what their job load needs (stops, cargo, vehicle). Internal ids.
   */
  async countedTrips(db: Queryable, driverIds: readonly string[], from: Date, to: Date, exceptTripId: string | null): Promise<CountedTripRow[]> {
    if (driverIds.length === 0) return [];
    const res = await db.query<CountedTripRow>(
      `SELECT t.id::text AS id, t.public_id AS "publicId", t.driver_id::text AS "driverId", t.vehicle_id::text AS "vehicleId", t.status,
              t.scheduled_start AS "scheduledStart", t.scheduled_end AS "scheduledEnd",
              t.planned_distance_km::float8 AS "plannedDistanceKm", t.planned_duration_seconds AS "plannedDurationSeconds",
              t.actual_distance_km::float8 AS "actualDistanceKm", t.cargo_weight_kg::float8 AS "cargoWeightKg",
              (SELECT count(*)::int FROM trip.trip_stops s WHERE s.trip_id = t.id) AS "stopCount"
         FROM trip.trips t
        WHERE t.driver_id = ANY($1::bigint[]) AND t.status IN ('assigned', 'en_route', 'completed')
          AND t.scheduled_start >= $2 AND t.scheduled_start < $3 AND ($4::bigint IS NULL OR t.id <> $4)
        ORDER BY t.scheduled_start, t.id`,
      [driverIds, from, to, exceptTripId],
    );
    return res.rows;
  }

  /** Serialises the distance limit's check of one driver (FMS-156): two trips assigned to them at once are checked one after the other. */
  async lockDriverDistance(client: PoolClient, driverId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('trip.driver-distance:' || $1::text, 0))`, [driverId]);
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

  /**
   * Completed trips to measure again (FMS-145): ended at or after `endedAfter`, and either never measured with no
   * distance, or measured by the system. A distance entered before FMS-145 (no measurement) is left alone. Newest first.
   */
  async distanceCandidates(db: Queryable, endedAfter: Date, limit: number): Promise<DistanceCandidate[]> {
    const res = await db.query<DistanceCandidate>(
      `${CANDIDATE_SQL}
        WHERE status = 'completed' AND actual_end >= $1 AND vehicle_id IS NOT NULL AND actual_start IS NOT NULL
          AND (actual_distance_measured_at IS NOT NULL OR actual_distance_km IS NULL)
        ORDER BY actual_end DESC, id DESC
        LIMIT $2`,
      [endedAfter, limit],
    );
    return res.rows;
  }

  /** Completed trips never measured and with no distance, after internal id `afterId`, oldest id first: the backfill. */
  async unmeasured(db: Queryable, afterId: string, limit: number): Promise<DistanceCandidate[]> {
    const res = await db.query<DistanceCandidate>(
      `${CANDIDATE_SQL}
        WHERE status = 'completed' AND actual_distance_km IS NULL AND actual_distance_measured_at IS NULL AND id > $1
        ORDER BY id
        LIMIT $2`,
      [afterId, limit],
    );
    return res.rows;
  }

  /** A candidate as it stands now, its row locked for the measurement's update; null if no longer completed. */
  async lockCandidate(client: PoolClient, id: string): Promise<DistanceCandidate | null> {
    const res = await client.query<DistanceCandidate>(`${CANDIDATE_SQL} WHERE id = $1 AND status = 'completed' FOR UPDATE`, [id]);
    return res.rows[0] ?? null;
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
