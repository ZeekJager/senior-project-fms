import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FailureComponent } from '../domain/failure';
import type { TaskStatus, VendorType } from '../domain/work-order';

/** A maintenance.vendors row (internal ids). */
export interface VendorRow {
  id: string;
  publicId: string;
  name: string;
  vendorType: VendorType;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  depotId: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRow {
  id: string;
  publicId: string;
  recordId: string;
  description: string;
  component: FailureComponent | null;
  status: TaskStatus;
  estimatedHours: number | null;
  actualHours: number;
  position: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LabourRow {
  id: string;
  publicId: string;
  recordId: string;
  taskPublicId: string | null;
  /** Internal auth.users id: the service names them through the auth module. */
  technicianId: string;
  workDate: string;
  hours: number;
  rateCents: number;
  costCents: number;
  notes: string | null;
  createdAt: Date;
}

/** One technician's hours in one week (Monday, Addis Ababa), on work in the caller's depots. */
export interface LabourWeekRow {
  /** Internal auth.users id. */
  technicianId: string;
  weekStart: string;
  hours: number;
  costCents: number;
  orders: number;
}

export interface VendorListFilter extends Page {
  /** Depots the caller sees (internal id), or null: every depot. A fleet-wide vendor is always listed. */
  depotId: string | null;
  vendorType?: VendorType;
  search?: string;
  status: 'active' | 'retired' | 'all';
}

export interface VendorWrite {
  name?: string;
  vendor_type?: VendorType;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  depot_id?: string | null;
  notes?: string | null;
}

const VENDOR_SQL = `
  SELECT v.id, v.public_id AS "publicId", v.name, v.vendor_type AS "vendorType", v.contact_name AS "contactName",
         v.phone, v.email, v.depot_id AS "depotId", v.notes, v.is_active AS "isActive", v.version,
         v.created_at AS "createdAt", v.updated_at AS "updatedAt"
    FROM maintenance.vendors v`;

const TASK_SQL = `
  SELECT t.id, t.public_id AS "publicId", t.maintenance_record_id AS "recordId", t.description, t.component, t.status,
         t.estimated_hours::float8 AS "estimatedHours",
         COALESCE((SELECT sum(l.hours) FROM maintenance.labour_entries l WHERE l.task_id = t.id AND l.is_active), 0)::float8 AS "actualHours",
         t.position, t.version, t.created_at AS "createdAt", t.updated_at AS "updatedAt"
    FROM maintenance.work_order_tasks t`;

/** Addis Ababa is UTC+3 all year. */
const ADDIS = 'Africa/Addis_Ababa';

/**
 * Work orders (FMS-130): vendors, an order's tasks and labour entries, and the order's labour and vendor costs.
 * Technicians are internal auth.users ids here; the service names them through the auth module's index.ts.
 */
export class WorkOrderRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  // ---- vendors

  async listVendors(db: Queryable, f: VendorListFilter): Promise<{ rows: VendorRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.depotId !== null) where.push(`(v.depot_id IS NULL OR v.depot_id = ${add(f.depotId)})`);
    if (f.vendorType) where.push(`v.vendor_type = ${add(f.vendorType)}`);
    if (f.search) where.push(`(v.name ILIKE ${add(`%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} OR v.contact_name ILIKE $${params.length})`);
    if (f.status !== 'all') where.push(f.status === 'active' ? 'v.is_active' : 'NOT v.is_active');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.vendors v ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<VendorRow>(`${VENDOR_SQL} ${whereSql} ORDER BY lower(v.name), v.id LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findVendor(db: Queryable, publicId: string, lock = false): Promise<VendorRow | null> {
    const res = await db.query<VendorRow>(`${VENDOR_SQL} WHERE v.public_id = $1${lock ? ' FOR UPDATE' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  async vendorsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, VendorRow>> {
    if (ids.length === 0) return new Map();
    const res = await db.query<VendorRow>(`${VENDOR_SQL} WHERE v.id = ANY($1::bigint[])`, [ids]);
    return new Map(res.rows.map((r) => [r.id, r]));
  }

  /** Another active vendor of this name in the same depot (or fleet-wide), any case. */
  async vendorNameTaken(db: Queryable, name: string, depotId: string | null, exceptId: string | null): Promise<boolean> {
    const res = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM maintenance.vendors
                       WHERE is_active AND lower(name) = lower($1) AND COALESCE(depot_id, 0) = COALESCE($2::bigint, 0)
                         AND ($3::bigint IS NULL OR id <> $3)) AS taken`,
      [name, depotId, exceptId],
    );
    return res.rows[0].taken;
  }

  insertVendor(ctx: MutationContext, client: PoolClient, data: VendorWrite & { created_by: string | null }): Promise<Row> {
    return this.mutate(ctx, 'maintenance.vendors', 'INSERT', null, { ...data }, client);
  }

  updateVendor(ctx: MutationContext, client: PoolClient, id: string, data: VendorWrite & { is_active?: boolean }): Promise<Row> {
    return this.mutate(ctx, 'maintenance.vendors', 'UPDATE', id, { ...data }, client);
  }

  // ---- tasks

  async tasksFor(db: Queryable, recordIds: readonly string[]): Promise<TaskRow[]> {
    if (recordIds.length === 0) return [];
    const res = await db.query<TaskRow>(`${TASK_SQL} WHERE t.maintenance_record_id = ANY($1::bigint[]) AND t.is_active ORDER BY t.position, t.id`, [
      recordIds,
    ]);
    return res.rows;
  }

  async findTask(db: Queryable, recordId: string, publicId: string, lock = false): Promise<TaskRow | null> {
    const res = await db.query<TaskRow>(
      `${TASK_SQL} WHERE t.maintenance_record_id = $1 AND t.public_id = $2 AND t.is_active${lock ? ' FOR UPDATE OF t' : ''}`,
      [recordId, publicId],
    );
    return res.rows[0] ?? null;
  }

  async taskCount(db: Queryable, recordId: string): Promise<number> {
    const res = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM maintenance.work_order_tasks WHERE maintenance_record_id = $1 AND is_active`,
      [recordId],
    );
    return res.rows[0].n;
  }

  insertTask(ctx: MutationContext, client: PoolClient, data: Row): Promise<Row> {
    return this.mutate(ctx, 'maintenance.work_order_tasks', 'INSERT', null, data, client);
  }

  updateTask(ctx: MutationContext, client: PoolClient, id: string, data: Row): Promise<Row> {
    return this.mutate(ctx, 'maintenance.work_order_tasks', 'UPDATE', id, data, client);
  }

  /** Soft delete: the task leaves the order; labour booked to it stays on the order, without a task. */
  async removeTask(ctx: MutationContext, client: PoolClient, id: string): Promise<void> {
    await this.mutate(ctx, 'maintenance.work_order_tasks', 'DELETE', id, {}, client);
    await client.query(`UPDATE maintenance.labour_entries SET task_id = NULL WHERE task_id = $1`, [id]);
  }

  // ---- labour

  async labourFor(db: Queryable, recordIds: readonly string[]): Promise<LabourRow[]> {
    if (recordIds.length === 0) return [];
    const res = await db.query<LabourRow>(
      `SELECT l.id, l.public_id AS "publicId", l.maintenance_record_id AS "recordId", t.public_id AS "taskPublicId",
              l.technician_id AS "technicianId", l.work_date::text AS "workDate",
              l.hours::float8 AS hours, l.rate_cents AS "rateCents", l.cost_cents AS "costCents", l.notes, l.created_at AS "createdAt"
         FROM maintenance.labour_entries l
         LEFT JOIN maintenance.work_order_tasks t ON t.id = l.task_id
        WHERE l.maintenance_record_id = ANY($1::bigint[]) AND l.is_active
        ORDER BY l.work_date, l.id`,
      [recordIds],
    );
    return res.rows;
  }

  async findLabour(db: Queryable, recordId: string, publicId: string): Promise<{ id: string } | null> {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM maintenance.labour_entries WHERE maintenance_record_id = $1 AND public_id = $2 AND is_active`,
      [recordId, publicId],
    );
    return res.rows[0] ?? null;
  }

  insertLabour(ctx: MutationContext, client: PoolClient, data: Row): Promise<Row> {
    return this.mutate(ctx, 'maintenance.labour_entries', 'INSERT', null, data, client);
  }

  removeLabour(ctx: MutationContext, client: PoolClient, id: string): Promise<Row> {
    return this.mutate(ctx, 'maintenance.labour_entries', 'DELETE', id, {}, client);
  }

  /** The order's labour now: active entries' hours and cost, and whether it has any. */
  async labourTotals(db: Queryable, recordId: string): Promise<{ entries: number; hours: number; costCents: number }> {
    const res = await db.query<{ entries: number; hours: number; costCents: number }>(
      `SELECT count(*)::int AS entries, COALESCE(sum(hours), 0)::float8 AS hours, COALESCE(sum(cost_cents), 0)::int AS "costCents"
         FROM maintenance.labour_entries WHERE maintenance_record_id = $1 AND is_active`,
      [recordId],
    );
    return res.rows[0];
  }

  /** Which of these orders have labour entries: those are itemised. */
  async withLabour(db: Queryable, recordIds: readonly string[]): Promise<Set<string>> {
    if (recordIds.length === 0) return new Set();
    const res = await db.query<{ id: string }>(
      `SELECT DISTINCT maintenance_record_id AS id FROM maintenance.labour_entries WHERE maintenance_record_id = ANY($1::bigint[]) AND is_active`,
      [recordIds],
    );
    return new Set(res.rows.map((r) => r.id));
  }

  /**
   * Hours per technician per week (FMS-130's workload report): active entries on work orders of these vehicles
   * (null: every vehicle), worked from `from` to `to` (Addis Ababa days, inclusive), a week starting on Monday.
   */
  async labourByWeek(db: Queryable, f: { vehicleIds: string[] | null; from: string; to: string; technicianId?: string }): Promise<LabourWeekRow[]> {
    const res = await db.query<LabourWeekRow>(
      `SELECT l.technician_id AS "technicianId", date_trunc('week', l.work_date)::date::text AS "weekStart",
              sum(l.hours)::float8 AS hours, sum(l.cost_cents)::int AS "costCents", count(DISTINCT l.maintenance_record_id)::int AS orders
         FROM maintenance.labour_entries l
         JOIN maintenance.maintenance_records r ON r.id = l.maintenance_record_id
        WHERE l.is_active AND l.work_date BETWEEN $1::date AND $2::date
          AND ($3::bigint[] IS NULL OR r.vehicle_id = ANY($3::bigint[]))
          AND ($4::bigint IS NULL OR l.technician_id = $4)
        GROUP BY l.technician_id, date_trunc('week', l.work_date)
        ORDER BY "weekStart", l.technician_id`,
      [f.from, f.to, f.vehicleIds, f.technicianId ?? null],
    );
    return res.rows;
  }

  /** Today in Addis Ababa, as the database sees it: a labour day cannot be after it. */
  async today(db: Queryable): Promise<string> {
    const res = await db.query<{ today: string }>(`SELECT (now() AT TIME ZONE '${ADDIS}')::date::text AS today`);
    return res.rows[0].today;
  }
}
