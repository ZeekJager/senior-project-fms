import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FailureComponent, FailureDetection, FailureMode } from '../domain/failure';

/** A maintenance.failure_events row: internal ids (other modules' too), Dates. */
export interface FailureRow {
  id: string;
  publicId: string;
  vehicleId: string;
  recordPublicId: string | null;
  incidentId: string | null;
  component: FailureComponent;
  failureMode: FailureMode;
  unplanned: boolean;
  detectedBy: FailureDetection;
  occurredAt: Date;
  odometerKm: number | null;
  notes: string | null;
  recordedBy: string | null;
  createdAt: Date;
}

export interface NewFailure {
  vehicle_id: string;
  maintenance_record_id: string | null;
  incident_report_id: string | null;
  component: FailureComponent;
  failure_mode: FailureMode;
  unplanned: boolean;
  detected_by: FailureDetection;
  occurred_at: string;
  odometer_km: number | null;
  notes: string | null;
  recorded_by: string | null;
}

export interface FailureListFilter extends Page {
  /** Vehicles in the caller's scope (internal ids); null: every vehicle. */
  vehicleIds: string[] | null;
  vehicleId?: string;
  component?: FailureComponent;
  unplanned?: boolean;
  /** Failures at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
}

const ROW_SQL = `
  SELECT f.id, f.public_id AS "publicId", f.vehicle_id AS "vehicleId", r.public_id AS "recordPublicId",
         f.incident_report_id AS "incidentId", f.component, f.failure_mode AS "failureMode", f.unplanned,
         f.detected_by AS "detectedBy", f.occurred_at AS "occurredAt", f.odometer_km::float8 AS "odometerKm",
         f.notes, f.recorded_by AS "recordedBy", f.created_at AS "createdAt"
    FROM maintenance.failure_events f
    LEFT JOIN maintenance.maintenance_records r ON r.id = f.maintenance_record_id`;

/**
 * maintenance.failure_events (FMS-125): what failed, how, and whether it was
 * unplanned. Append-only: a failure is never edited, and each insert is one
 * audit row.
 */
export class FailureRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async insert(client: PoolClient, ctx: MutationContext, failure: NewFailure): Promise<FailureRow> {
    const row = await this.mutate(ctx, 'maintenance.failure_events', 'INSERT', null, { ...failure }, client);
    const res = await client.query<FailureRow>(`${ROW_SQL} WHERE f.id = $1`, [row.id]);
    return res.rows[0];
  }

  /** A failure by public id (FMS-128: feedback names the failure a confirmed issue led to), or null. */
  async findByPublicId(db: Queryable, publicId: string): Promise<FailureRow | null> {
    const res = await db.query<FailureRow>(`${ROW_SQL} WHERE f.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async forRecords(db: Queryable, recordIds: readonly string[]): Promise<(FailureRow & { recordId: string })[]> {
    if (recordIds.length === 0) return [];
    const res = await db.query<FailureRow & { recordId: string }>(
      `${ROW_SQL.replace('SELECT f.id,', 'SELECT f.maintenance_record_id AS "recordId", f.id,')}
        WHERE f.maintenance_record_id = ANY($1::bigint[])
        ORDER BY f.occurred_at, f.id`,
      [recordIds],
    );
    return res.rows;
  }

  async countForRecord(db: Queryable, recordId: string): Promise<number> {
    const res = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM maintenance.failure_events WHERE maintenance_record_id = $1', [recordId]);
    return res.rows[0].n;
  }

  /** Newest first (when it failed). */
  async list(db: Queryable, f: FailureListFilter): Promise<{ rows: FailureRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.vehicleIds !== null) where.push(`f.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`);
    if (f.vehicleId) where.push(`f.vehicle_id = ${add(f.vehicleId)}`);
    if (f.component) where.push(`f.component = ${add(f.component)}`);
    if (f.unplanned !== undefined) where.push(`f.unplanned = ${add(f.unplanned)}`);
    if (f.from) where.push(`f.occurred_at >= ${add(f.from)}`);
    if (f.to) where.push(`f.occurred_at < ${add(f.to)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.failure_events f ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<FailureRow>(
      `${ROW_SQL} ${whereSql} ORDER BY f.occurred_at DESC, f.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }
}
