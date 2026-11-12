import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A row of analytics.trip_risk_facts (migration 073): one trip, its job and how it went. Internal ids where noted. */
export interface RiskFactRow {
  publicId: string;
  driverPublicId: string | null;
  /** Internal. */
  routeId: string | null;
  depotPublicId: string | null;
  status: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  stopCount: number;
  cargoWeightKg: number | null;
  cargoKind: string;
  payloadCapacityKg: number | null;
  measured: boolean;
  late: boolean | null;
  safetyEvent: boolean;
}

const COLUMNS = `
  f.public_id AS "publicId", f.driver_public_id AS "driverPublicId", f.route_id::text AS "routeId",
  f.depot_public_id AS "depotPublicId", f.status, f.scheduled_start AS "scheduledStart", f.scheduled_end AS "scheduledEnd",
  f.actual_start AS "actualStart", f.actual_end AS "actualEnd", f.planned_distance_km AS "plannedDistanceKm",
  f.planned_duration_seconds AS "plannedDurationSeconds", f.stop_count AS "stopCount", f.cargo_weight_kg AS "cargoWeightKg",
  f.cargo_kind AS "cargoKind", f.payload_capacity_kg AS "payloadCapacityKg", f.measured, f.late, f.safety_event AS "safetyEvent"`;

/** The trips a model is trained on (trip_risk_spec.json `eligible`): completed, with a driver, both schedules, both actual times, measured. */
const ELIGIBLE = `f.status = 'completed' AND f.driver_id IS NOT NULL AND f.scheduled_start IS NOT NULL AND f.scheduled_end IS NOT NULL
  AND f.actual_start IS NOT NULL AND f.actual_end IS NOT NULL AND f.measured`;

/** The trip risk model's reads (FMS-155), on analytics views only: the read replica serves them. */
export class TripRiskRepository {
  /** The trip being staffed, by public id. */
  async trip(db: Queryable, publicId: string): Promise<RiskFactRow | null> {
    const res = await db.query<RiskFactRow>(`SELECT ${COLUMNS} FROM analytics.trip_risk_facts f WHERE f.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  /**
   * The trips of these drivers (public ids) and of this route that started before `to` and had not ended by `from`:
   * a driver's record, rest and hours, and the route's record, at t = `to`.
   */
  async history(db: Queryable, q: { driverPublicIds: readonly string[]; routeId: string | null; from: Date; to: Date }): Promise<RiskFactRow[]> {
    const res = await db.query<RiskFactRow>(
      `SELECT ${COLUMNS} FROM analytics.trip_risk_facts f
        WHERE f.actual_start IS NOT NULL AND f.actual_start < $3 AND (f.actual_end IS NULL OR f.actual_end >= $4)
          AND (f.driver_public_id = ANY($1::uuid[]) OR ($2::bigint IS NOT NULL AND f.route_id = $2::bigint))`,
      [q.driverPublicIds, q.routeId, q.to, q.from],
    );
    return res.rows;
  }

  /** How much there is to train on: eligible trips, and the drivers who drove them. */
  async eligibleCounts(db: Queryable): Promise<{ trips: number; drivers: number }> {
    const res = await db.query<{ trips: string; drivers: string }>(
      `SELECT count(*) AS trips, count(DISTINCT f.driver_id) AS drivers FROM analytics.trip_risk_facts f WHERE ${ELIGIBLE}`,
    );
    return { trips: Number(res.rows[0].trips), drivers: Number(res.rows[0].drivers) };
  }

  /** Every trip that has started, in schedule order, with whether it is one to train on: for the dataset export. */
  async started(db: Queryable): Promise<(RiskFactRow & { eligible: boolean })[]> {
    const res = await db.query<RiskFactRow & { eligible: boolean }>(
      `SELECT ${COLUMNS}, (${ELIGIBLE}) AS eligible FROM analytics.trip_risk_facts f
        WHERE f.actual_start IS NOT NULL ORDER BY f.scheduled_start NULLS LAST, f.actual_start, f.public_id`,
    );
    return res.rows;
  }
}
