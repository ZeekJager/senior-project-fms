import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { ON_TIME_GRACE_MINUTES, shiftDay, type DayFigures } from '../domain/kpis';

/** Whose figures: the caller's depots, narrowed to one depot (an internal id) when asked. */
export interface Audience {
  scope: Scope;
  depotId?: string;
}

/** The SQL condition on a depot column for an audience, and its values from `$next` on. */
function audience(a: Audience, column: string, next: number): { sql: string; params: string[] } {
  const scope = scopeClause(a.scope, column, next);
  if (!a.depotId) return scope;
  return { sql: `${scope.sql} AND ${column} = $${next + scope.params.length}`, params: [...scope.params, a.depotId] };
}

const ZONE = `'Africa/Addis_Ababa'`;
const localDay = (column: string) => `(${column} AT TIME ZONE ${ZONE})::date`;
const n = (v: unknown): number => Number(v ?? 0);

export interface CacheRow extends DayFigures {
  utilisationPct: number;
  costPerKmCents: number;
  onTimePct: number | null;
}

export interface VehicleRow {
  vehicleId: string;
  publicId: string;
  registrationNumber: string;
  make: string | null;
  model: string | null;
  status: string;
  fuelType: string;
  ratedMlPerKm: number | null;
  healthScore: number | null;
  maintenanceFlag: boolean;
  depotPublicId: string;
  depotName: string;
}

export interface Totals {
  usedDays: number;
  vehicleDays: number;
  distanceM: number;
  tripsCompleted: number;
  tripsTimed: number;
  tripsOnTime: number;
  fuelMl: number;
  fuelCostCents: number;
  maintenanceCostCents: number;
}

const TOTALS_SQL = `
  COUNT(*) FILTER (WHERE c.utilisation_pct = 100)::int AS used_days,
  COUNT(*)::int AS vehicle_days,
  COALESCE(SUM(c.distance_m), 0) AS distance_m,
  COALESCE(SUM(c.trips_completed), 0) AS trips_completed,
  COALESCE(SUM(c.trips_timed), 0) AS trips_timed,
  COALESCE(SUM(c.trips_on_time), 0) AS trips_on_time,
  COALESCE(SUM(c.fuel_ml), 0) AS fuel_ml,
  COALESCE(SUM(c.fuel_cost_cents), 0) AS fuel_cost_cents,
  COALESCE(SUM(c.maintenance_cost_cents), 0) AS maintenance_cost_cents`;

const totalsOf = (r: Record<string, unknown>): Totals => ({
  usedDays: n(r.used_days),
  vehicleDays: n(r.vehicle_days),
  distanceM: n(r.distance_m),
  tripsCompleted: n(r.trips_completed),
  tripsTimed: n(r.trips_timed),
  tripsOnTime: n(r.trips_on_time),
  fuelMl: n(r.fuel_ml),
  fuelCostCents: n(r.fuel_cost_cents),
  maintenanceCostCents: n(r.maintenance_cost_cents),
});

/**
 * The analytics schema (FMS-50): analytics_cache, one row per vehicle and Addis Ababa day, and the read-only views
 * over the operational tables (migration 044). Every read takes the queryable it is given: a read session on the
 * replica for the API, the primary for the refresh's writes.
 */
export class AnalyticsRepository {
  /**
   * Each vehicle's figures for each day in [from, to] (Addis Ababa days), from the views. A vehicle is used on a day
   * its completed or running trip overlaps; a trip's distance and on-time count on the day it ended, fuel on the
   * day it was logged, repair cost on the day the work was completed. Retired vehicles are left out.
   */
  async computeDays(db: Queryable, from: string, to: string): Promise<DayFigures[]> {
    const res = await db.query(
      `WITH days AS (
         SELECT d::date AS day, (d::date::timestamp AT TIME ZONE ${ZONE}) AS starts, ((d::date + 1)::timestamp AT TIME ZONE ${ZONE}) AS ends
         FROM generate_series($1::date, $2::date, interval '1 day') d
       ),
       bounds AS (SELECT MIN(starts) AS starts, MAX(ends) AS ends FROM days),
       vehicles AS (SELECT vehicle_id FROM analytics.vehicle_directory WHERE status <> 'retired'),
       done AS (
         SELECT t.vehicle_id, ${localDay('t.actual_end')} AS day,
                SUM(ROUND(COALESCE(t.actual_distance_km, 0) * 1000))::bigint AS distance_m,
                COUNT(*)::int AS completed,
                COUNT(t.scheduled_end)::int AS timed,
                COUNT(*) FILTER (WHERE t.actual_end <= t.scheduled_end + interval '${ON_TIME_GRACE_MINUTES} minutes')::int AS on_time
         FROM analytics.trip_facts t, bounds b
         WHERE t.status = 'completed' AND t.actual_end >= b.starts AND t.actual_end < b.ends
         GROUP BY 1, 2
       ),
       used AS (
         SELECT DISTINCT t.vehicle_id, d.day
         FROM analytics.trip_facts t
         JOIN days d ON t.actual_start < d.ends AND COALESCE(t.actual_end, now()) >= d.starts
         WHERE t.status IN ('completed', 'en_route') AND t.actual_start IS NOT NULL
       ),
       fills AS (
         SELECT f.vehicle_id, ${localDay('f.recorded_at')} AS day, SUM(f.quantity_ml)::bigint AS ml, SUM(f.total_cost_cents)::bigint AS cents
         FROM analytics.fuel_facts f, bounds b
         WHERE f.recorded_at >= b.starts AND f.recorded_at < b.ends
         GROUP BY 1, 2
       ),
       repairs AS (
         SELECT m.vehicle_id, ${localDay('m.completed_at')} AS day, SUM(COALESCE(m.total_cost_cents, 0))::bigint AS cents
         FROM analytics.maintenance_cost_facts m, bounds b
         WHERE m.completed_at >= b.starts AND m.completed_at < b.ends
         GROUP BY 1, 2
       )
       SELECT v.vehicle_id, to_char(d.day, 'YYYY-MM-DD') AS day, (u.vehicle_id IS NOT NULL) AS used,
              COALESCE(done.distance_m, 0) AS distance_m, COALESCE(done.completed, 0) AS completed,
              COALESCE(done.timed, 0) AS timed, COALESCE(done.on_time, 0) AS on_time,
              COALESCE(fills.ml, 0) AS fuel_ml, COALESCE(fills.cents, 0) AS fuel_cents, COALESCE(repairs.cents, 0) AS repair_cents
       FROM vehicles v
       CROSS JOIN days d
       LEFT JOIN used u ON u.vehicle_id = v.vehicle_id AND u.day = d.day
       LEFT JOIN done ON done.vehicle_id = v.vehicle_id AND done.day = d.day
       LEFT JOIN fills ON fills.vehicle_id = v.vehicle_id AND fills.day = d.day
       LEFT JOIN repairs ON repairs.vehicle_id = v.vehicle_id AND repairs.day = d.day`,
      [from, to],
    );
    return res.rows.map((r) => ({
      vehicleId: String(r.vehicle_id),
      day: r.day as string,
      used: r.used as boolean,
      distanceM: n(r.distance_m),
      tripsCompleted: n(r.completed),
      tripsTimed: n(r.timed),
      tripsOnTime: n(r.on_time),
      fuelMl: n(r.fuel_ml),
      fuelCostCents: n(r.fuel_cents),
      maintenanceCostCents: n(r.repair_cents),
    }));
  }

  /** Writes day rows, replacing what was there for each (vehicle, day); computed_at is the refresh's time. */
  async upsert(db: Queryable, rows: readonly CacheRow[], computedAt: Date): Promise<void> {
    const col = <K extends keyof CacheRow>(k: K) => rows.map((r) => r[k]);
    await db.query(
      `INSERT INTO analytics.analytics_cache
         (vehicle_id, period_type, period_start, utilisation_pct, cost_per_km_cents, driver_on_time_pct,
          distance_m, trips_completed, trips_timed, trips_on_time, fuel_ml, fuel_cost_cents, maintenance_cost_cents, computed_at)
       SELECT r.vehicle_id, 'day', r.day, r.utilisation_pct, r.cost_per_km_cents, r.on_time_pct,
              r.distance_m, r.trips_completed, r.trips_timed, r.trips_on_time, r.fuel_ml, r.fuel_cost_cents, r.maintenance_cost_cents, $14
       FROM unnest($1::bigint[], $2::date[], $3::smallint[], $4::int[], $5::smallint[], $6::bigint[], $7::int[], $8::int[], $9::int[], $10::bigint[], $11::bigint[], $12::bigint[], $13::boolean[])
         AS r(vehicle_id, day, utilisation_pct, cost_per_km_cents, on_time_pct, distance_m, trips_completed, trips_timed, trips_on_time, fuel_ml, fuel_cost_cents, maintenance_cost_cents, used)
       ON CONFLICT (vehicle_id, period_type, period_start) DO UPDATE SET
         utilisation_pct = EXCLUDED.utilisation_pct, cost_per_km_cents = EXCLUDED.cost_per_km_cents,
         driver_on_time_pct = EXCLUDED.driver_on_time_pct, distance_m = EXCLUDED.distance_m,
         trips_completed = EXCLUDED.trips_completed, trips_timed = EXCLUDED.trips_timed, trips_on_time = EXCLUDED.trips_on_time,
         fuel_ml = EXCLUDED.fuel_ml, fuel_cost_cents = EXCLUDED.fuel_cost_cents,
         maintenance_cost_cents = EXCLUDED.maintenance_cost_cents, computed_at = EXCLUDED.computed_at`,
      [
        col('vehicleId'),
        col('day'),
        col('utilisationPct'),
        col('costPerKmCents'),
        col('onTimePct'),
        col('distanceM'),
        col('tripsCompleted'),
        col('tripsTimed'),
        col('tripsOnTime'),
        col('fuelMl'),
        col('fuelCostCents'),
        col('maintenanceCostCents'),
        col('used'),
        computedAt,
      ],
    );
  }

  /** When the cache was last refreshed, or null when it was never filled. */
  async lastComputedAt(db: Queryable): Promise<Date | null> {
    const res = await db.query<{ at: Date | null }>(`SELECT MAX(computed_at) AS at FROM analytics.analytics_cache WHERE period_type = 'day'`);
    return res.rows[0]?.at ?? null;
  }

  /** A depot's internal id when it is one of the audience's depots; null otherwise (unknown or outside). */
  async depotInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null> {
    const s = scopeClause(scope, 'depot_id', 2);
    const res = await db.query<{ id: string }>(
      `SELECT DISTINCT depot_id::text AS id FROM analytics.vehicle_directory WHERE depot_public_id = $1 AND ${s.sql}`,
      [publicId, ...s.params],
    );
    return res.rows[0]?.id ?? null;
  }

  /** The audience's vehicles, retired ones included (they count in the status breakdown). */
  async vehicles(db: Queryable, a: Audience): Promise<VehicleRow[]> {
    const w = audience(a, 'depot_id', 1);
    const res = await db.query(
      `SELECT vehicle_id, public_id, registration_number, make, model, status, fuel_type, fuel_efficiency_ml_per_km,
              health_score, maintenance_flag, depot_public_id, depot_name
       FROM analytics.vehicle_directory WHERE ${w.sql} ORDER BY registration_number`,
      w.params,
    );
    return res.rows.map((r) => ({
      vehicleId: String(r.vehicle_id),
      publicId: r.public_id as string,
      registrationNumber: r.registration_number as string,
      make: (r.make as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      status: r.status as string,
      fuelType: r.fuel_type as string,
      ratedMlPerKm: r.fuel_efficiency_ml_per_km === null ? null : n(r.fuel_efficiency_ml_per_km),
      healthScore: r.health_score === null ? null : n(r.health_score),
      maintenanceFlag: r.maintenance_flag as boolean,
      depotPublicId: r.depot_public_id as string,
      depotName: r.depot_name as string,
    }));
  }

  /** The cache summed per vehicle over [from, to]. */
  async totalsByVehicle(db: Queryable, a: Audience, from: string, to: string): Promise<Map<string, Totals>> {
    const w = audience(a, 'v.depot_id', 3);
    const res = await db.query(
      `SELECT c.vehicle_id, ${TOTALS_SQL}
       FROM analytics.analytics_cache c JOIN analytics.vehicle_directory v ON v.vehicle_id = c.vehicle_id
       WHERE c.period_type = 'day' AND c.period_start BETWEEN $1::date AND $2::date AND ${w.sql}
       GROUP BY c.vehicle_id`,
      [from, to, ...w.params],
    );
    return new Map(res.rows.map((r) => [String(r.vehicle_id), totalsOf(r)]));
  }

  /**
   * The cache summed per day over [from, to] for these vehicles (the caller's, from `vehicles`), every day present
   * (zeros when nothing is cached). By id, not joined to the directory: with fresh rows and no statistics yet the
   * planner loops the cache against the directory (200 vehicles for a month took 220 ms; this takes a few).
   */
  async totalsByDay(db: Queryable, vehicleIds: string[], from: string, to: string): Promise<{ day: string; totals: Totals }[]> {
    const res = await db.query(
      `SELECT to_char(c.period_start, 'YYYY-MM-DD') AS day, ${TOTALS_SQL}
       FROM analytics.analytics_cache c
       WHERE c.period_type = 'day' AND c.period_start BETWEEN $1::date AND $2::date AND c.vehicle_id = ANY($3::bigint[])
       GROUP BY c.period_start`,
      [from, to, vehicleIds],
    );
    const found = new Map(res.rows.map((r) => [r.day as string, totalsOf(r)]));
    const days: { day: string; totals: Totals }[] = [];
    for (let day = from; day <= to; day = shiftDay(day, 1)) days.push({ day, totals: found.get(day) ?? totalsOf({}) });
    return days;
  }

  /** Open and acknowledged alerts by severity, now. */
  async openAlerts(db: Queryable, a: Audience): Promise<Record<string, number>> {
    const w = audience(a, 'depot_id', 1);
    const res = await db.query(
      `SELECT severity::text AS severity, COUNT(*)::int AS count FROM analytics.alert_facts
       WHERE status IN ('open', 'acknowledged') AND ${w.sql} GROUP BY 1`,
      w.params,
    );
    return Object.fromEntries(res.rows.map((r) => [r.severity as string, n(r.count)]));
  }

  /** Alerts raised in [from, to): by severity, type and day, and the mean minutes to acknowledge those acknowledged. */
  async alertsRaised(db: Queryable, a: Audience, from: Date, to: Date) {
    const w = audience(a, 'depot_id', 3);
    const where = `created_at >= $1 AND created_at < $2 AND ${w.sql}`;
    const params = [from, to, ...w.params];
    const severity = await db.query(`SELECT severity::text AS key, COUNT(*)::int AS count FROM analytics.alert_facts WHERE ${where} GROUP BY 1`, params);
    const type = await db.query(`SELECT alert_type AS key, COUNT(*)::int AS count FROM analytics.alert_facts WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`, params);
    const day = await db.query(`SELECT to_char(${localDay('created_at')}, 'YYYY-MM-DD') AS key, COUNT(*)::int AS count FROM analytics.alert_facts WHERE ${where} GROUP BY 1`, params);
    const ack = await db.query(
        `SELECT COUNT(*)::int AS acknowledged, ROUND(AVG(EXTRACT(EPOCH FROM acknowledged_at - created_at)) / 60)::int AS minutes
         FROM analytics.alert_facts WHERE acknowledged_at IS NOT NULL AND ${where}`,
        params,
      );
    const counts = (rows: Record<string, unknown>[]) => rows.map((r) => ({ key: r.key as string, count: n(r.count) }));
    return {
      bySeverity: counts(severity.rows),
      byType: counts(type.rows),
      byDay: counts(day.rows),
      acknowledged: n(ack.rows[0]?.acknowledged),
      meanMinutesToAcknowledge: ack.rows[0]?.minutes === null || ack.rows[0]?.minutes === undefined ? null : n(ack.rows[0].minutes),
    };
  }

  /** Trips planned in [from, to) (by scheduled start, else actual start) by status, for the audience's vehicles. */
  async tripsByStatus(db: Queryable, a: Audience, from: Date, to: Date): Promise<Record<string, number>> {
    const w = audience(a, 'v.depot_id', 3);
    const res = await db.query(
      `SELECT t.status::text AS status, COUNT(*)::int AS count
       FROM analytics.trip_facts t JOIN analytics.vehicle_directory v ON v.vehicle_id = t.vehicle_id
       WHERE COALESCE(t.scheduled_start, t.actual_start) >= $1 AND COALESCE(t.scheduled_start, t.actual_start) < $2 AND ${w.sql}
       GROUP BY 1`,
      [from, to, ...w.params],
    );
    return Object.fromEntries(res.rows.map((r) => [r.status as string, n(r.count)]));
  }

  /** Each vehicle's highest active risk (its latest prediction of each type), by internal vehicle id. */
  async risks(db: Queryable, a: Audience): Promise<Map<string, { riskScore: number; predictionType: string; failureType: string | null; generatedAt: Date }>> {
    const w = audience(a, 'v.depot_id', 1);
    const res = await db.query(
      `SELECT DISTINCT ON (r.vehicle_id) r.vehicle_id, ROUND(r.risk_score * 100)::int AS risk_pct, r.prediction_type, r.predicted_failure_type, r.generated_at
       FROM analytics.maintenance_risk_summary r JOIN analytics.vehicle_directory v ON v.vehicle_id = r.vehicle_id
       WHERE ${w.sql}
       ORDER BY r.vehicle_id, r.risk_score DESC, r.generated_at DESC`,
      w.params,
    );
    return new Map(
      res.rows.map((r) => [
        String(r.vehicle_id),
        { riskScore: n(r.risk_pct), predictionType: r.prediction_type as string, failureType: (r.predicted_failure_type as string | null) ?? null, generatedAt: r.generated_at as Date },
      ]),
    );
  }
}
