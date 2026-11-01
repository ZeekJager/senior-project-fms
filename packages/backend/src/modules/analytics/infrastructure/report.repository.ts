import type { Queryable } from '../../../shared/infrastructure/queryable';
import { ON_TIME_GRACE_MINUTES } from '../domain/kpis';
import { audience, type Audience } from './analytics.repository';

// The monthly reports' reads (FMS-91, docs/reports.md): analytics.* views only, on the caller's read session (the
// replica when it is up). Each takes the month as [start, end) and the caller's audience (depot scope, and a depot
// chosen); a vehicle report scopes by the vehicle's depot, the trip history by the route's, drivers by their home
// depot. Integers in base units: ml, cents, metres, minutes.

const n = (v: unknown): number => Number(v ?? 0);
const nullable = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface FuelRow {
  registrationNumber: string;
  depot: string;
  fuelType: string;
  ratedMlPerKm: number | null;
  fillUps: number;
  fuelMl: number;
  fuelCostCents: number;
  distanceM: number;
}

export interface MaintenanceRow {
  registrationNumber: string;
  depot: string;
  completed: number;
  preventive: number;
  corrective: number;
  other: number;
  open: number;
  labourMinutes: number;
  costCents: number;
}

export interface CostRow {
  registrationNumber: string;
  depot: string;
  distanceM: number;
  fuelCostCents: number;
  maintenanceCostCents: number;
}

export interface TripRow {
  scheduledStart: Date | null;
  routeName: string | null;
  origin: string | null;
  destination: string | null;
  registrationNumber: string | null;
  driver: string | null;
  status: string;
  actualStart: Date | null;
  actualEnd: Date | null;
  plannedDistanceM: number | null;
  actualDistanceM: number | null;
  onTime: boolean | null;
}

export interface DriverRow {
  driver: string;
  depot: string;
  tripsCompleted: number;
  distanceM: number;
  drivingMinutes: number;
  tripsTimed: number;
  tripsOnTime: number;
  speeding: number;
  idling: number;
  incidents: number;
}

/** Completed trips by when they ended in the month: their km and driving time. */
const DRIVEN = `SELECT vehicle_id, SUM(ROUND(COALESCE(actual_distance_km, 0) * 1000))::bigint AS metres
                FROM analytics.trip_facts WHERE status = 'completed' AND actual_end >= $1 AND actual_end < $2 GROUP BY 1`;

export class ReportRepository {
  /** Every vehicle that was filled or driven in the month, most fuel first. */
  async fuel(db: Queryable, a: Audience, start: Date, end: Date): Promise<FuelRow[]> {
    const w = audience(a, 'v.depot_id', 3);
    const res = await db.query(
      `WITH fills AS (
         SELECT vehicle_id, COUNT(*)::int AS fill_ups, SUM(quantity_ml)::bigint AS ml, SUM(total_cost_cents)::bigint AS cents
         FROM analytics.fuel_facts WHERE recorded_at >= $1 AND recorded_at < $2 GROUP BY 1
       ),
       driven AS (${DRIVEN})
       SELECT v.registration_number, v.depot_name, v.fuel_type, v.fuel_efficiency_ml_per_km,
              COALESCE(f.fill_ups, 0) AS fill_ups, COALESCE(f.ml, 0) AS ml, COALESCE(f.cents, 0) AS cents, COALESCE(d.metres, 0) AS metres
       FROM analytics.vehicle_directory v
       LEFT JOIN fills f ON f.vehicle_id = v.vehicle_id
       LEFT JOIN driven d ON d.vehicle_id = v.vehicle_id
       WHERE (f.vehicle_id IS NOT NULL OR d.vehicle_id IS NOT NULL) AND ${w.sql}
       ORDER BY ml DESC, v.registration_number`,
      [start, end, ...w.params],
    );
    return res.rows.map((r) => ({
      registrationNumber: r.registration_number,
      depot: r.depot_name,
      fuelType: r.fuel_type,
      ratedMlPerKm: nullable(r.fuel_efficiency_ml_per_km),
      fillUps: n(r.fill_ups),
      fuelMl: n(r.ml),
      fuelCostCents: n(r.cents),
      distanceM: n(r.metres),
    }));
  }

  /**
   * Every vehicle with repairs completed in the month, or still open at its end, most cost first. A repair counts
   * as preventive, corrective, or inspection and other (inspection, predictive, other). Open at the month's end:
   * opened before it and not completed by then (a cancelled one is left out: when it was cancelled is not kept).
   */
  async maintenance(db: Queryable, a: Audience, start: Date, end: Date): Promise<MaintenanceRow[]> {
    const w = audience(a, 'v.depot_id', 3);
    const res = await db.query(
      `WITH done AS (
         SELECT vehicle_id, COUNT(*)::int AS completed,
                COUNT(*) FILTER (WHERE maintenance_type = 'preventive')::int AS preventive,
                COUNT(*) FILTER (WHERE maintenance_type = 'corrective')::int AS corrective,
                ROUND(SUM(COALESCE(labor_hours, 0)) * 60)::bigint AS minutes,
                SUM(COALESCE(total_cost_cents, 0))::bigint AS cents
         FROM analytics.maintenance_facts
         WHERE status = 'completed' AND completed_at >= $1 AND completed_at < $2 GROUP BY 1
       ),
       open AS (
         SELECT vehicle_id, COUNT(*)::int AS open FROM analytics.maintenance_facts
         WHERE created_at < $2 AND (status IN ('scheduled', 'open', 'in_progress') OR (status = 'completed' AND completed_at >= $2)) GROUP BY 1
       )
       SELECT v.registration_number, v.depot_name, COALESCE(d.completed, 0) AS completed, COALESCE(d.preventive, 0) AS preventive,
              COALESCE(d.corrective, 0) AS corrective, COALESCE(o.open, 0) AS open, COALESCE(d.minutes, 0) AS minutes, COALESCE(d.cents, 0) AS cents
       FROM analytics.vehicle_directory v
       LEFT JOIN done d ON d.vehicle_id = v.vehicle_id
       LEFT JOIN open o ON o.vehicle_id = v.vehicle_id
       WHERE (d.vehicle_id IS NOT NULL OR o.vehicle_id IS NOT NULL) AND ${w.sql}
       ORDER BY cents DESC, completed DESC, v.registration_number`,
      [start, end, ...w.params],
    );
    return res.rows.map((r) => {
      const completed = n(r.completed);
      const preventive = n(r.preventive);
      const corrective = n(r.corrective);
      return {
        registrationNumber: r.registration_number,
        depot: r.depot_name,
        completed,
        preventive,
        corrective,
        other: completed - preventive - corrective,
        open: n(r.open),
        labourMinutes: n(r.minutes),
        costCents: n(r.cents),
      };
    });
  }

  /** Every vehicle driven or costing anything in the month: km, fuel and repair costs. */
  async cost(db: Queryable, a: Audience, start: Date, end: Date): Promise<CostRow[]> {
    const w = audience(a, 'v.depot_id', 3);
    const res = await db.query(
      `WITH driven AS (${DRIVEN}),
       fuel AS (SELECT vehicle_id, SUM(total_cost_cents)::bigint AS cents FROM analytics.fuel_facts WHERE recorded_at >= $1 AND recorded_at < $2 GROUP BY 1),
       repairs AS (
         SELECT vehicle_id, SUM(COALESCE(total_cost_cents, 0))::bigint AS cents
         FROM analytics.maintenance_cost_facts WHERE completed_at >= $1 AND completed_at < $2 GROUP BY 1
       )
       SELECT v.registration_number, v.depot_name, COALESCE(d.metres, 0) AS metres, COALESCE(f.cents, 0) AS fuel, COALESCE(r.cents, 0) AS repairs
       FROM analytics.vehicle_directory v
       LEFT JOIN driven d ON d.vehicle_id = v.vehicle_id
       LEFT JOIN fuel f ON f.vehicle_id = v.vehicle_id
       LEFT JOIN repairs r ON r.vehicle_id = v.vehicle_id
       WHERE (d.vehicle_id IS NOT NULL OR f.vehicle_id IS NOT NULL OR r.vehicle_id IS NOT NULL) AND ${w.sql}
       ORDER BY COALESCE(f.cents, 0) + COALESCE(r.cents, 0) DESC, v.registration_number`,
      [start, end, ...w.params],
    );
    return res.rows.map((r) => ({
      registrationNumber: r.registration_number,
      depot: r.depot_name,
      distanceM: n(r.metres),
      fuelCostCents: n(r.fuel),
      maintenanceCostCents: n(r.repairs),
    }));
  }

  /** Every trip scheduled to start in the month, in the order they were due, with its vehicle and driver. */
  async trips(db: Queryable, a: Audience, start: Date, end: Date): Promise<TripRow[]> {
    const w = audience(a, 't.depot_id', 3);
    const res = await db.query(
      `SELECT t.scheduled_start, t.route_name, t.origin, t.destination, v.registration_number, d.full_name AS driver, t.status,
              t.actual_start, t.actual_end,
              ROUND(t.planned_distance_km * 1000)::bigint AS planned_m, ROUND(t.actual_distance_km * 1000)::bigint AS actual_m,
              CASE WHEN t.status = 'completed' AND t.scheduled_end IS NOT NULL
                   THEN t.actual_end <= t.scheduled_end + interval '${ON_TIME_GRACE_MINUTES} minutes' END AS on_time
       FROM analytics.trip_history_facts t
       LEFT JOIN analytics.vehicle_directory v ON v.vehicle_id = t.vehicle_id
       LEFT JOIN analytics.driver_directory d ON d.driver_id = t.driver_id
       WHERE t.scheduled_start >= $1 AND t.scheduled_start < $2 AND ${w.sql}
       ORDER BY t.scheduled_start, t.trip_id`,
      [start, end, ...w.params],
    );
    return res.rows.map((r) => ({
      scheduledStart: r.scheduled_start,
      routeName: r.route_name,
      origin: r.origin,
      destination: r.destination,
      registrationNumber: r.registration_number,
      driver: r.driver,
      status: r.status,
      actualStart: r.actual_start,
      actualEnd: r.actual_end,
      plannedDistanceM: nullable(r.planned_m),
      actualDistanceM: nullable(r.actual_m),
      onTime: r.on_time,
    }));
  }

  /**
   * Every driver who completed a trip, was flagged or had an incident in the month, most trips first: their trips'
   * km, driving time and punctuality, the speeding and idling flags raised on their trips, and their incidents.
   */
  async drivers(db: Queryable, a: Audience, start: Date, end: Date): Promise<DriverRow[]> {
    const w = audience(a, 'd.depot_id', 3);
    const res = await db.query(
      `WITH done AS (
         SELECT driver_id, COUNT(*)::int AS trips,
                SUM(ROUND(COALESCE(actual_distance_km, 0) * 1000))::bigint AS metres,
                SUM(ROUND(EXTRACT(EPOCH FROM actual_end - actual_start) / 60))::bigint AS minutes,
                COUNT(scheduled_end)::int AS timed,
                COUNT(*) FILTER (WHERE actual_end <= scheduled_end + interval '${ON_TIME_GRACE_MINUTES} minutes')::int AS on_time
         FROM analytics.trip_history_facts
         WHERE status = 'completed' AND driver_id IS NOT NULL AND actual_end >= $1 AND actual_end < $2 GROUP BY 1
       ),
       flags AS (
         SELECT driver_id, COUNT(*) FILTER (WHERE flag_type = 'speeding')::int AS speeding, COUNT(*) FILTER (WHERE flag_type = 'idling')::int AS idling
         FROM analytics.telemetry_flag_facts WHERE driver_id IS NOT NULL AND observed_at >= $1 AND observed_at < $2 GROUP BY 1
       ),
       incidents AS (
         SELECT driver_id, COUNT(*)::int AS incidents FROM analytics.incident_facts
         WHERE driver_id IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2 GROUP BY 1
       )
       SELECT d.full_name, d.depot_name, COALESCE(t.trips, 0) AS trips, COALESCE(t.metres, 0) AS metres, COALESCE(t.minutes, 0) AS minutes,
              COALESCE(t.timed, 0) AS timed, COALESCE(t.on_time, 0) AS on_time,
              COALESCE(f.speeding, 0) AS speeding, COALESCE(f.idling, 0) AS idling, COALESCE(i.incidents, 0) AS incidents
       FROM analytics.driver_directory d
       LEFT JOIN done t ON t.driver_id = d.driver_id
       LEFT JOIN flags f ON f.driver_id = d.driver_id
       LEFT JOIN incidents i ON i.driver_id = d.driver_id
       WHERE (t.driver_id IS NOT NULL OR f.driver_id IS NOT NULL OR i.driver_id IS NOT NULL) AND ${w.sql}
       ORDER BY trips DESC, d.full_name`,
      [start, end, ...w.params],
    );
    return res.rows.map((r) => ({
      driver: r.full_name,
      depot: r.depot_name ?? '',
      tripsCompleted: n(r.trips),
      distanceM: n(r.metres),
      drivingMinutes: n(r.minutes),
      tripsTimed: n(r.timed),
      tripsOnTime: n(r.on_time),
      speeding: n(r.speeding),
      idling: n(r.idling),
      incidents: n(r.incidents),
    }));
  }

  /** A depot in the caller's scope by public id: its internal id, name and code; null when unknown or out of scope. */
  async depot(db: Queryable, publicId: string, a: Audience): Promise<{ id: string; name: string; code: string } | null> {
    const w = audience({ scope: a.scope }, 'depot_id', 2);
    const res = await db.query<{ id: string; name: string; code: string }>(
      `SELECT depot_id::text AS id, name, code FROM analytics.depot_directory WHERE public_id = $1 AND ${w.sql}`,
      [publicId, ...w.params],
    );
    return res.rows[0] ?? null;
  }
}
