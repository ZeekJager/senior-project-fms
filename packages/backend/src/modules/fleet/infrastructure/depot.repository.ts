import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { DepotView } from '../domain/depot';

/** The columns of fleet.depots a write may set. */
export interface DepotWrite {
  name?: string;
  code?: string | null;
  location?: string;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;
}

export interface DepotListFilter extends Page {
  /** Narrow to the caller's depots (`in_scope=true`); otherwise every depot. */
  scope?: Scope;
  status: 'active' | 'inactive' | 'all';
  search?: string;
}

const VIEW_SQL = `
  SELECT d.public_id AS id, d.name, d.code, d.location, d.address, d.city, d.country, d.timezone,
         d.latitude::float8 AS latitude, d.longitude::float8 AS longitude, d.capacity, d.is_active,
         d.version, d.created_at, d.updated_at
    FROM fleet.depots d`;

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** fleet.depots. Writes go through `mutate`, one audit row each; deletion is soft (is_active). */
export class DepotRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** A page of depots by name. */
  async list(db: Queryable, filter: DepotListFilter): Promise<{ items: DepotView[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (filter.scope) {
      const clause = scopeClause(filter.scope, 'd.id', 1);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (filter.status !== 'all') where.push(filter.status === 'active' ? 'd.is_active' : 'NOT d.is_active');
    if (filter.search) {
      const p = add(containsPattern(filter.search));
      where.push(`(d.name ILIKE ${p} OR d.code ILIKE ${p} OR d.location ILIKE ${p} OR d.city ILIKE ${p})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM fleet.depots d ${whereSql}`, params);
    const { limit, offset } = limitOffset(filter);
    const rows = await db.query<DepotView>(`${VIEW_SQL} ${whereSql} ORDER BY d.name, d.id LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { items: rows.rows, total: count.rows[0].total };
  }

  async findView(db: Queryable, publicId: string): Promise<DepotView | null> {
    const res = await db.query<DepotView>(`${VIEW_SQL} WHERE d.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findViewById(db: Queryable, id: string): Promise<DepotView> {
    const res = await db.query<DepotView>(`${VIEW_SQL} WHERE d.id = $1`, [id]);
    return res.rows[0];
  }

  /** Reads and row-locks a depot for a write in the same transaction. */
  async lockForWrite(
    client: PoolClient,
    publicId: string,
  ): Promise<{ id: string; isActive: boolean; version: number; latitude: number | null; longitude: number | null } | null> {
    const res = await client.query(
      `SELECT id, is_active AS "isActive", version, latitude::float8 AS latitude, longitude::float8 AS longitude
         FROM fleet.depots WHERE public_id = $1 FOR UPDATE`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  /** Active vehicles and drivers (by home depot, fleet's copy of the account) still in the depot. */
  async occupancy(db: Queryable, depotId: string): Promise<{ vehicles: number; drivers: number }> {
    const res = await db.query<{ vehicles: number; drivers: number }>(
      `SELECT (SELECT count(*)::int FROM fleet.vehicles v WHERE v.depot_id = $1 AND v.is_active) AS vehicles,
              (SELECT count(*)::int FROM fleet.drivers d JOIN fleet.driver_accounts a ON a.user_id = d.user_id
                WHERE a.depot_id = $1 AND d.is_active) AS drivers`,
      [depotId],
    );
    return res.rows[0];
  }

  insert(ctx: MutationContext, data: DepotWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.depots', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: DepotWrite & { is_active?: boolean }, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.depots', 'UPDATE', id, { ...data }, client);
  }

  /** Soft delete: `is_active = FALSE`, one audited change. */
  deactivate(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.depots', 'DELETE', id, {}, client);
  }
}
