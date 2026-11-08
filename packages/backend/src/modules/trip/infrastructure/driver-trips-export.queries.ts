import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A driver's trips, for their data export (FMS-104). `vehicleId` and `internalId` are internal: the caller maps or drops them. */
export interface DriverTripExport {
  id: string;
  internalId: string;
  vehicleId: string | null;
  status: string;
  origin: string;
  destination: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  actualDistanceKm: number | null;
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function driverTripsExport(db: Queryable, driverId: string): Promise<DriverTripExport[]> {
  const res = await db.query<DriverTripExport>(
    `SELECT public_id AS id, id AS "internalId", vehicle_id AS "vehicleId", status::text AS status, origin, destination,
            ${iso('scheduled_start')} AS "scheduledStart", ${iso('scheduled_end')} AS "scheduledEnd",
            ${iso('actual_start')} AS "actualStart", ${iso('actual_end')} AS "actualEnd", actual_distance_km::float8 AS "actualDistanceKm"
       FROM trip.trips WHERE driver_id = $1 ORDER BY scheduled_start NULLS LAST, id`,
    [driverId],
  );
  return res.rows;
}
