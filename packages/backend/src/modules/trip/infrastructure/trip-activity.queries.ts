import type { Queryable } from '../../../shared/infrastructure/queryable';

/** Trip statuses in which a vehicle is committed to a trip. */
export const ACTIVE_TRIP_STATUSES = ['assigned', 'en_route'] as const;

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
export async function activeTripsForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, ActiveTrip>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<ActiveTrip & { vehicle_id: string }>(
    `SELECT DISTINCT ON (t.vehicle_id)
            t.vehicle_id, t.public_id AS id, t.status, t.origin, t.destination, t.scheduled_start
       FROM trip.trips t
      WHERE t.vehicle_id = ANY($1::bigint[]) AND t.status = ANY($2::trip.trip_status[])
      ORDER BY t.vehicle_id, (t.status = 'en_route') DESC, t.scheduled_start ASC NULLS LAST, t.id`,
    [vehicleIds, ACTIVE_TRIP_STATUSES],
  );
  return new Map(res.rows.map(({ vehicle_id, ...trip }) => [vehicle_id, trip]));
}
