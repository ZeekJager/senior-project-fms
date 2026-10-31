import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A vehicle as preventive service programs see it (FMS-129, maintenance module). Internal ids. */
export interface ServiceVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  depotId: string;
  vehicleType: string;
  fuelType: string;
  make: string;
  model: string;
  /** Its odometer now: the highest trusted reading (FMS-126). */
  odometerKm: number;
  /** Its highest trusted engine-hour reading; null: none yet (no device reports its ignition). */
  engineHours: number | null;
  /** Its first trusted odometer reading: when the fleet started counting it, and at what (0 km at registration without one). */
  firstReadingAt: Date;
  firstReadingKm: number;
}

/**
 * The vehicles in service (not retired), or those of `ids` among them, in id order, with their meters
 * now and their first odometer reading. A vehicle without readings counts from 0 km when it was registered:
 * a fixed point, where its current odometer would move with every kilometre.
 */
export async function serviceVehicles(db: Queryable, ids: readonly string[] | null): Promise<ServiceVehicle[]> {
  const res = await db.query<ServiceVehicle>(
    `SELECT v.id, v.public_id AS "publicId", v.registration_number AS "registrationNumber", v.depot_id AS "depotId",
            v.vehicle_type::text AS "vehicleType", v.fuel_type::text AS "fuelType", v.make, v.model,
            v.odometer_km::float8 AS "odometerKm",
            (SELECT max(value)::float8 FROM fleet.meter_readings
              WHERE vehicle_id = v.id AND meter = 'engine_hours' AND NOT suspect) AS "engineHours",
            COALESCE(f.recorded_at, v.created_at) AS "firstReadingAt",
            COALESCE(f.value, 0)::float8 AS "firstReadingKm"
       FROM fleet.vehicles v
       LEFT JOIN LATERAL (
         SELECT recorded_at, value FROM fleet.meter_readings
          WHERE vehicle_id = v.id AND meter = 'odometer' AND NOT suspect
          ORDER BY recorded_at, id LIMIT 1
       ) f ON TRUE
      WHERE v.is_active AND v.status <> 'retired' AND ($1::bigint[] IS NULL OR v.id = ANY($1::bigint[]))
      ORDER BY v.id`,
    [ids],
  );
  return res.rows;
}

/**
 * Each vehicle's meters at a past time (a completed service): the highest trusted odometer and engine-hour
 * readings recorded at or before it, in the order asked; null where there is none.
 */
export async function metersAt(
  db: Queryable,
  asks: readonly { vehicleId: string; at: Date }[],
): Promise<{ odometerKm: number | null; engineHours: number | null }[]> {
  if (asks.length === 0) return [];
  const res = await db.query<{ n: number; odometerKm: number | null; engineHours: number | null }>(
    `SELECT a.n,
            (SELECT max(value)::float8 FROM fleet.meter_readings
              WHERE vehicle_id = a.vehicle_id AND meter = 'odometer' AND NOT suspect AND recorded_at <= a.at) AS "odometerKm",
            (SELECT max(value)::float8 FROM fleet.meter_readings
              WHERE vehicle_id = a.vehicle_id AND meter = 'engine_hours' AND NOT suspect AND recorded_at <= a.at) AS "engineHours"
       FROM unnest($1::bigint[], $2::timestamptz[]) WITH ORDINALITY AS a(vehicle_id, at, n)
      ORDER BY a.n`,
    [asks.map((a) => a.vehicleId), asks.map((a) => a.at)],
  );
  return res.rows.map(({ odometerKm, engineHours }) => ({ odometerKm, engineHours }));
}
