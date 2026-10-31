import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A vehicle as the command center counts it (FMS-89): its state and health snapshot. Internal ids. */
export interface CommandCenterVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  status: string;
  maintenanceFlag: boolean;
  healthScore: number | null;
  healthScoreUpdatedAt: Date | null;
}

/** An active driver as the command center counts them: whether their licence has expired and how they are marked today. */
export interface CommandCenterDriver {
  id: string;
  publicId: string;
  fullName: string | null;
  licenceExpired: boolean;
  /** The day's attendance status, or null when nobody has marked it. */
  attendance: string | null;
}

/** One depot's (internal id) vehicles in service, or every depot's (null): every status but retired. */
export async function commandCenterVehicles(db: Queryable, depotId: string | null): Promise<CommandCenterVehicle[]> {
  const res = await db.query<CommandCenterVehicle>(
    `SELECT v.id, v.public_id AS "publicId", v.registration_number AS "registrationNumber", v.status::text AS status,
            v.maintenance_flag AS "maintenanceFlag", v.health_score AS "healthScore", v.health_score_updated_at AS "healthScoreUpdatedAt"
       FROM fleet.vehicles v
      WHERE v.status <> 'retired' AND ($1::bigint IS NULL OR v.depot_id = $1)
      ORDER BY v.registration_number, v.id`,
    [depotId],
  );
  return res.rows;
}

/**
 * One depot's (or every depot's) active drivers with an active account, their licence as of `day` (an Addis Ababa
 * date, YYYY-MM-DD) and that day's attendance.
 */
export async function commandCenterDrivers(db: Queryable, depotId: string | null, day: string): Promise<CommandCenterDriver[]> {
  const res = await db.query<CommandCenterDriver>(
    `SELECT d.id, d.public_id AS "publicId", a.full_name AS "fullName", d.license_expiry < $2::date AS "licenceExpired", t.status AS attendance
       FROM fleet.drivers d
       JOIN fleet.driver_accounts a ON a.user_id = d.user_id
       LEFT JOIN fleet.driver_attendance t ON t.driver_id = d.id AND t.attendance_date = $2::date
      WHERE d.is_active AND a.account_status = 'active' AND ($1::bigint IS NULL OR a.depot_id = $1)
      ORDER BY d.id`,
    [depotId, day],
  );
  return res.rows;
}
