import type { Pool, PoolClient } from 'pg';
import { limitOffset } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { DvirDefect, DvirItem, DvirStatus, DvirType } from '../domain/dvir';

/** A fleet.dvir_reports row (internal ids). */
export interface DvirRow {
  id: string;
  publicId: string;
  vehicleId: string;
  driverId: string;
  tripId: string | null;
  inspectionType: DvirType;
  status: DvirStatus;
  /** `{ items: [...] }`: the whole checklist, in the order it was filled in. */
  checklist: { items: DvirItem[] };
  defects: DvirDefect[];
  issuesFound: boolean;
  submittedAt: Date;
  createdAt: Date;
}

export interface DvirWrite {
  vehicle_id: string;
  driver_id: string;
  trip_id: string | null;
  inspection_type: DvirType;
  /** JSON text: node-pg would send an array as a Postgres array. */
  checklist: string;
  defects: string;
  issues_found: boolean;
  submitted_at: Date;
}

export interface DvirFilter {
  vehicleId: string;
  /** A driver sees only their own reports: their driver id. Staff: undefined. */
  driverId?: string;
  type?: DvirType;
  issuesFound?: boolean;
  /** Submitted at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
  order: 'asc' | 'desc';
  page: number;
  page_size: number;
}

const ROW_SQL = `
  SELECT d.id, d.public_id AS "publicId", d.vehicle_id AS "vehicleId", d.driver_id AS "driverId", d.trip_id AS "tripId",
         d.inspection_type AS "inspectionType", d.status, d.checklist, d.defects, d.issues_found AS "issuesFound",
         d.submitted_at AS "submittedAt", d.created_at AS "createdAt"
    FROM fleet.dvir_reports d`;

/** fleet.dvir_reports (FMS-36). */
export class DvirRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** A vehicle's reports, newest submission first by default. */
  async list(db: Queryable, f: DvirFilter): Promise<{ rows: DvirRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [`d.vehicle_id = ${add(f.vehicleId)}`];
    if (f.driverId) where.push(`d.driver_id = ${add(f.driverId)}`);
    if (f.type) where.push(`d.inspection_type = ${add(f.type)}`);
    if (f.issuesFound !== undefined) where.push(`d.issues_found = ${add(f.issuesFound)}`);
    if (f.from) where.push(`d.submitted_at >= ${add(f.from)}`);
    if (f.to) where.push(`d.submitted_at < ${add(f.to)}`);
    const condition = where.join(' AND ');
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    const { limit, offset } = limitOffset(f);

    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fleet.dvir_reports d WHERE ${condition}`, params);
    const res = await db.query<DvirRow>(`${ROW_SQL} WHERE ${condition} ORDER BY d.submitted_at ${dir}, d.id ${dir} LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows, total: total.rows[0].n };
  }

  async findById(db: Queryable, id: string): Promise<DvirRow> {
    const res = await db.query<DvirRow>(`${ROW_SQL} WHERE d.id = $1`, [id]);
    return res.rows[0];
  }

  /** The first report for a vehicle, trip and type: a resubmission (an offline replay) finds it. */
  async findFor(db: Queryable, vehicleId: string, tripId: string, type: DvirType): Promise<DvirRow | null> {
    const res = await db.query<DvirRow>(`${ROW_SQL} WHERE d.vehicle_id = $1 AND d.trip_id = $2 AND d.inspection_type = $3 ORDER BY d.id LIMIT 1`, [vehicleId, tripId, type]);
    return res.rows[0] ?? null;
  }

  insert(ctx: MutationContext, data: DvirWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.dvir_reports', 'INSERT', null, { ...data }, client);
  }
}
