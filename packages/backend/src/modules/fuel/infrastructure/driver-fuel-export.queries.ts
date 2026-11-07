import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A driver's fuel logs, for their data export (FMS-104). `vehicleId` and `tripId` are internal: the caller maps them. */
export interface DriverFuelLogExport {
  id: string;
  vehicleId: string;
  tripId: string | null;
  fuelType: string;
  quantityMl: number;
  totalCostCents: number;
  odometerKm: number | null;
  latitude: number | null;
  longitude: number | null;
  stationName: string | null;
  recordedAt: string;
}

export async function driverFuelLogsExport(db: Queryable, driverId: string): Promise<DriverFuelLogExport[]> {
  const res = await db.query<DriverFuelLogExport>(
    `SELECT public_id AS id, vehicle_id AS "vehicleId", trip_id AS "tripId", fuel_type::text AS "fuelType", quantity_ml::float8 AS "quantityMl",
            total_cost_cents AS "totalCostCents", odometer_km::float8 AS "odometerKm", latitude::float8 AS latitude, longitude::float8 AS longitude,
            station_name AS "stationName", to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
       FROM fuel.fuel_logs WHERE driver_id = $1 ORDER BY recorded_at, id`,
    [driverId],
  );
  return res.rows;
}
