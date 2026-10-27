import type { PoolClient } from 'pg';
import { auditedMutation, type MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A vehicle the nightly scoring scores (FMS-55): in service, with what its features read of it. Internal ids. */
export interface ScoringVehicle {
  id: string;
  publicId: string;
  createdAt: Date;
  modelYear: number | null;
  odometerKm: number;
  fuelEfficiencyMlPerKm: number | null;
  /** Its health score from the last scoring, which the new one is compared with for a risk event. */
  healthScore: number | null;
}

/** Every vehicle in service (not retired), in id order. */
export async function vehiclesToScore(db: Queryable): Promise<ScoringVehicle[]> {
  const res = await db.query<ScoringVehicle>(
    `SELECT id, public_id AS "publicId", created_at AS "createdAt", model_year AS "modelYear",
            odometer_km::float8 AS "odometerKm", fuel_efficiency_ml_per_km AS "fuelEfficiencyMlPerKm",
            health_score AS "healthScore"
       FROM fleet.vehicles
      WHERE is_active AND status <> 'retired'
      ORDER BY id`,
  );
  return res.rows;
}

/** Each vehicle's DVIRs that found issues, submitted in [from, to). Vehicles with none are absent. */
export async function faultyDvirCounts(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, number>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<{ vehicleId: string; count: number }>(
    `SELECT vehicle_id AS "vehicleId", count(*)::int AS count FROM fleet.dvir_reports
      WHERE vehicle_id = ANY($1::bigint[]) AND issues_found AND submitted_at >= $2 AND submitted_at < $3
      GROUP BY vehicle_id`,
    [vehicleIds, from, to],
  );
  return new Map(res.rows.map((r) => [r.vehicleId, r.count]));
}

/**
 * How far each vehicle's engine-hour meter (FMS-126) went over (from, to]: its trusted reading at `to` less
 * its reading at `from`, for the vehicles whose meter was read by `from` and again after it. Others are absent.
 */
export async function engineHoursOver(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, number>> {
  if (vehicleIds.length === 0) return new Map();
  const res = await db.query<{ vehicleId: string; hours: number }>(
    `SELECT vehicle_id AS "vehicleId",
            (max(value) - max(value) FILTER (WHERE recorded_at <= $2))::float8 AS hours
       FROM fleet.meter_readings
      WHERE vehicle_id = ANY($1::bigint[]) AND meter = 'engine_hours' AND NOT suspect AND recorded_at <= $3
      GROUP BY vehicle_id
     HAVING max(value) FILTER (WHERE recorded_at <= $2) IS NOT NULL AND bool_or(recorded_at > $2)`,
    [vehicleIds, from, to],
  );
  return new Map(res.rows.map((r) => [r.vehicleId, r.hours]));
}

/** The vehicle's health score snapshot (fleet.vehicles.health_score), audited; its history is the prediction. */
export async function setHealthScore(client: PoolClient, ctx: MutationContext, vehicleId: string, score: number, at: Date): Promise<void> {
  await auditedMutation(client, ctx, 'fleet.vehicles', 'UPDATE', vehicleId, { health_score: score, health_score_updated_at: at });
}
