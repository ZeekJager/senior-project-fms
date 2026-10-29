import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';

/** A reconciliation anomaly to write (FMS-41): about a vehicle's period, not one fill-up. Integers, km to 3 decimals. */
export interface ReconciliationAnomalyWrite {
  vehicle_id: string;
  anomaly_type: string;
  severity: 'medium' | 'high';
  period_start: Date;
  period_end: Date;
  distance_km: number;
  expected_ml: number;
  actual_ml: number;
  /** ml per 100 km, as the columns from migration 004 name them. */
  expected_consumption_ml_100km: number;
  actual_consumption_ml_100km: number;
  deviation_percentage: number;
  detected_at: Date;
}

/** fuel.fuel_anomalies: derived findings about fuel (§9.1). Written by the reconciliation (FMS-41) and the per-fill-up rules (FMS-82). */
export class FuelAnomalyRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** The reconciliation anomalies of exactly [from, to), by vehicle (internal id) to the anomaly's public id. */
  async forPeriod(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, string>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ vehicleId: string; publicId: string }>(
      `SELECT vehicle_id AS "vehicleId", public_id AS "publicId" FROM fuel.fuel_anomalies
        WHERE vehicle_id = ANY($1::bigint[]) AND period_start = $2 AND period_end = $3`,
      [vehicleIds, from, to],
    );
    return new Map(res.rows.map((r) => [r.vehicleId, r.publicId]));
  }

  /** How many of a vehicle's anomalies are still open (not reviewed, dismissed or resolved). */
  async openCount(db: Queryable, vehicleId: string): Promise<number> {
    const res = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM fuel.fuel_anomalies WHERE vehicle_id = $1 AND status = 'open'", [vehicleId]);
    return res.rows[0].n;
  }

  insertReconciliation(ctx: MutationContext, data: ReconciliationAnomalyWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fuel.fuel_anomalies', 'INSERT', null, { ...data, fuel_log_id: null, status: 'open' }, client);
  }
}
