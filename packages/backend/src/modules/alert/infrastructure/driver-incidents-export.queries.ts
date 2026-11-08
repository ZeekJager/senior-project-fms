import type { Queryable } from '../../../shared/infrastructure/queryable';

/** The incident reports about a driver or filed by their account, for their data export (FMS-104). Ids are internal: the caller maps them. */
export interface DriverIncidentExport {
  id: string;
  vehicleId: string | null;
  tripId: string | null;
  incidentType: string;
  severity: string;
  description: string;
  occurredAt: string;
  status: string;
}

export async function driverIncidentsExport(db: Queryable, driverId: string | null, userId: string): Promise<DriverIncidentExport[]> {
  const res = await db.query<DriverIncidentExport>(
    `SELECT public_id AS id, vehicle_id AS "vehicleId", trip_id AS "tripId", incident_type::text AS "incidentType", severity::text AS severity, description,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt", status::text AS status
       FROM alert.incident_reports WHERE reported_by = $2 OR ($1::bigint IS NOT NULL AND driver_id = $1) ORDER BY occurred_at, id`,
    [driverId, userId],
  );
  return res.rows;
}
