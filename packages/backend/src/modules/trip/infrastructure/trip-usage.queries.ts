import type { Queryable } from '../../../shared/infrastructure/queryable';

/** What a vehicle's completed trips add up to: kilometres and driving seconds. */
export interface TripUsage {
  distanceKm: number;
  drivingSeconds: number;
}

/**
 * For the nightly scoring (FMS-55): each vehicle's completed trips whose actual_end is in [from, to),
 * summed. Vehicles (internal ids) with none are absent.
 */
export async function completedTripUsage(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, TripUsage>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<{ vehicleId: string } & TripUsage>(
    `SELECT vehicle_id AS "vehicleId", coalesce(sum(actual_distance_km), 0)::float8 AS "distanceKm",
            coalesce(sum(actual_duration_seconds), 0)::float8 AS "drivingSeconds"
       FROM trip.trips
      WHERE vehicle_id = ANY($1::bigint[]) AND status = 'completed' AND actual_end >= $2 AND actual_end < $3
      GROUP BY vehicle_id`,
    [vehicleIds, from, to],
  );
  return new Map(res.rows.map(({ vehicleId, ...usage }) => [vehicleId, usage]));
}

/**
 * For the nightly scoring's part history (FMS-55): for each (vehicle, after), the kilometres of the
 * vehicle's completed trips that ended after `after` and before `before`. Answers in the order asked.
 */
export async function completedDistanceAfter(db: Queryable, since: readonly { vehicleId: string; after: Date }[], before: Date): Promise<number[]> {
  if (since.length === 0) return [];
  const res = await db.query<{ ord: string; km: number }>(
    `SELECT s.ord, coalesce(sum(t.actual_distance_km), 0)::float8 AS km
       FROM unnest($1::bigint[], $2::timestamptz[]) WITH ORDINALITY AS s(vehicle_id, after, ord)
       LEFT JOIN trip.trips t
         ON t.vehicle_id = s.vehicle_id AND t.status = 'completed' AND t.actual_end > s.after AND t.actual_end < $3
      GROUP BY s.ord
      ORDER BY s.ord`,
    [since.map((s) => s.vehicleId), since.map((s) => s.after), before],
  );
  return res.rows.map((r) => r.km);
}
