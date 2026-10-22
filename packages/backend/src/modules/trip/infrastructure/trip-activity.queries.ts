import type { Queryable } from '../../../shared/infrastructure/queryable';

/** Trip statuses in which a vehicle is committed to a trip. */
export const ACTIVE_TRIP_STATUSES = ['assigned', 'en_route'] as const;

/**
 * An SQL boolean: the vehicle whose internal id is `vehicleIdColumn` (a column
 * reference such as `v.id`, never user input) is on an assigned or en-route
 * trip. For another module's list filter, so it never names trip tables.
 */
export function vehicleOnActiveTripSql(vehicleIdColumn: string): string {
  const statuses = ACTIVE_TRIP_STATUSES.map((s) => `'${s}'`).join(', ');
  return `EXISTS (SELECT 1 FROM trip.trips active_trip WHERE active_trip.vehicle_id = ${vehicleIdColumn} AND active_trip.status = ANY(ARRAY[${statuses}]::trip.trip_status[]))`;
}

/**
 * True when the vehicle (internal id) is on a trip that is assigned or en
 * route. Pass the caller's transaction client so the answer is read in the
 * same transaction as the change that depends on it.
 */
export async function vehicleHasActiveTrip(db: Queryable, vehicleId: string): Promise<boolean> {
  const res = await db.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM trip.trips WHERE vehicle_id = $1 AND status = ANY($2::trip.trip_status[])
     ) AS active`,
    [vehicleId, ACTIVE_TRIP_STATUSES],
  );
  return res.rows[0].active;
}

/** True when the driver (internal fleet.drivers id) is on a trip that is assigned or en route. */
export async function driverHasActiveTrip(db: Queryable, driverId: string): Promise<boolean> {
  const res = await db.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM trip.trips WHERE driver_id = $1 AND status = ANY($2::trip.trip_status[])
     ) AS active`,
    [driverId, ACTIVE_TRIP_STATUSES],
  );
  return res.rows[0].active;
}

/**
 * A trip's commitment of a vehicle and driver, for fleet's availability read
 * model (FMS-76). Internal vehicle and driver ids: fleet's own keys.
 */
export interface TripAssignmentState {
  tripId: string;
  status: string;
  vehicleId: string | null;
  driverId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
}

const ASSIGNMENT_SQL = `
  SELECT public_id AS "tripId", status::text AS status, vehicle_id AS "vehicleId", driver_id AS "driverId",
         scheduled_start AS "scheduledStart", scheduled_end AS "scheduledEnd"
    FROM trip.trips`;

/** One trip's current state by public id, or null if there is no such trip. */
export async function tripAssignment(db: Queryable, tripPublicId: string): Promise<TripAssignmentState | null> {
  const res = await db.query<TripAssignmentState>(`${ASSIGNMENT_SQL} WHERE public_id = $1`, [tripPublicId]);
  return res.rows[0] ?? null;
}

/** Every assigned or en-route trip, for the daily re-sync of the read model. */
export async function activeAssignments(db: Queryable): Promise<TripAssignmentState[]> {
  const res = await db.query<TripAssignmentState>(`${ASSIGNMENT_SQL} WHERE status = ANY($1::trip.trip_status[]) ORDER BY id`, [ACTIVE_TRIP_STATUSES]);
  return res.rows;
}

/** A vehicle's current trip, as other modules show it (public ids only). */
export interface ActiveTrip {
  id: string;
  status: (typeof ACTIVE_TRIP_STATUSES)[number];
  origin: string | null;
  destination: string | null;
  scheduled_start: Date | null;
}

/**
 * The current trip of each vehicle (internal ids) that has one, keyed by
 * vehicle id: a trip en route before an assigned one, then the earliest
 * scheduled. Vehicles without an active trip are absent from the map.
 */
export function activeTripsForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, ActiveTrip>> {
  return activeTripsBy(db, 'vehicle_id', vehicleIds);
}

/** The same for drivers (internal fleet.drivers ids). */
export function activeTripsForDrivers(db: Queryable, driverIds: readonly string[]): Promise<Map<string, ActiveTrip>> {
  return activeTripsBy(db, 'driver_id', driverIds);
}

async function activeTripsBy(db: Queryable, column: 'vehicle_id' | 'driver_id', ids: readonly string[]): Promise<Map<string, ActiveTrip>> {
  if (ids.length === 0) return new Map();
  const res = await db.query<ActiveTrip & { owner_id: string }>(
    `SELECT DISTINCT ON (t.${column})
            t.${column} AS owner_id, t.public_id AS id, t.status, t.origin, t.destination, t.scheduled_start
       FROM trip.trips t
      WHERE t.${column} = ANY($1::bigint[]) AND t.status = ANY($2::trip.trip_status[])
      ORDER BY t.${column}, (t.status = 'en_route') DESC, t.scheduled_start ASC NULLS LAST, t.id`,
    [ids, ACTIVE_TRIP_STATUSES],
  );
  return new Map(res.rows.map(({ owner_id, ...trip }) => [owner_id, trip]));
}

/** A trip under way, both ids, for GPS ingestion (FMS-88): pings carry the trip's internal id. */
export interface EnRouteTrip {
  id: string;
  publicId: string;
  vehicleId: string | null;
}

/** The en-route trip of each vehicle (internal ids) that has one, keyed by vehicle id. */
export async function enRouteTripsForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, EnRouteTrip>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<EnRouteTrip>(
    `SELECT DISTINCT ON (t.vehicle_id) t.id, t.public_id AS "publicId", t.vehicle_id AS "vehicleId"
       FROM trip.trips t
      WHERE t.vehicle_id = ANY($1::bigint[]) AND t.status = 'en_route'
      ORDER BY t.vehicle_id, t.actual_start DESC NULLS LAST, t.id DESC`,
    [vehicleIds],
  );
  return new Map(res.rows.map((r) => [r.vehicleId as string, r]));
}

/** The trip a driver (internal id) has under way, with its vehicle; null when none is. A driver's phone reports only for it. */
export async function enRouteTripOfDriver(db: Queryable, driverId: string): Promise<EnRouteTrip | null> {
  const res = await db.query<EnRouteTrip>(
    `SELECT t.id, t.public_id AS "publicId", t.vehicle_id AS "vehicleId"
       FROM trip.trips t
      WHERE t.driver_id = $1 AND t.status = 'en_route'
      ORDER BY t.actual_start DESC NULLS LAST, t.id DESC
      LIMIT 1`,
    [driverId],
  );
  return res.rows[0] ?? null;
}

/** A trip under way as the live map shows it (FMS-45): the route's name, and the driver by internal id (fleet names them). */
export interface LiveTrip {
  vehicleId: string;
  /** Public id. */
  tripId: string;
  routeName: string | null;
  origin: string | null;
  destination: string | null;
  driverId: string | null;
  actualStart: Date | null;
  scheduledEnd: Date | null;
}

/** The en-route trip of each vehicle (internal ids) that has one, keyed by vehicle id. */
export async function liveTripsForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, LiveTrip>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<LiveTrip>(
    `SELECT DISTINCT ON (t.vehicle_id)
            t.vehicle_id AS "vehicleId", t.public_id AS "tripId", r.name AS "routeName", t.origin, t.destination,
            t.driver_id AS "driverId", t.actual_start AS "actualStart", t.scheduled_end AS "scheduledEnd"
       FROM trip.trips t
       LEFT JOIN trip.routes r ON r.id = t.route_id
      WHERE t.vehicle_id = ANY($1::bigint[]) AND t.status = 'en_route'
      ORDER BY t.vehicle_id, t.actual_start DESC NULLS LAST, t.id DESC`,
    [vehicleIds],
  );
  return new Map(res.rows.map((r) => [r.vehicleId, r]));
}

/** A trip's public id and its driver (internal id), for an event about something that happened on it (FMS-46). */
export interface TripParties {
  publicId: string;
  driverId: string | null;
}

/** Trips by internal id (a ping's or a flag's `trip_id`), keyed by that id. */
export async function tripPartiesByIds(db: Queryable, tripIds: readonly string[]): Promise<Map<string, TripParties>> {
  if (tripIds.length === 0) return new Map();
  const res = await db.query<TripParties & { id: string }>('SELECT id, public_id AS "publicId", driver_id AS "driverId" FROM trip.trips WHERE id = ANY($1::bigint[])', [tripIds]);
  return new Map(res.rows.map(({ id, ...rest }) => [id, rest]));
}
