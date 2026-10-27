import type { Pool, PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { ServiceItem } from '../domain/inventory';
import type { RiskLevel } from '../domain/scoring';

/** A maintenance.maintenance_predictions row the nightly scoring writes (FMS-55, migration 040). */
export interface PredictionWrite {
  vehicleId: string;
  modelName: string;
  modelVersion: string;
  predictionType: string;
  failureProbability: number;
  healthScore: number;
  riskLevel: RiskLevel;
  horizonDays: number;
  factors: string[];
  features: Record<string, number>;
  asOf: Date;
}

/** A stored prediction as the health score screen reads it (FMS-56). */
export interface LatestPrediction {
  publicId: string;
  healthScore: number;
  riskLevel: RiskLevel;
  failureProbability: number;
  horizonDays: number | null;
  factors: string[];
  features: Record<string, number> | null;
  modelName: string;
  modelVersion: string;
  asOf: Date;
  scoredAt: Date;
}

/** The nightly scoring's reads of maintenance's own tables, and its predictions. Internal ids. */
export class ScoringRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** The vehicles this model already scored as of this time: a run retried the same day skips them. */
  async scoredAt(db: Queryable, asOf: Date, predictionType: string, model: { name: string; version: string }): Promise<Set<string>> {
    const res = await db.query<{ vehicleId: string }>(
      `SELECT vehicle_id AS "vehicleId" FROM maintenance.maintenance_predictions
        WHERE as_of = $1 AND prediction_type = $2 AND model_name = $3 AND model_version = $4`,
      [asOf, predictionType, model.name, model.version],
    );
    return new Set(res.rows.map((r) => r.vehicleId));
  }

  /** Each vehicle's last completed preventive or inspection record before `before` (days_since_last_service). */
  async lastServices(db: Queryable, vehicleIds: readonly string[], before: Date): Promise<Map<string, Date>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ vehicleId: string; completedAt: Date }>(
      `SELECT vehicle_id AS "vehicleId", max(completed_at) AS "completedAt" FROM maintenance.maintenance_records
        WHERE vehicle_id = ANY($1::bigint[]) AND status = 'completed' AND maintenance_type IN ('preventive', 'inspection')
          AND completed_at < $2
        GROUP BY vehicle_id`,
      [vehicleIds, before],
    );
    return new Map(res.rows.map((r) => [r.vehicleId, r.completedAt]));
  }

  /**
   * The last change of each item on each vehicle before `before` (FMS-52): its latest completed repair that
   * used a part renewing the item. As `lastServiceItems` (GET /vehicles/{id}/service-items), for many vehicles.
   */
  async lastServiceItems(db: Queryable, vehicleIds: readonly string[], before: Date): Promise<{ vehicleId: string; item: ServiceItem; changedAt: Date }[]> {
    if (vehicleIds.length === 0) return [];
    const res = await db.query<{ vehicleId: string; item: ServiceItem; changedAt: Date }>(
      `SELECT r.vehicle_id AS "vehicleId", p.service_item AS item, max(r.completed_at) AS "changedAt"
         FROM maintenance.maintenance_records r
         JOIN maintenance.maintenance_parts mp ON mp.maintenance_record_id = r.id
         JOIN maintenance.inventory_parts p ON p.id = mp.inventory_part_id
        WHERE r.vehicle_id = ANY($1::bigint[]) AND r.status = 'completed' AND p.service_item IS NOT NULL AND r.completed_at < $2
        GROUP BY r.vehicle_id, p.service_item
        ORDER BY r.vehicle_id, p.service_item`,
      [vehicleIds, before],
    );
    return res.rows;
  }

  /** The vehicle's latest active prediction of this type, as scored (FMS-56), or null. */
  async latest(db: Queryable, vehicleId: string, predictionType: string): Promise<LatestPrediction | null> {
    const res = await db.query<LatestPrediction>(
      `SELECT public_id AS "publicId", health_score AS "healthScore", risk_level AS "riskLevel", risk_score::float8 AS "failureProbability",
              prediction_horizon_days AS "horizonDays", factors, feature_snapshot AS features, model_name AS "modelName",
              model_version AS "modelVersion", as_of AS "asOf", generated_at AS "scoredAt"
         FROM maintenance.maintenance_predictions
        WHERE vehicle_id = $1 AND prediction_type = $2 AND status = 'active' AND health_score IS NOT NULL
        ORDER BY generated_at DESC, id DESC
        LIMIT 1`,
      [vehicleId, predictionType],
    );
    return res.rows[0] ?? null;
  }

  /** The vehicles' active predictions of this type, which a new one supersedes. */
  async activeIds(client: PoolClient, vehicleIds: readonly string[], predictionType: string): Promise<Map<string, string[]>> {
    const res = await client.query<{ vehicleId: string; id: string }>(
      `SELECT vehicle_id AS "vehicleId", id FROM maintenance.maintenance_predictions
        WHERE vehicle_id = ANY($1::bigint[]) AND prediction_type = $2 AND status = 'active'
        ORDER BY id`,
      [vehicleIds, predictionType],
    );
    const ids = new Map<string, string[]>();
    for (const r of res.rows) ids.set(r.vehicleId, [...(ids.get(r.vehicleId) ?? []), r.id]);
    return ids;
  }

  async supersede(client: PoolClient, ctx: MutationContext, id: string): Promise<void> {
    await this.mutate(ctx, 'maintenance.maintenance_predictions', 'UPDATE', id, { status: 'superseded' }, client);
  }

  /** Stores a prediction (audited); returns its public id. */
  async insert(client: PoolClient, ctx: MutationContext, p: PredictionWrite): Promise<string> {
    const row = await this.mutate(
      ctx,
      'maintenance.maintenance_predictions',
      'INSERT',
      null,
      {
        vehicle_id: p.vehicleId,
        model_name: p.modelName,
        model_version: p.modelVersion,
        prediction_type: p.predictionType,
        risk_score: p.failureProbability,
        prediction_horizon_days: p.horizonDays,
        feature_snapshot: JSON.stringify(p.features),
        health_score: p.healthScore,
        risk_level: p.riskLevel,
        factors: JSON.stringify(p.factors),
        as_of: p.asOf,
      },
      client,
    );
    return row.public_id as string;
  }
}
