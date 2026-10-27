import { createHash } from 'node:crypto';
import type { Queryable } from '../../src/shared/infrastructure/queryable';

// The business content of the seeded tables, without what differs on every
// run by design: generated ids, public ids, created/updated timestamps (but a
// vehicle's created_at, its registration date, is the seed's and is kept),
// password hashes (salted) and audit correlation ids. Two runs with the same
// seed and anchor must give the same hash.
const QUERIES: Record<string, string> = {
  depots: 'SELECT code, name, city, latitude, longitude, capacity FROM fleet.depots ORDER BY code',
  users: `SELECT u.email, u.full_name, u.phone, u.status, d.code AS depot, u.password_hash LIKE '$argon2%' AS can_sign_in,
                 array(SELECT r.name FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.name) AS roles
            FROM auth.users u LEFT JOIN fleet.depots d ON d.id = u.depot_id ORDER BY u.email`,
  vehicles: `SELECT v.registration_number, v.vin, v.make, v.model, v.model_year, v.vehicle_type, v.fuel_type, v.fuel_efficiency_ml_per_km,
                    v.odometer_km, v.status, v.maintenance_flag, v.created_at, d.code AS depot
               FROM fleet.vehicles v JOIN fleet.depots d ON d.id = v.depot_id ORDER BY v.registration_number`,
  drivers: `SELECT dr.license_number, dr.license_categories, dr.license_expiry::text, dr.hire_date::text, dr.emergency_phone, u.email
              FROM fleet.drivers dr JOIN auth.users u ON u.id = dr.user_id ORDER BY dr.license_number`,
  parts: 'SELECT part_number, name, unit_cost_cents, stock_quantity, reorder_threshold, service_item FROM maintenance.inventory_parts ORDER BY part_number',
  movements: `SELECT p.part_number, m.movement_type, m.quantity_delta FROM maintenance.inventory_movements m
                JOIN maintenance.inventory_parts p ON p.id = m.inventory_part_id ORDER BY p.part_number, m.movement_type, m.quantity_delta`,
  maintenance: `SELECT v.registration_number, r.description, r.maintenance_type, r.status, r.priority, r.labor_hours, r.total_cost_cents,
                       r.scheduled_at, r.completed_at, r.odometer_km, r.workshop,
                       array(SELECT p.part_number || 'x' || mp.quantity FROM maintenance.maintenance_parts mp
                               JOIN maintenance.inventory_parts p ON p.id = mp.inventory_part_id
                              WHERE mp.maintenance_record_id = r.id ORDER BY p.part_number) AS parts
                  FROM maintenance.maintenance_records r JOIN fleet.vehicles v ON v.id = r.vehicle_id
                 ORDER BY v.registration_number, r.description, r.completed_at NULLS LAST, r.scheduled_at NULLS LAST, r.total_cost_cents`,
  failures: `SELECT v.registration_number, r.description, f.component, f.failure_mode, f.unplanned, f.detected_by, f.occurred_at, f.odometer_km
               FROM maintenance.failure_events f JOIN fleet.vehicles v ON v.id = f.vehicle_id
               JOIN maintenance.maintenance_records r ON r.id = f.maintenance_record_id
              ORDER BY f.occurred_at, v.registration_number, f.component`,
  attendance: `SELECT dr.license_number, a.attendance_date::text, a.status FROM fleet.driver_attendance a
                 JOIN fleet.drivers dr ON dr.id = a.driver_id ORDER BY dr.license_number, a.attendance_date`,
  documents: `SELECT v.registration_number, doc.document_type, doc.original_filename, doc.content_type, doc.size_bytes, doc.sha256, doc.expires_on::text
                FROM document.documents doc JOIN fleet.vehicles v ON doc.owner_type = 'vehicle' AND v.id = doc.owner_id
               ORDER BY v.registration_number, doc.document_type`,
  routes: `SELECT r.name, d.code AS depot, r.distance_km, r.estimated_duration_seconds FROM trip.routes r
             JOIN fleet.depots d ON d.id = r.depot_id ORDER BY d.code, r.name`,
  trips: `SELECT r.name AS route, v.registration_number, dr.license_number, t.status, t.scheduled_start, t.scheduled_end,
                 t.actual_start, t.actual_end, t.planned_distance_km, t.actual_distance_km, t.actual_duration_seconds
            FROM trip.trips t JOIN trip.routes r ON r.id = t.route_id
            LEFT JOIN fleet.vehicles v ON v.id = t.vehicle_id LEFT JOIN fleet.drivers dr ON dr.id = t.driver_id
           ORDER BY t.scheduled_start NULLS LAST, r.name, t.status, v.registration_number NULLS LAST, dr.license_number NULLS LAST`,
  // Meter readings (FMS-126): a manual one is recorded when the seed registers the vehicle, so its time is left out.
  meters: `SELECT v.registration_number, m.meter, m.value, m.source, m.suspect, CASE WHEN m.source = 'manual' THEN NULL ELSE m.recorded_at END AS recorded_at
             FROM fleet.meter_readings m JOIN fleet.vehicles v ON v.id = m.vehicle_id
            ORDER BY v.registration_number, m.meter, m.source, m.value, 6 NULLS FIRST`,
  fuel: `SELECT v.registration_number, dr.license_number, f.fuel_type, f.quantity_ml, f.unit_price_cents, f.total_cost_cents,
                f.odometer_km, f.station_name, f.source, f.recorded_at
           FROM fuel.fuel_logs f JOIN fleet.vehicles v ON v.id = f.vehicle_id LEFT JOIN fleet.drivers dr ON dr.id = f.driver_id
          ORDER BY f.recorded_at, v.registration_number`,
  // GPS tracks (FMS-136): about 55,000 pings on the budget profile, so per vehicle, not row by row.
  gps: `SELECT v.registration_number, count(*) AS pings, min(p.recorded_at) AS first, max(p.recorded_at) AS last,
               sum(p.latitude) AS lat, sum(p.longitude) AS lng, sum(p.speed_kmh) AS speed, sum(p.heading_degrees) AS heading
          FROM tracking.gps_pings p JOIN fleet.vehicles v ON v.id = p.vehicle_id
         GROUP BY v.registration_number ORDER BY v.registration_number`,
};

/** SHA-256 (hex) over every query's rows, in a fixed order. */
export async function fingerprint(db: Queryable): Promise<string> {
  const hash = createHash('sha256');
  for (const [name, sql] of Object.entries(QUERIES)) {
    const res = await db.query(sql);
    hash.update(`${name}:${JSON.stringify(res.rows)}\n`);
  }
  return hash.digest('hex');
}
