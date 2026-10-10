import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';

/** A maintenance.inventory_parts row (internal ids). */
export interface PartRow {
  id: string;
  publicId: string;
  partNumber: string;
  name: string;
  description: string | null;
  depotId: string | null;
  unitCostCents: number | null;
  stockQuantity: number;
  reorderThreshold: number;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartWrite {
  part_number?: string;
  name?: string;
  description?: string | null;
  depot_id?: string | null;
  unit_cost_cents?: number | null;
  reorder_threshold?: number;
  is_active?: boolean;
  stock_quantity?: number;
}

export interface PartListFilter extends Page {
  scope: Scope;
  depotId?: string;
  belowReorder?: boolean;
  /** out: none left; low: 1 up to the reorder threshold; ok: above it (as stock_status). */
  stockStatus?: 'out' | 'low' | 'ok';
  search?: string;
  status: 'active' | 'inactive' | 'all';
  sortBy: 'part_number' | 'name' | 'stock_quantity';
  sortOrder: 'asc' | 'desc';
}

const SORT = { part_number: 'p.part_number', name: 'p.name', stock_quantity: 'p.stock_quantity' } as const;

const ROW_SQL = `
  SELECT p.id, p.public_id AS "publicId", p.part_number AS "partNumber", p.name, p.description, p.depot_id AS "depotId",
         p.unit_cost_cents AS "unitCostCents", p.stock_quantity AS "stockQuantity", p.reorder_threshold AS "reorderThreshold",
         p.is_active AS "isActive", p.version, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM maintenance.inventory_parts p`;

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * maintenance.inventory_parts and its ledger (FMS-23). A part is in a depot's
 * stock or shared (depot_id null); a depot-scoped caller sees their depot's
 * parts and the shared ones.
 */
export class InventoryRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** The caller's parts: their depots' stock plus shared stock. */
  private visible(scope: Scope, nextParam: number): { sql: string; params: unknown[] } {
    const clause = scopeClause(scope, 'p.depot_id', nextParam);
    return { sql: `(p.depot_id IS NULL OR ${clause.sql})`, params: clause.params };
  }

  async list(db: Queryable, f: PartListFilter): Promise<{ rows: PartRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    const vis = this.visible(f.scope, 1);
    where.push(vis.sql);
    params.push(...vis.params);
    if (f.status !== 'all') where.push(f.status === 'active' ? 'p.is_active' : 'NOT p.is_active');
    if (f.depotId) where.push(`p.depot_id = ${add(f.depotId)}`);
    if (f.belowReorder !== undefined) where.push(f.belowReorder ? 'p.stock_quantity <= p.reorder_threshold' : 'p.stock_quantity > p.reorder_threshold');
    if (f.stockStatus === 'out') where.push('p.stock_quantity <= 0');
    if (f.stockStatus === 'low') where.push('p.stock_quantity > 0 AND p.stock_quantity <= p.reorder_threshold');
    if (f.stockStatus === 'ok') where.push('p.stock_quantity > 0 AND p.stock_quantity > p.reorder_threshold');
    if (f.search) {
      const p = add(containsPattern(f.search));
      where.push(`(p.part_number ILIKE ${p} OR p.name ILIKE ${p})`);
    }
    const whereSql = where.join(' AND ');
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.inventory_parts p WHERE ${whereSql}`, params);
    const dir = f.sortOrder === 'desc' ? 'DESC' : 'ASC';
    const { limit, offset } = limitOffset(f);
    const res = await db.query<PartRow>(
      `${ROW_SQL} WHERE ${whereSql} ORDER BY ${SORT[f.sortBy]} ${dir}, p.id ${dir} LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findVisible(db: Queryable, publicId: string, scope: Scope, lock = false): Promise<PartRow | null> {
    const vis = this.visible(scope, 2);
    const res = await db.query<PartRow>(`${ROW_SQL} WHERE p.public_id = $1 AND ${vis.sql}${lock ? ' FOR UPDATE' : ''}`, [publicId, ...vis.params]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<PartRow> {
    const res = await db.query<PartRow>(`${ROW_SQL} WHERE p.id = $1`, [id]);
    return res.rows[0];
  }

  async movements(db: Queryable, partId: string, page: Page): Promise<{ rows: MovementRow[]; total: number }> {
    const count = await db.query<{ total: number }>('SELECT count(*)::int AS total FROM maintenance.inventory_movements WHERE inventory_part_id = $1', [partId]);
    const { limit, offset } = limitOffset(page);
    const res = await db.query<MovementRow>(
      `SELECT id, movement_type AS "movementType", quantity_delta AS "quantityDelta", reference_type AS "referenceType",
              notes, performed_by AS "performedBy", occurred_at AS "occurredAt"
         FROM maintenance.inventory_movements WHERE inventory_part_id = $1
        ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [partId, limit, offset],
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  insert(ctx: MutationContext, data: PartWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.inventory_parts', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: PartWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.inventory_parts', 'UPDATE', id, { ...data }, client);
  }

  /** A ledger line; audited like every write. */
  recordMovement(
    ctx: MutationContext,
    client: PoolClient,
    m: { partId: string; depotId: string | null; type: 'purchase' | 'adjustment'; delta: number; notes: string; performedBy: string | null },
  ): Promise<Row> {
    return this.mutate(
      ctx,
      'maintenance.inventory_movements',
      'INSERT',
      null,
      { inventory_part_id: m.partId, depot_id: m.depotId, movement_type: m.type, quantity_delta: m.delta, notes: m.notes, performed_by: m.performedBy },
      client,
    );
  }
}

export interface MovementRow {
  id: string;
  movementType: 'purchase' | 'consumption' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'return';
  quantityDelta: number;
  referenceType: string | null;
  notes: string | null;
  performedBy: string | null;
  occurredAt: Date;
}
