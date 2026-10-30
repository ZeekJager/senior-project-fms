import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AnomalyOutcome, AnomalyStatus } from '../domain/fuel-anomaly';

/** A fuel.fuel_anomalies row (internal ids), its figures as integers or km. */
export interface FuelAnomalyRow {
  id: string;
  publicId: string;
  vehicleId: string;
  fuelLogPublicId: string | null;
  anomalyType: string;
  severity: string;
  status: AnomalyStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
  distanceKm: number | null;
  expectedMl: number | null;
  actualMl: number | null;
  deviationPct: number | null;
  detectedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
}

export interface FuelAnomalyFilter {
  /** Internal ids of the vehicles the caller may see; null means every vehicle. */
  vehicleIds: readonly string[] | null;
  vehicleId?: string;
  statuses?: readonly AnomalyStatus[];
  anomalyType?: string;
  page: number;
  page_size: number;
}

// BIGINT and NUMERIC arrive as text from pg: the ml as text into Number (whole, safe), km and percent as float8.
const ROW_SQL = `
  SELECT a.id, a.public_id AS "publicId", a.vehicle_id AS "vehicleId", f.public_id AS "fuelLogPublicId",
         a.anomaly_type AS "anomalyType", a.severity, a.status, a.period_start AS "periodStart", a.period_end AS "periodEnd",
         a.distance_km::float8 AS "distanceKm", a.expected_ml::text AS "expectedMl", a.actual_ml::text AS "actualMl",
         a.deviation_percentage::float8 AS "deviationPct", a.detected_at AS "detectedAt", a.reviewed_by AS "reviewedBy",
         a.reviewed_at AS "reviewedAt", a.notes
    FROM fuel.fuel_anomalies a
    LEFT JOIN fuel.fuel_logs f ON f.id = a.fuel_log_id`;

const toRow = (r: FuelAnomalyRow & { expectedMl: string | number | null; actualMl: string | number | null }): FuelAnomalyRow => ({
  ...r,
  expectedMl: r.expectedMl === null ? null : Number(r.expectedMl),
  actualMl: r.actualMl === null ? null : Number(r.actualMl),
});

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

  /** A page of anomalies, newest detected first, with the total that match. */
  async list(db: Queryable, f: FuelAnomalyFilter): Promise<{ rows: FuelAnomalyRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [f.vehicleIds === null ? 'TRUE' : `a.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`];
    if (f.vehicleId) where.push(`a.vehicle_id = ${add(f.vehicleId)}`);
    if (f.statuses?.length) where.push(`a.status = ANY(${add(f.statuses)}::fuel.anomaly_status[])`);
    if (f.anomalyType) where.push(`a.anomaly_type = ${add(f.anomalyType)}`);
    const condition = where.join(' AND ');
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fuel.fuel_anomalies a WHERE ${condition}`, params);
    const res = await db.query<FuelAnomalyRow>(
      `${ROW_SQL} WHERE ${condition} ORDER BY a.detected_at DESC, a.id DESC LIMIT ${add(f.page_size)} OFFSET ${add((f.page - 1) * f.page_size)}`,
      params,
    );
    return { rows: res.rows.map(toRow), total: total.rows[0].n };
  }

  /** An anomaly by public id among the vehicles the caller may see (null: every vehicle); `lock` takes the row for an update. */
  async find(db: Queryable, publicId: string, vehicleIds: readonly string[] | null, lock = false): Promise<FuelAnomalyRow | null> {
    const params: unknown[] = [publicId];
    const scope = vehicleIds === null ? 'TRUE' : `a.vehicle_id = ANY($${params.push(vehicleIds)}::bigint[])`;
    const res = await db.query<FuelAnomalyRow>(`${ROW_SQL} WHERE a.public_id = $1 AND ${scope}${lock ? ' FOR UPDATE OF a' : ''}`, params);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  /** Closes an anomaly, recording who and when (FMS-42); audited. */
  close(ctx: MutationContext, id: string, outcome: AnomalyOutcome, notes: string | null, at: Date, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fuel.fuel_anomalies', 'UPDATE', id, { status: outcome, reviewed_by: ctx.userId, reviewed_at: at, notes }, client);
  }

  insertReconciliation(ctx: MutationContext, data: ReconciliationAnomalyWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fuel.fuel_anomalies', 'INSERT', null, { ...data, fuel_log_id: null, status: 'open' }, client);
  }
}
