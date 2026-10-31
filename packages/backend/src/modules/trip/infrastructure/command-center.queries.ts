import type { Queryable } from '../../../shared/infrastructure/queryable';

/** The trips the command center counts (FMS-89): the day's by status, and those under way now. Internal ids. */
export interface TripBoard {
  /** Trips scheduled to start in the day, by status. */
  today: { status: string; n: number }[];
  /** Every trip under way, whenever it was scheduled; `overdue` when it is past its scheduled end. */
  underWay: { vehicleId: string | null; driverId: string | null; overdue: boolean }[];
}

/** One depot's (internal id, through the trip's route) or every depot's (null) trips: the day is [from, to). A trip with no route belongs to no depot. */
export async function tripBoard(db: Queryable, depotId: string | null, from: Date, to: Date, now: Date): Promise<TripBoard> {
  const today = await db.query<{ status: string; n: number }>(
    `SELECT t.status::text AS status, count(*)::int AS n
       FROM trip.trips t LEFT JOIN trip.routes r ON r.id = t.route_id
      WHERE t.scheduled_start >= $2 AND t.scheduled_start < $3 AND ($1::bigint IS NULL OR r.depot_id = $1)
      GROUP BY t.status`,
    [depotId, from, to],
  );
  const underWay = await db.query<{ vehicleId: string | null; driverId: string | null; overdue: boolean }>(
    `SELECT t.vehicle_id AS "vehicleId", t.driver_id AS "driverId", COALESCE(t.scheduled_end < $2, false) AS overdue
       FROM trip.trips t LEFT JOIN trip.routes r ON r.id = t.route_id
      WHERE t.status = 'en_route' AND ($1::bigint IS NULL OR r.depot_id = $1)`,
    [depotId, now],
  );
  return { today: today.rows, underWay: underWay.rows };
}
