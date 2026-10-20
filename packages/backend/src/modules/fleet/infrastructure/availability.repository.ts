import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { AvailabilityWindow, DriverFacts, VehicleFacts } from '../domain/availability';
import type { AttendanceStatus } from '../domain/attendance';
import { OPERATING_TIME_ZONE } from '../domain/driver';
import type { VehicleStatus, VehicleType } from '../domain/vehicle';
import type { BoardTrip } from '../domain/dispatch';

/** An assignment as the read model holds it. */
export interface AssignmentRow {
  tripId: string;
  vehicleId: string | null;
  driverId: string | null;
  status: 'assigned' | 'en_route';
  start: Date;
  end: Date;
}

/** A trip's state as the trip module reports it (trip/index.ts). */
export interface TripState {
  tripId: string;
  status: string;
  vehicleId: string | null;
  driverId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
}

/** What a rebuild found: rows kept, rows it had to add or correct, and stale rows it removed. Repaired or removed rows mean a trip changed without its event. */
export interface RebuildResult {
  kept: number;
  repaired: number;
  removed: number;
}

const COMMITTED = ['assigned', 'en_route'];

/** Whether a trip in this state holds its vehicle and driver: assigned or under way, with both times. */
function commits(t: TripState): t is TripState & { scheduledStart: Date; scheduledEnd: Date } {
  return COMMITTED.includes(t.status) && t.scheduledStart !== null && t.scheduledEnd !== null;
}

/**
 * Where availability comes from (FMS-76). Vehicle status, maintenance flag,
 * driver accounts, licences and attendance are fleet's own tables, read live
 * in the caller's transaction. Trips belong to the trip module: fleet keeps
 * fleet.trip_assignments, its read model of the trips that hold a vehicle or
 * driver, from trip events, inside the trip change's transaction (a
 * projection), so it is never behind the trips. Derived data: not audited,
 * like driver_accounts.
 */
export const availabilityStore = {
  /** Status, flag and overlapping trips of these vehicles (internal ids); `excludeTripId` (public) is ignored, e.g. the trip being re-assigned. */
  async vehicleFacts(db: Queryable, vehicleIds: readonly string[], window: AvailabilityWindow, excludeTripId?: string): Promise<Map<string, VehicleFacts>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ id: string; depotId: string; status: VehicleStatus; maintenanceFlag: boolean; trips: string[] }>(
      `SELECT v.id, v.depot_id AS "depotId", v.status, v.maintenance_flag AS "maintenanceFlag",
              COALESCE(array_agg(a.trip_id::text ORDER BY lower(a.during)) FILTER (WHERE a.trip_id IS NOT NULL), '{}') AS trips
         FROM fleet.vehicles v
         LEFT JOIN fleet.trip_assignments a
           ON a.vehicle_id = v.id AND a.during && tstzrange($2, $3, '[]') AND ($4::uuid IS NULL OR a.trip_id <> $4)
        WHERE v.id = ANY($1::bigint[])
        GROUP BY v.id`,
      [vehicleIds, window.start, window.end, excludeTripId ?? null],
    );
    return new Map(res.rows.map((r) => [r.id, { depotId: r.depotId, status: r.status, maintenanceFlag: r.maintenanceFlag, overlappingTrips: r.trips }]));
  },

  /** Account (with its depot), licence, attendance on the window's first day (Addis Ababa) and overlapping trips of these drivers (internal ids). */
  async driverFacts(db: Queryable, driverIds: readonly string[], window: AvailabilityWindow, excludeTripId?: string): Promise<Map<string, DriverFacts>> {
    if (driverIds.length === 0) return new Map();
    const res = await db.query<{
      id: string;
      depotId: string | null;
      isActive: boolean;
      accountStatus: string;
      licenseValid: boolean;
      attendance: AttendanceStatus | null;
      trips: string[];
    }>(
      // No account copy (it should always exist) reads as not active: blocked, never silently available.
      `SELECT d.id, acc.depot_id AS "depotId", d.is_active AS "isActive", COALESCE(acc.account_status::text, 'unknown') AS "accountStatus",
              d.license_expiry >= ($2::timestamptz AT TIME ZONE $5)::date AS "licenseValid",
              att.status AS attendance,
              COALESCE(array_agg(a.trip_id::text ORDER BY lower(a.during)) FILTER (WHERE a.trip_id IS NOT NULL), '{}') AS trips
         FROM fleet.drivers d
         LEFT JOIN fleet.driver_accounts acc ON acc.user_id = d.user_id
         LEFT JOIN fleet.driver_attendance att
           ON att.driver_id = d.id AND att.attendance_date = ($2::timestamptz AT TIME ZONE $5)::date
         LEFT JOIN fleet.trip_assignments a
           ON a.driver_id = d.id AND a.during && tstzrange($2, $3, '[]') AND ($4::uuid IS NULL OR a.trip_id <> $4)
        WHERE d.id = ANY($1::bigint[])
        GROUP BY d.id, acc.depot_id, acc.account_status, att.status`,
      [driverIds, window.start, window.end, excludeTripId ?? null, OPERATING_TIME_ZONE],
    );
    return new Map(
      res.rows.map((r) => [r.id, { depotId: r.depotId, isActive: r.isActive, accountStatus: r.accountStatus, licenseValid: r.licenseValid, attendance: r.attendance, overlappingTrips: r.trips }]),
    );
  },

  /** A vehicle's trip under way or covering `at`, and its next one after `at`. */
  async vehicleAssignments(db: Queryable, vehicleId: string, at: Date): Promise<{ current: AssignmentRow | null; next: AssignmentRow | null }> {
    const res = await db.query<AssignmentRow & { kind: 'current' | 'next' }>(
      `SELECT * FROM (
         (SELECT 'current' AS kind, trip_id AS "tripId", vehicle_id AS "vehicleId", driver_id AS "driverId", status,
                 lower(during) AS start, upper(during) AS "end"
            FROM fleet.trip_assignments
           WHERE vehicle_id = $1 AND (status = 'en_route' OR during @> $2::timestamptz)
           ORDER BY (status = 'en_route') DESC, lower(during) LIMIT 1)
         UNION ALL
         (SELECT 'next', trip_id, vehicle_id, driver_id, status, lower(during), upper(during)
            FROM fleet.trip_assignments
           WHERE vehicle_id = $1 AND status = 'assigned' AND lower(during) > $2::timestamptz
           ORDER BY lower(during) LIMIT 1)
       ) x`,
      [vehicleId, at],
    );
    const pick = (kind: 'current' | 'next'): AssignmentRow | null => {
      const r = res.rows.find((row) => row.kind === kind);
      return r ? { tripId: r.tripId, vehicleId: r.vehicleId, driverId: r.driverId, status: r.status, start: r.start, end: r.end } : null;
    };
    const current = pick('current');
    const next = pick('next');
    return { current, next: next && next.tripId !== current?.tripId ? next : null };
  },

  /** A vehicle's assigned (not yet started) trips that end after `at`, earliest first. */
  async assignedAfter(db: Queryable, vehicleId: string, at: Date): Promise<{ tripId: string; start: Date }[]> {
    const res = await db.query<{ tripId: string; start: Date }>(
      `SELECT trip_id AS "tripId", lower(during) AS start FROM fleet.trip_assignments
        WHERE vehicle_id = $1 AND status = 'assigned' AND upper(during) > $2 ORDER BY lower(during), trip_id`,
      [vehicleId, at],
    );
    return res.rows;
  },

  /**
   * Brings one trip's row in line with its state: kept while it holds a
   * vehicle or driver, removed otherwise. Says whether the row changed: a
   * row already right is left alone (its synced_at too).
   */
  async apply(db: Queryable, trip: TripState | null, tripId: string): Promise<boolean> {
    if (!trip || !commits(trip)) {
      return ((await db.query('DELETE FROM fleet.trip_assignments WHERE trip_id = $1', [tripId])).rowCount ?? 0) > 0;
    }
    const res = await db.query(
      `INSERT INTO fleet.trip_assignments AS a (trip_id, vehicle_id, driver_id, status, during, synced_at)
       VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[]'), clock_timestamp())
       ON CONFLICT (trip_id) DO UPDATE
          SET vehicle_id = EXCLUDED.vehicle_id, driver_id = EXCLUDED.driver_id, status = EXCLUDED.status,
              during = EXCLUDED.during, synced_at = EXCLUDED.synced_at
        WHERE (a.vehicle_id, a.driver_id, a.status, a.during) IS DISTINCT FROM (EXCLUDED.vehicle_id, EXCLUDED.driver_id, EXCLUDED.status, EXCLUDED.during)`,
      [trip.tripId, trip.vehicleId, trip.driverId, trip.status, trip.scheduledStart, trip.scheduledEnd],
    );
    return (res.rowCount ?? 0) > 0;
  },

  // The dispatcher's board (FMS-33): who and what a depot can staff trips with.

  /** The depot's active drivers (their account's depot), by name. */
  async depotDrivers(db: Queryable, depotId: string): Promise<{ id: string; publicId: string; fullName: string; licenseCategories: string[] }[]> {
    const res = await db.query<{ id: string; publicId: string; fullName: string; licenseCategories: string[] }>(
      `SELECT d.id, d.public_id AS "publicId", acc.full_name AS "fullName", d.license_categories AS "licenseCategories"
         FROM fleet.drivers d JOIN fleet.driver_accounts acc ON acc.user_id = d.user_id
        WHERE acc.depot_id = $1 AND d.is_active
        ORDER BY acc.full_name, d.id`,
      [depotId],
    );
    return res.rows;
  },

  /** The depot's vehicles that are not retired, by plate. */
  async depotVehicles(
    db: Queryable,
    depotId: string,
  ): Promise<{ id: string; publicId: string; registrationNumber: string; make: string; model: string; vehicleType: VehicleType; status: VehicleStatus; maintenanceFlag: boolean }[]> {
    const res = await db.query<{ id: string; publicId: string; registrationNumber: string; make: string; model: string; vehicleType: VehicleType; status: VehicleStatus; maintenanceFlag: boolean }>(
      `SELECT id, public_id AS "publicId", registration_number AS "registrationNumber", make, model, vehicle_type AS "vehicleType",
              status, maintenance_flag AS "maintenanceFlag"
         FROM fleet.vehicles WHERE depot_id = $1 AND is_active
        ORDER BY registration_number, id`,
      [depotId],
    );
    return res.rows;
  },

  /** The trip each of these drivers or vehicles (internal ids) is under way on now, from the read model. */
  async underWay(db: Queryable, column: 'driver_id' | 'vehicle_id', ids: readonly string[]): Promise<Map<string, BoardTrip>> {
    if (ids.length === 0) return new Map();
    const res = await db.query<{ id: string; tripId: string; end: Date }>(
      `SELECT DISTINCT ON (${column}) ${column} AS id, trip_id AS "tripId", upper(during) AS "end"
         FROM fleet.trip_assignments
        WHERE ${column} = ANY($1::bigint[]) AND status = 'en_route'
        ORDER BY ${column}, lower(during)`,
      [ids],
    );
    return new Map(res.rows.map((r) => [r.id, { tripId: r.tripId, end: r.end }]));
  },

  /** Replaces the read model with these trips (the daily re-sync): stale rows go, the rest are refreshed. */
  async replaceAll(db: Queryable, trips: readonly TripState[]): Promise<RebuildResult> {
    const live = trips.filter(commits);
    const removed = await db.query('DELETE FROM fleet.trip_assignments WHERE NOT (trip_id = ANY($1::uuid[]))', [live.map((t) => t.tripId)]);
    let repaired = 0;
    for (const trip of live) if (await this.apply(db, trip, trip.tripId)) repaired += 1;
    return { kept: live.length, repaired, removed: removed.rowCount ?? 0 };
  },
};
