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
