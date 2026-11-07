import type { Queryable } from '../../../shared/infrastructure/queryable';

/** Everything the fleet module holds about a driver, for their data export (FMS-104). Internal vehicle and trip ids are mapped by the caller. */
export interface DriverDataExport {
  /** Internal id: how the other modules find the driver's records. */
  driverId: string;
  driver: Record<string, unknown>;
  assignments: { id: string; vehicleId: string; type: string; status: string; from: string | null; until: string | null }[];
  attendance: { id: string; date: string; status: string; notes: string | null }[];
  dvirReports: { id: string; vehicleId: string; tripId: string | null; inspectionType: string; status: string; issuesFound: boolean; defects: unknown; submittedAt: string | null }[];
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The driver behind a user account, with their fleet records; null when the user is not a driver. The queries run one
 * after another: callers may hand over a single connection.
 */
export async function driverDataExport(db: Queryable, userId: string): Promise<DriverDataExport | null> {
  const found = await db.query<Record<string, unknown> & { internal_id: string }>(
    `SELECT d.id AS internal_id, d.public_id AS id, d.license_number, d.license_expiry::text AS license_expiry, d.license_categories,
            d.hire_date::text AS hire_date, d.emergency_phone, d.is_active, ${iso('d.created_at')} AS created_at
       FROM fleet.drivers d WHERE d.user_id = $1`,
    [userId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const { internal_id: driverId, ...driver } = row;
  const assignments = await db.query(
    `SELECT a.public_id AS id, a.vehicle_id AS "vehicleId", a.assignment_type::text AS type, a.status::text AS status,
            ${iso('a.assigned_from')} AS "from", ${iso('a.assigned_until')} AS until
       FROM fleet.driver_vehicle_assignments a WHERE a.driver_id = $1 ORDER BY a.assigned_from, a.id`,
    [driverId],
  );
  const attendance = await db.query(
    `SELECT public_id AS id, attendance_date::text AS date, status::text AS status, notes FROM fleet.driver_attendance WHERE driver_id = $1 ORDER BY attendance_date`,
    [driverId],
  );
  const dvir = await db.query(
    `SELECT public_id AS id, vehicle_id AS "vehicleId", trip_id AS "tripId", inspection_type::text AS "inspectionType", status::text AS status,
            issues_found AS "issuesFound", defects, ${iso('submitted_at')} AS "submittedAt"
       FROM fleet.dvir_reports WHERE driver_id = $1 ORDER BY submitted_at NULLS LAST, id`,
    [driverId],
  );
  return {
    driverId,
    driver,
    assignments: assignments.rows as DriverDataExport['assignments'],
    attendance: attendance.rows as DriverDataExport['attendance'],
    dvirReports: dvir.rows as DriverDataExport['dvirReports'],
  };
}
