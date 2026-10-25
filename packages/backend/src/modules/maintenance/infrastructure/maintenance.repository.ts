import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { ServiceItem } from '../domain/inventory';
import { OPEN_STATUSES, type MaintenancePriority, type MaintenanceStatus, type MaintenanceType } from '../domain/maintenance';

/** A maintenance.maintenance_records row (internal ids). */
export interface RecordRow {
  id: string;
  publicId: string;
  vehicleId: string;
  maintenanceType: MaintenanceType;
  description: string | null;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  odometerKm: number | null;
  labourHours: number | null;
  totalCostCents: number;
  workshop: string | null;
  notes: string | null;
  completedBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartLineRow {
  recordId: string;
  partPublicId: string;
  partNumber: string;
  name: string;
  quantity: number;
  unitCostCents: number;
}

/** A stocked part, row-locked for a consumption. */
export interface LockedPart {
  id: string;
  publicId: string;
  partNumber: string;
  depotId: string | null;
  isActive: boolean;
  stockQuantity: number;
  reorderThreshold: number;
}

/** The vehicle's last completed repair that renewed an item (FMS-52). */
export interface LastServiceItemRow {
  item: ServiceItem;
  changedAt: Date;
  recordPublicId: string;
  odometerKm: number | null;
  partNumber: string;
}

export interface RecordListFilter extends Page {
  /** Vehicles in the caller's scope (internal ids); null: every vehicle. */
  vehicleIds: string[] | null;
  vehicleId?: string;
  status?: MaintenanceStatus;
  open?: boolean;
  maintenanceType?: MaintenanceType;
  sortOrder: 'asc' | 'desc';
}

export interface RecordWrite {
  maintenance_type?: MaintenanceType;
  description?: string | null;
  status?: MaintenanceStatus;
  priority?: MaintenancePriority;
  scheduled_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  odometer_km?: number | null;
  labor_hours?: number | null;
  total_cost_cents?: number;
  workshop?: string | null;
  notes?: string | null;
  completed_by?: string | null;
}

const ROW_SQL = `
  SELECT r.id, r.public_id AS "publicId", r.vehicle_id AS "vehicleId", r.maintenance_type AS "maintenanceType",
         r.description, r.status, r.priority, r.scheduled_at AS "scheduledAt", r.started_at AS "startedAt",
         r.completed_at AS "completedAt", r.odometer_km::float8 AS "odometerKm", r.labor_hours::float8 AS "labourHours",
         r.total_cost_cents AS "totalCostCents", r.workshop, r.notes, r.completed_by AS "completedBy", r.version,
         r.created_at AS "createdAt", r.updated_at AS "updatedAt"
    FROM maintenance.maintenance_records r`;

/**
 * maintenance.* (FMS-22): repair records, the parts each used, and the stock
 * those parts came from. Vehicles live in the fleet module; this repository
 * only ever sees their internal ids.
 */
export class MaintenanceRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** Newest first by default: the vehicle's history as a mechanic reads it. */
  async list(db: Queryable, f: RecordListFilter): Promise<{ rows: RecordRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.vehicleIds !== null) where.push(`r.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`);
    if (f.vehicleId) where.push(`r.vehicle_id = ${add(f.vehicleId)}`);
    if (f.status) where.push(`r.status = ${add(f.status)}`);
    if (f.open !== undefined) where.push(`r.status ${f.open ? '' : 'NOT '}IN ('${OPEN_STATUSES.join("','")}')`);
    if (f.maintenanceType) where.push(`r.maintenance_type = ${add(f.maintenanceType)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.maintenance_records r ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const dir = f.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const res = await db.query<RecordRow>(
      `${ROW_SQL} ${whereSql} ORDER BY r.created_at ${dir}, r.id ${dir} LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findByPublicId(db: Queryable, publicId: string): Promise<RecordRow | null> {
    const res = await db.query<RecordRow>(`${ROW_SQL} WHERE r.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<RecordRow> {
    const res = await db.query<RecordRow>(`${ROW_SQL} WHERE r.id = $1`, [id]);
    return res.rows[0];
  }

  async lockForWrite(client: PoolClient, publicId: string): Promise<RecordRow | null> {
    const res = await client.query<RecordRow>(`${ROW_SQL} WHERE r.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  async partLines(db: Queryable, recordIds: readonly string[]): Promise<PartLineRow[]> {
    if (recordIds.length === 0) return [];
    const res = await db.query<PartLineRow>(
      `SELECT mp.maintenance_record_id AS "recordId", p.public_id AS "partPublicId", p.part_number AS "partNumber", p.name,
              mp.quantity, mp.unit_cost_cents AS "unitCostCents"
         FROM maintenance.maintenance_parts mp
         JOIN maintenance.inventory_parts p ON p.id = mp.inventory_part_id
        WHERE mp.maintenance_record_id = ANY($1::bigint[])
        ORDER BY p.part_number`,
      [recordIds],
    );
    return res.rows;
  }

  /** Other unfinished work on the vehicle; while there is any, its flag stays set. */
  /** Whether any work on the vehicle is in progress: it is in the workshop (FMS-76). */
  async hasInProgress(db: Queryable, vehicleId: string): Promise<boolean> {
    const res = await db.query<{ busy: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM maintenance.maintenance_records WHERE vehicle_id = $1 AND status = 'in_progress') AS busy`,
      [vehicleId],
    );
    return res.rows[0].busy;
  }

  async hasOtherOpen(db: Queryable, vehicleId: string, exceptRecordId: string): Promise<boolean> {
    const res = await db.query<{ open: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM maintenance.maintenance_records
          WHERE vehicle_id = $1 AND id <> $2 AND status = ANY($3::maintenance.maintenance_status[])
       ) AS open`,
      [vehicleId, exceptRecordId, OPEN_STATUSES],
    );
    return res.rows[0].open;
  }

  /** The public id of the vehicle's open record that keeps its flag set (the most recent), if any. */
  async openRecordFor(db: Queryable, vehicleId: string): Promise<string | null> {
    const res = await db.query<{ public_id: string }>(
      `SELECT public_id FROM maintenance.maintenance_records
        WHERE vehicle_id = $1 AND status = ANY($2::maintenance.maintenance_status[])
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [vehicleId, OPEN_STATUSES],
    );
    return res.rows[0]?.public_id ?? null;
  }

  /**
   * The open record behind each vehicle's flag (the most recent), summarized
   * for dispatch (FMS-33), by internal vehicle id.
   */
  async openRecordSummaries(
    db: Queryable,
    vehicleIds: readonly string[],
  ): Promise<Map<string, { id: string; description: string; status: string; priority: string; opened_at: Date }>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ vehicleId: string; id: string; description: string; status: string; priority: string; opened_at: Date }>(
      `SELECT DISTINCT ON (vehicle_id) vehicle_id AS "vehicleId", public_id AS id, description, status::text, priority::text, created_at AS opened_at
         FROM maintenance.maintenance_records
        WHERE vehicle_id = ANY($1::bigint[]) AND status = ANY($2::maintenance.maintenance_status[])
        ORDER BY vehicle_id, created_at DESC, id DESC`,
      [vehicleIds, OPEN_STATUSES],
    );
    return new Map(res.rows.map(({ vehicleId, ...summary }) => [vehicleId, summary]));
  }

  /**
   * The last change of each item on the vehicle (FMS-52): its latest completed
   * repair, before `before` when given, that used a part renewing the item. An
   * item never changed in the system has no row.
   */
  async lastServiceItems(db: Queryable, vehicleId: string, before: Date | null = null): Promise<LastServiceItemRow[]> {
    const res = await db.query<LastServiceItemRow>(
      `SELECT DISTINCT ON (p.service_item)
              p.service_item AS item, r.completed_at AS "changedAt", r.public_id AS "recordPublicId",
              r.odometer_km::float8 AS "odometerKm", p.part_number AS "partNumber"
         FROM maintenance.maintenance_records r
         JOIN maintenance.maintenance_parts mp ON mp.maintenance_record_id = r.id
         JOIN maintenance.inventory_parts p ON p.id = mp.inventory_part_id
        WHERE r.vehicle_id = $1 AND r.status = 'completed' AND p.service_item IS NOT NULL
          AND ($2::timestamptz IS NULL OR r.completed_at < $2)
        ORDER BY p.service_item, r.completed_at DESC, r.id DESC`,
      [vehicleId, before],
    );
    return res.rows;
  }

  /** Row-locks the parts by public id, in id order (two repairs using the same parts never deadlock). */
  async lockParts(client: PoolClient, publicIds: readonly string[]): Promise<LockedPart[]> {
    if (publicIds.length === 0) return [];
    const res = await client.query<LockedPart>(
      `SELECT id, public_id AS "publicId", part_number AS "partNumber", depot_id AS "depotId", is_active AS "isActive",
              stock_quantity AS "stockQuantity", reorder_threshold AS "reorderThreshold"
         FROM maintenance.inventory_parts
        WHERE public_id = ANY($1::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [publicIds],
    );
    return res.rows;
  }

  insertRecord(ctx: MutationContext, data: RecordWrite & { vehicle_id: string }, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.maintenance_records', 'INSERT', null, { ...data }, client);
  }

  updateRecord(ctx: MutationContext, id: string, data: RecordWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.maintenance_records', 'UPDATE', id, { ...data }, client);
  }

  /**
   * One part used in a repair: the line on the record (the full quantity
   * used), the stock taken off the shelf (audited) and the consumption in the
   * inventory ledger (audited). Stock never goes below zero (CHECK, FMS-23):
   * what the shelf did not have is returned as the shortfall. The line has no
   * id of its own (its key is record + part); the audited writes cover it.
   */
  async consumePart(
    ctx: MutationContext,
    client: PoolClient,
    use: { recordId: string; part: LockedPart; quantity: number; unitCostCents: number; vehicleDepotId: string; performedBy: string | null },
  ): Promise<{ stock: number; shortfall: number }> {
    await client.query(
      `INSERT INTO maintenance.maintenance_parts (maintenance_record_id, inventory_part_id, quantity, unit_cost_cents)
       VALUES ($1, $2, $3, $4)`,
      [use.recordId, use.part.id, use.quantity, use.unitCostCents],
    );
    const taken = Math.min(use.quantity, Math.max(use.part.stockQuantity, 0));
    const stock = use.part.stockQuantity - taken;
    const shortfall = use.quantity - taken;
    if (taken === 0) return { stock, shortfall };
    await this.mutate(ctx, 'maintenance.inventory_parts', 'UPDATE', use.part.id, { stock_quantity: stock }, client);
    await this.mutate(
      ctx,
      'maintenance.inventory_movements',
      'INSERT',
      null,
      {
        inventory_part_id: use.part.id,
        depot_id: use.part.depotId ?? use.vehicleDepotId,
        movement_type: 'consumption',
        quantity_delta: -taken,
        reference_type: 'maintenance_record',
        reference_id: use.recordId,
        performed_by: use.performedBy,
        notes: shortfall > 0 ? `${shortfall} more used than the stock record held` : null,
      },
      client,
    );
    return { stock, shortfall };
  }
}
