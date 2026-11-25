import type { Queryable } from '../../../shared/infrastructure/queryable';
import { ON_TIME_GRACE_MINUTES } from '../domain/kpis';
import { NO_FILTERS, type ReportFilters, type ResolvedFilters } from '../domain/report-period';
import { audience, type Audience } from './analytics.repository';

// The reports' reads (FMS-91, FMS-160, docs/reports.md): analytics.* views only, on the caller's read session (the
// replica when it is up). Each takes the period as [start, end), the caller's audience (depot scope, and a depot
// chosen) and the filters: depots, vehicle type and vehicle narrow the vehicles (a trip's by its route's depot,
// a driver's by their home depot); a driver and a route narrow the facts a vehicle row sums (the trips driven, the
// fills logged on those trips or by that driver). Integers in base units: ml, cents, metres, minutes.

const n = (v: unknown): number => Number(v ?? 0);
const nullable = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Positional parameters, numbered as they are added. */
class Params {
  readonly values: unknown[];
  constructor(first: unknown[]) {
    this.values = [...first];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The audience's condition on a depot column, numbered from the parameters so far. */
function scoped(a: Audience, column: string, p: Params): string {
  const w = audience(a, column, p.values.length + 1);
  p.values.push(...w.params);
  return w.sql;
}

/** The filters on a vehicle row (`alias.vehicle_id`, `alias.depot_id`). */
function vehicleFilter(f: ResolvedFilters, alias: string, p: Params): string {
  const and: string[] = [];
  if (f.depotIds) and.push(`${alias}.depot_id = ANY(${p.add(f.depotIds)}::bigint[])`);
  if (f.vehicleId) and.push(`${alias}.vehicle_id = ${p.add(f.vehicleId)}`);
  if (f.vehicleType) and.push(`${alias}.vehicle_id IN (SELECT vehicle_id FROM analytics.report_vehicles WHERE vehicle_type = ${p.add(f.vehicleType)})`);
  return and.length ? and.join(' AND ') : 'TRUE';
}

/** The filters on a trip (`alias.trip_id`), by its driver and route. */
function tripFilter(f: ResolvedFilters, column: string, p: Params): string {
  const and: string[] = [];
  if (f.driverId) and.push(`driver_id = ${p.add(f.driverId)}`);
  if (f.routeId) and.push(`route_id = ${p.add(f.routeId)}`);
  return and.length ? `${column} IN (SELECT trip_id FROM analytics.report_trips WHERE ${and.join(' AND ')})` : 'TRUE';
}

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
  /** The driver's public id. */
  driverId: string;
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
  /** Of the incidents, the accidents: those the driver performance score counts (FMS-146). */
  accidents: number;
  /** Completed trips that had their driver's pre-trip inspection (FMS-146). */
  tripsInspected: number;
}

/** A vehicle of the audience, for the utilisation report: when it was in the fleet comes from the service spans. */
export interface VehicleRef {
  vehicleId: string;
  registrationNumber: string;
  depot: string;
}

export interface ComplianceRow {
  registrationNumber: string;
  depot: string;
  pmOnTime: number;
  pmLate: number;
  pmOverdue: number;
  corrective: number;
  repeatRepairs: number;
  unplannedFailures: number;
  costCents: number;
}

export interface CostBreakdownRow {
  key: string;
  repairs: number;
  costCents: number;
}

export interface SafetyRow {
  /** The depot, driver or route's name. */
  name: string;
  distanceM: number;
  incidents: number;
  accidents: number;
  speeding: number;
  idling: number;
  appealsOpened: number;
  appealsApproved: number;
}

/** Completed trips by when they ended in the period: their km, as the filters narrow the trips. */
function driven(f: ResolvedFilters, p: Params): string {
  return `SELECT vehicle_id, SUM(ROUND(COALESCE(actual_distance_km, 0) * 1000))::bigint AS metres
            FROM analytics.trip_facts WHERE status = 'completed' AND actual_end >= $1 AND actual_end < $2 AND ${tripFilter(f, 'trip_id', p)} GROUP BY 1`;
}

/** Fills logged in the period, by a filtered driver or on a filtered route's trips. */
function fills(f: ResolvedFilters, p: Params): string {
  const and: string[] = [];
  if (f.driverId) and.push(`driver_id = ${p.add(f.driverId)}`);
  if (f.routeId) and.push(`route_id = ${p.add(f.routeId)}`);
  return `SELECT vehicle_id, COUNT(*)::int AS fill_ups, SUM(quantity_ml)::bigint AS ml, SUM(total_cost_cents)::bigint AS cents
            FROM analytics.report_fuel WHERE recorded_at >= $1 AND recorded_at < $2${and.length ? ` AND ${and.join(' AND ')}` : ''} GROUP BY 1`;
}

/** The names a report's filters stand for. */
export interface FilterNames {
  depots: string[];
  vehicle: string | null;
  driver: string | null;
  route: string | null;
}

export class ReportRepository {
  /**
   * The filters' public ids as internal ids, each within the audience: a depot, vehicle, driver or route outside it
   * (or unknown) is `false`, which matches nothing, as a filter does elsewhere.
   */
  async resolveFilters(db: Queryable, a: Audience, f: ReportFilters): Promise<ResolvedFilters | false> {
    const out: ResolvedFilters = { ...NO_FILTERS, vehicleType: f.vehicle_type ?? null };
    if (f.depot_ids?.length) {
      const p = new Params([f.depot_ids]);
      const res = await db.query<{ id: string }>(`SELECT depot_id::text AS id FROM analytics.depot_directory WHERE public_id = ANY($1::uuid[]) AND ${scoped({ scope: a.scope }, 'depot_id', p)}`, p.values);
      if (res.rows.length !== new Set(f.depot_ids).size) return false;
      out.depotIds = res.rows.map((r) => r.id);
    }
    const one = async (sql: string, publicId: string, depotColumn: string) => {
      const p = new Params([publicId]);
      const res = await db.query<{ id: string }>(`${sql} AND ${scoped({ scope: a.scope }, depotColumn, p)}`, p.values);
      return res.rows[0]?.id ?? null;
    };
    if (f.vehicle_id) {
      out.vehicleId = await one('SELECT vehicle_id::text AS id FROM analytics.report_vehicles WHERE public_id = $1', f.vehicle_id, 'depot_id');
      if (!out.vehicleId) return false;
    }
    if (f.driver_id) {
      out.driverId = await one('SELECT driver_id::text AS id FROM analytics.driver_directory WHERE public_id = $1', f.driver_id, 'depot_id');
      if (!out.driverId) return false;
    }
    if (f.route_id) {
      out.routeId = await one('SELECT route_id::text AS id FROM analytics.route_directory WHERE public_id = $1', f.route_id, 'depot_id');
      if (!out.routeId) return false;
    }
    return out;
  }

  /** What the resolved filters name, for a report's filter lines: depot names, a registration, a driver, a route. */
  async filterNames(db: Queryable, f: ResolvedFilters): Promise<FilterNames> {
    const one = async (sql: string, id: string | null) => (id ? ((await db.query<{ v: string }>(sql, [id])).rows[0]?.v ?? null) : null);
    const depots = f.depotIds?.length
      ? (await db.query<{ v: string }>('SELECT name AS v FROM analytics.depot_directory WHERE depot_id = ANY($1::bigint[]) ORDER BY name', [f.depotIds])).rows.map((r) => r.v)
      : [];
    return {
      depots,
      vehicle: await one('SELECT registration_number AS v FROM analytics.report_vehicles WHERE vehicle_id = $1', f.vehicleId),
      driver: await one('SELECT full_name AS v FROM analytics.driver_directory WHERE driver_id = $1', f.driverId),
      route: await one('SELECT name AS v FROM analytics.route_directory WHERE route_id = $1', f.routeId),
    };
  }

  /** Every vehicle that was filled or driven in the period, most fuel first. */
  async fuel(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<FuelRow[]> {
    const p = new Params([start, end]);
    const fillSql = fills(f, p);
    const drivenSql = driven(f, p);
    const res = await db.query(
      `WITH fills AS (${fillSql}), driven AS (${drivenSql})
       SELECT v.registration_number, v.depot_name, v.fuel_type, v.fuel_efficiency_ml_per_km,
              COALESCE(f.fill_ups, 0) AS fill_ups, COALESCE(f.ml, 0) AS ml, COALESCE(f.cents, 0) AS cents, COALESCE(d.metres, 0) AS metres
       FROM analytics.vehicle_directory v
       LEFT JOIN fills f ON f.vehicle_id = v.vehicle_id
       LEFT JOIN driven d ON d.vehicle_id = v.vehicle_id
       WHERE (f.vehicle_id IS NOT NULL OR d.vehicle_id IS NOT NULL) AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
       ORDER BY ml DESC, v.registration_number`,
      p.values,
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
   * Every vehicle with repairs completed in the period, or still open at its end, most cost first. A repair counts
   * as preventive, corrective, or inspection and other (inspection, predictive, other). Open at the period's end:
   * opened before it and not completed by then (a cancelled one is left out: when it was cancelled is not kept).
   * A driver or route filter does not narrow repairs: they are the vehicle's.
   */
  async maintenance(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<MaintenanceRow[]> {
    const p = new Params([start, end]);
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
       WHERE (d.vehicle_id IS NOT NULL OR o.vehicle_id IS NOT NULL) AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
       ORDER BY cents DESC, completed DESC, v.registration_number`,
      p.values,
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

  /** Every vehicle driven or costing anything in the period: km, fuel and repair costs. */
  async cost(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<CostRow[]> {
    const p = new Params([start, end]);
    const drivenSql = driven(f, p);
    const fillSql = fills(f, p);
    const res = await db.query(
      `WITH driven AS (${drivenSql}),
       fuel AS (${fillSql}),
       repairs AS (
         SELECT vehicle_id, SUM(COALESCE(total_cost_cents, 0))::bigint AS cents
         FROM analytics.maintenance_cost_facts WHERE completed_at >= $1 AND completed_at < $2 GROUP BY 1
       )
       SELECT v.registration_number, v.depot_name, COALESCE(d.metres, 0) AS metres, COALESCE(f.cents, 0) AS fuel, COALESCE(r.cents, 0) AS repairs
       FROM analytics.vehicle_directory v
       LEFT JOIN driven d ON d.vehicle_id = v.vehicle_id
       LEFT JOIN fuel f ON f.vehicle_id = v.vehicle_id
       LEFT JOIN repairs r ON r.vehicle_id = v.vehicle_id
       WHERE (d.vehicle_id IS NOT NULL OR f.vehicle_id IS NOT NULL OR r.vehicle_id IS NOT NULL) AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
       ORDER BY COALESCE(f.cents, 0) + COALESCE(r.cents, 0) DESC, v.registration_number`,
      p.values,
    );
    return res.rows.map((r) => ({
      registrationNumber: r.registration_number,
      depot: r.depot_name,
      distanceM: n(r.metres),
      fuelCostCents: n(r.fuel),
      maintenanceCostCents: n(r.repairs),
    }));
  }

  /** Every trip scheduled to start in the period, in the order they were due, with its vehicle and driver. */
  async trips(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<TripRow[]> {
    const p = new Params([start, end]);
    const and: string[] = [scoped(a, 't.depot_id', p)];
    if (f.depotIds) and.push(`t.depot_id = ANY(${p.add(f.depotIds)}::bigint[])`);
    if (f.vehicleId) and.push(`t.vehicle_id = ${p.add(f.vehicleId)}`);
    if (f.vehicleType) and.push(`t.vehicle_id IN (SELECT vehicle_id FROM analytics.report_vehicles WHERE vehicle_type = ${p.add(f.vehicleType)})`);
    if (f.driverId) and.push(`t.driver_id = ${p.add(f.driverId)}`);
    if (f.routeId) and.push(`t.trip_id IN (SELECT trip_id FROM analytics.report_trips WHERE route_id = ${p.add(f.routeId)})`);
    const res = await db.query(
      `SELECT t.scheduled_start, t.route_name, t.origin, t.destination, v.registration_number, d.full_name AS driver, t.status,
              t.actual_start, t.actual_end,
              ROUND(t.planned_distance_km * 1000)::bigint AS planned_m, ROUND(t.actual_distance_km * 1000)::bigint AS actual_m,
              CASE WHEN t.status = 'completed' AND t.scheduled_end IS NOT NULL
                   THEN t.actual_end <= t.scheduled_end + interval '${ON_TIME_GRACE_MINUTES} minutes' END AS on_time
       FROM analytics.trip_history_facts t
       LEFT JOIN analytics.vehicle_directory v ON v.vehicle_id = t.vehicle_id
       LEFT JOIN analytics.driver_directory d ON d.driver_id = t.driver_id
       WHERE t.scheduled_start >= $1 AND t.scheduled_start < $2 AND ${and.join(' AND ')}
       ORDER BY t.scheduled_start, t.trip_id`,
      p.values,
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
   * Every driver who completed a trip, was flagged or had an incident in the period, most trips first: their trips'
   * km, driving time and punctuality, the speeding and idling flags raised on their trips, and their incidents; for the
   * driver performance score (FMS-146), their accidents and the trips they inspected before setting off. `ownUserId`
   * narrows it to one driver, by their sign-in. A vehicle, vehicle type or route filter narrows the trips and flags.
   */
  async drivers(db: Queryable, a: Audience, start: Date, end: Date, ownUserId?: string, f: ResolvedFilters = NO_FILTERS): Promise<DriverRow[]> {
    const p = new Params([start, end]);
    const tripAnd: string[] = [];
    if (f.vehicleId) tripAnd.push(`t.vehicle_id = ${p.add(f.vehicleId)}`);
    if (f.vehicleType) tripAnd.push(`t.vehicle_id IN (SELECT vehicle_id FROM analytics.report_vehicles WHERE vehicle_type = ${p.add(f.vehicleType)})`);
    if (f.routeId) tripAnd.push(`t.trip_id IN (SELECT trip_id FROM analytics.report_trips WHERE route_id = ${p.add(f.routeId)})`);
    const tripCond = tripAnd.length ? ` AND ${tripAnd.join(' AND ')}` : '';
    const flagCond = f.routeId || f.vehicleId || f.vehicleType ? ` AND trip_id IN (SELECT t.trip_id FROM analytics.trip_history_facts t WHERE TRUE${tripCond})` : '';
    const driverAnd: string[] = [scoped(a, 'd.depot_id', p)];
    if (f.depotIds) driverAnd.push(`d.depot_id = ANY(${p.add(f.depotIds)}::bigint[])`);
    if (f.driverId) driverAnd.push(`d.driver_id = ${p.add(f.driverId)}`);
    if (ownUserId !== undefined) driverAnd.push(`d.driver_id IN (SELECT driver_id FROM analytics.driver_users WHERE user_id = ${p.add(ownUserId)})`);
    const res = await db.query(
      `WITH done AS (
         SELECT driver_id, COUNT(*)::int AS trips,
                SUM(ROUND(COALESCE(actual_distance_km, 0) * 1000))::bigint AS metres,
                SUM(ROUND(EXTRACT(EPOCH FROM actual_end - actual_start) / 60))::bigint AS minutes,
                COUNT(scheduled_end)::int AS timed,
                COUNT(*) FILTER (WHERE actual_end <= scheduled_end + interval '${ON_TIME_GRACE_MINUTES} minutes')::int AS on_time,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM analytics.dvir_facts r
                  WHERE r.trip_id = t.trip_id AND r.driver_id = t.driver_id AND r.inspection_type = 'pre_trip'
                ))::int AS inspected
         FROM analytics.trip_history_facts t
         WHERE status = 'completed' AND driver_id IS NOT NULL AND actual_end >= $1 AND actual_end < $2
           AND NOT EXISTS (SELECT 1 FROM analytics.score_exclusions e WHERE e.trip_id = t.trip_id)${tripCond} GROUP BY 1
       ),
       flags AS (
         SELECT driver_id, COUNT(*) FILTER (WHERE flag_type = 'speeding')::int AS speeding, COUNT(*) FILTER (WHERE flag_type = 'idling')::int AS idling
         FROM analytics.score_flag_facts WHERE driver_id IS NOT NULL AND observed_at >= $1 AND observed_at < $2 AND NOT score_excluded${flagCond} GROUP BY 1
       ),
       incidents AS (
         SELECT driver_id, COUNT(*)::int AS incidents, COUNT(*) FILTER (WHERE incident_type = 'accident')::int AS accidents
         FROM analytics.score_incident_facts
         WHERE driver_id IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2 AND NOT score_excluded GROUP BY 1
       )
       SELECT d.public_id, d.full_name, d.depot_name, COALESCE(t.trips, 0) AS trips, COALESCE(t.metres, 0) AS metres, COALESCE(t.minutes, 0) AS minutes,
              COALESCE(t.timed, 0) AS timed, COALESCE(t.on_time, 0) AS on_time,
              COALESCE(f.speeding, 0) AS speeding, COALESCE(f.idling, 0) AS idling, COALESCE(i.incidents, 0) AS incidents,
              COALESCE(i.accidents, 0) AS accidents, COALESCE(t.inspected, 0) AS inspected
       FROM analytics.driver_directory d
       LEFT JOIN done t ON t.driver_id = d.driver_id
       LEFT JOIN flags f ON f.driver_id = d.driver_id
       LEFT JOIN incidents i ON i.driver_id = d.driver_id
       WHERE (t.driver_id IS NOT NULL OR f.driver_id IS NOT NULL OR i.driver_id IS NOT NULL) AND ${driverAnd.join(' AND ')}
       ORDER BY trips DESC, d.full_name`,
      p.values,
    );
    return res.rows.map((r) => ({
      driverId: r.public_id,
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
      accidents: n(r.accidents),
      tripsInspected: n(r.inspected),
    }));
  }

  /** The audience's vehicles that were in the fleet at some time in the period, by plate. */
  async vehiclesInPeriod(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<VehicleRef[]> {
    const p = new Params([start, end]);
    const res = await db.query<{ id: string; reg: string; depot: string }>(
      `SELECT v.vehicle_id::text AS id, v.registration_number AS reg, v.depot_name AS depot
         FROM analytics.vehicle_directory v JOIN analytics.vehicle_service_spans s ON s.vehicle_id = v.vehicle_id
        WHERE s.joined_at < $2 AND (s.retired_at IS NULL OR s.retired_at > $1) AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
        ORDER BY v.registration_number`,
      p.values,
    );
    return res.rows.map((r) => ({ vehicleId: r.id, registrationNumber: r.reg, depot: r.depot }));
  }

  /** The Addis Ababa days each vehicle was in use in the period: a trip under way on that day (filtered by driver and route). */
  async daysInUse(db: Queryable, vehicleIds: readonly string[], start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<Map<string, number>> {
    if (vehicleIds.length === 0) return new Map();
    const p = new Params([start, end, vehicleIds]);
    const and: string[] = [];
    if (f.driverId) and.push(`t.driver_id = ${p.add(f.driverId)}`);
    if (f.routeId) and.push(`t.route_id = ${p.add(f.routeId)}`);
    const res = await db.query<{ id: string; days: number }>(
      `SELECT t.vehicle_id::text AS id, COUNT(DISTINCT d.day)::int AS days
         FROM analytics.report_trips t
         CROSS JOIN LATERAL generate_series(
           date_trunc('day', GREATEST(t.actual_start, $1::timestamptz) AT TIME ZONE 'Africa/Addis_Ababa'),
           date_trunc('day', LEAST(COALESCE(t.actual_end, $2::timestamptz), $2::timestamptz - interval '1 second') AT TIME ZONE 'Africa/Addis_Ababa'),
           interval '1 day') AS d(day)
        WHERE t.vehicle_id = ANY($3::bigint[]) AND t.actual_start IS NOT NULL AND t.actual_start < $2 AND COALESCE(t.actual_end, $2::timestamptz) > $1
          AND t.status IN ('completed', 'en_route')${and.length ? ` AND ${and.join(' AND ')}` : ''}
        GROUP BY 1`,
      p.values,
    );
    return new Map(res.rows.map((r) => [r.id, n(r.days)]));
  }

  /**
   * Maintenance compliance per vehicle (FMS-160): programmed services (preventive repairs of a service programme)
   * completed in the period on time (by the day after they were scheduled) or late, those scheduled before the
   * period's end and still not done (overdue); corrective repairs and those repeated on the same component within
   * 30 days; unplanned failures (for MTBF) and the period's repair cost.
   */
  async compliance(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<ComplianceRow[]> {
    const p = new Params([start, end]);
    const res = await db.query(
      `WITH pm AS (
         SELECT vehicle_id,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= $1 AND completed_at < $2 AND (scheduled_at IS NULL OR completed_at < scheduled_at + interval '1 day'))::int AS on_time,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= $1 AND completed_at < $2 AND scheduled_at IS NOT NULL AND completed_at >= scheduled_at + interval '1 day')::int AS late,
                COUNT(*) FILTER (WHERE status IN ('scheduled', 'open', 'in_progress') AND scheduled_at IS NOT NULL AND scheduled_at + interval '1 day' < $2)::int AS overdue
           FROM analytics.report_maintenance WHERE maintenance_type = 'preventive' AND service_program_id IS NOT NULL GROUP BY 1
       ),
       corrective AS (
         SELECT m.vehicle_id, COUNT(*)::int AS corrective,
                COUNT(*) FILTER (WHERE m.component IS NOT NULL AND EXISTS (
                  SELECT 1 FROM analytics.report_maintenance e
                   WHERE e.vehicle_id = m.vehicle_id AND e.component = m.component AND e.record_id <> m.record_id AND e.status = 'completed'
                     AND e.completed_at < m.completed_at AND e.completed_at >= m.completed_at - interval '30 days'))::int AS repeats
           FROM analytics.report_maintenance m
          WHERE m.maintenance_type = 'corrective' AND m.status = 'completed' AND m.completed_at >= $1 AND m.completed_at < $2 GROUP BY 1
       ),
       failures AS (SELECT vehicle_id, COUNT(*)::int AS n FROM analytics.report_failures WHERE unplanned AND occurred_at >= $1 AND occurred_at < $2 GROUP BY 1),
       cost AS (SELECT vehicle_id, SUM(COALESCE(total_cost_cents, 0))::bigint AS cents FROM analytics.report_maintenance WHERE status = 'completed' AND completed_at >= $1 AND completed_at < $2 GROUP BY 1)
       SELECT v.registration_number, v.depot_name, COALESCE(pm.on_time, 0) AS on_time, COALESCE(pm.late, 0) AS late, COALESCE(pm.overdue, 0) AS overdue,
              COALESCE(c.corrective, 0) AS corrective, COALESCE(c.repeats, 0) AS repeats, COALESCE(fl.n, 0) AS failures, COALESCE(co.cents, 0) AS cents
         FROM analytics.vehicle_directory v
         LEFT JOIN pm ON pm.vehicle_id = v.vehicle_id
         LEFT JOIN corrective c ON c.vehicle_id = v.vehicle_id
         LEFT JOIN failures fl ON fl.vehicle_id = v.vehicle_id
         LEFT JOIN cost co ON co.vehicle_id = v.vehicle_id
        WHERE (COALESCE(pm.on_time, 0) + COALESCE(pm.late, 0) + COALESCE(pm.overdue, 0) + COALESCE(c.corrective, 0) + COALESCE(fl.n, 0) + COALESCE(co.cents, 0)) > 0
          AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
        ORDER BY COALESCE(pm.overdue, 0) DESC, COALESCE(co.cents, 0) DESC, v.registration_number`,
      p.values,
    );
    return res.rows.map((r) => ({
      registrationNumber: r.registration_number,
      depot: r.depot_name,
      pmOnTime: n(r.on_time),
      pmLate: n(r.late),
      pmOverdue: n(r.overdue),
      corrective: n(r.corrective),
      repeatRepairs: n(r.repeats),
      unplannedFailures: n(r.failures),
      costCents: n(r.cents),
    }));
  }

  /** The period's completed repair cost by the failed component ("system") or by workshop ("vendor"), most first. */
  async costBy(db: Queryable, a: Audience, start: Date, end: Date, by: 'component' | 'workshop', f: ResolvedFilters = NO_FILTERS): Promise<CostBreakdownRow[]> {
    const p = new Params([start, end]);
    const res = await db.query(
      `SELECT COALESCE(m.${by === 'component' ? 'component' : 'workshop'}, '') AS key, COUNT(*)::int AS repairs, SUM(COALESCE(m.total_cost_cents, 0))::bigint AS cents
         FROM analytics.report_maintenance m JOIN analytics.vehicle_directory v ON v.vehicle_id = m.vehicle_id
        WHERE m.status = 'completed' AND m.completed_at >= $1 AND m.completed_at < $2 AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}
        GROUP BY 1 ORDER BY cents DESC, key`,
      p.values,
    );
    return res.rows.map((r) => ({ key: r.key, repairs: n(r.repairs), costCents: n(r.cents) }));
  }

  /**
   * Safety by depot, driver or route (FMS-160): the period's completed km, incidents and accidents, speeding and idling
   * flags (left out: those an approved appeal excluded), and the appeals opened and approved against them.
   */
  async safety(db: Queryable, a: Audience, start: Date, end: Date, by: 'depot' | 'driver' | 'route', f: ResolvedFilters = NO_FILTERS): Promise<SafetyRow[]> {
    const p = new Params([start, end]);
    const tripAnd: string[] = [];
    if (f.depotIds) tripAnd.push(`b.depot_id = ANY(${p.add(f.depotIds)}::bigint[])`);
    if (f.vehicleId) tripAnd.push(`b.vehicle_id = ${p.add(f.vehicleId)}`);
    if (f.vehicleType) tripAnd.push(`b.vehicle_type::text = ${p.add(f.vehicleType)}`);
    if (f.driverId) tripAnd.push(`b.driver_id = ${p.add(f.driverId)}`);
    if (f.routeId) tripAnd.push(`b.route_id = ${p.add(f.routeId)}`);
    // A trip's depot is its route's, else its vehicle's: resolved first, so the scope reads a column.
    const scope = scoped(a, 'b.depot_id', p);
    const group =
      by === 'depot'
        ? { key: 'b.depot_id', name: '(SELECT name FROM analytics.depot_directory dd WHERE dd.depot_id = g.key)' }
        : by === 'driver'
          ? { key: 'b.driver_id', name: '(SELECT full_name FROM analytics.driver_directory dr WHERE dr.driver_id = g.key)' }
          : { key: 'b.route_id', name: "(SELECT name FROM analytics.route_directory rd WHERE rd.route_id = g.key)" };
    const res = await db.query(
      `WITH base AS (
         SELECT t.trip_id, t.driver_id, t.vehicle_id, t.route_id, COALESCE(t.route_depot_id, rv.depot_id) AS depot_id, rv.vehicle_type,
                t.actual_distance_km, t.actual_end, t.status
           FROM analytics.report_trips t LEFT JOIN analytics.report_vehicles rv ON rv.vehicle_id = t.vehicle_id
       ),
       trips AS (
         SELECT b.trip_id, b.driver_id, b.vehicle_id, ${group.key} AS key, b.actual_distance_km, b.actual_end, b.status
           FROM base b
          WHERE ${scope}${tripAnd.length ? ` AND ${tripAnd.join(' AND ')}` : ''}
       ),
       km AS (SELECT key, SUM(ROUND(COALESCE(actual_distance_km, 0) * 1000))::bigint AS metres FROM trips WHERE status = 'completed' AND actual_end >= $1 AND actual_end < $2 GROUP BY 1),
       flags AS (
         SELECT tr.key, COUNT(*) FILTER (WHERE fl.flag_type = 'speeding')::int AS speeding, COUNT(*) FILTER (WHERE fl.flag_type = 'idling')::int AS idling
           FROM analytics.score_flag_facts fl JOIN trips tr ON tr.trip_id = fl.trip_id
          WHERE fl.observed_at >= $1 AND fl.observed_at < $2 AND NOT fl.score_excluded GROUP BY 1
       ),
       incidents AS (
         SELECT tr.key, COUNT(*)::int AS incidents, COUNT(*) FILTER (WHERE i.incident_type = 'accident')::int AS accidents
           FROM analytics.score_incident_facts i JOIN trips tr ON tr.trip_id = i.trip_id
          WHERE i.occurred_at >= $1 AND i.occurred_at < $2 AND NOT i.score_excluded GROUP BY 1
       ),
       appeals AS (
         SELECT tr.key, COUNT(*)::int AS opened, COUNT(*) FILTER (WHERE ap.outcome = 'approved')::int AS approved
           FROM analytics.score_appeals ap JOIN trips tr ON tr.trip_id = ap.trip_id
          WHERE ap.created_at >= $1 AND ap.created_at < $2 GROUP BY 1
       ),
       g AS (SELECT key FROM km UNION SELECT key FROM flags UNION SELECT key FROM incidents UNION SELECT key FROM appeals)
       SELECT ${group.name} AS name, COALESCE(km.metres, 0) AS metres, COALESCE(i.incidents, 0) AS incidents, COALESCE(i.accidents, 0) AS accidents,
              COALESCE(fl.speeding, 0) AS speeding, COALESCE(fl.idling, 0) AS idling, COALESCE(ap.opened, 0) AS opened, COALESCE(ap.approved, 0) AS approved
         FROM g LEFT JOIN km ON km.key IS NOT DISTINCT FROM g.key LEFT JOIN flags fl ON fl.key IS NOT DISTINCT FROM g.key
         LEFT JOIN incidents i ON i.key IS NOT DISTINCT FROM g.key LEFT JOIN appeals ap ON ap.key IS NOT DISTINCT FROM g.key
        ORDER BY COALESCE(i.incidents, 0) DESC, COALESCE(km.metres, 0) DESC, name`,
      p.values,
    );
    return res.rows.map((r) => ({
      name: r.name ?? (by === 'route' ? 'No route' : by === 'driver' ? 'No driver' : 'No depot'),
      distanceM: n(r.metres),
      incidents: n(r.incidents),
      accidents: n(r.accidents),
      speeding: n(r.speeding),
      idling: n(r.idling),
      appealsOpened: n(r.opened),
      appealsApproved: n(r.approved),
    }));
  }

  /** The audience's vehicles whose health score is below `line` now (FMS-55), as the filters narrow them. */
  async vehiclesAtRisk(db: Queryable, a: Audience, line: number, f: ResolvedFilters = NO_FILTERS): Promise<number> {
    const p = new Params([line]);
    const res = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.vehicle_directory v
        WHERE v.status <> 'retired' AND v.health_score IS NOT NULL AND v.health_score < $1 AND ${scoped(a, 'v.depot_id', p)} AND ${vehicleFilter(f, 'v', p)}`,
      p.values,
    );
    return n(res.rows[0]?.n);
  }

  /** Appeals opened and feedback given in the period (FMS-158, FMS-159), in the audience's depots. */
  async appealsAndFeedback(db: Queryable, a: Audience, start: Date, end: Date, f: ResolvedFilters = NO_FILTERS): Promise<{ appeals: number; feedback: number }> {
    const p = new Params([start, end]);
    const depotScope = scoped(a, 'x.depot_id', p);
    const depots = f.depotIds ? ` AND x.depot_id = ANY(${p.add(f.depotIds)}::bigint[])` : '';
    const driver = f.driverId ? ` AND x.driver_id = ${p.add(f.driverId)}` : '';
    const res = await db.query<{ appeals: number; feedback: number }>(
      `SELECT (SELECT count(*)::int FROM analytics.score_appeals x WHERE x.created_at >= $1 AND x.created_at < $2 AND ${depotScope}${depots}${driver}) AS appeals,
              (SELECT count(*)::int FROM analytics.driver_feedback x WHERE x.created_at >= $1 AND x.created_at < $2 AND x.retracted_at IS NULL AND ${depotScope}${depots}${driver}) AS feedback`,
      p.values,
    );
    return { appeals: n(res.rows[0]?.appeals), feedback: n(res.rows[0]?.feedback) };
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
