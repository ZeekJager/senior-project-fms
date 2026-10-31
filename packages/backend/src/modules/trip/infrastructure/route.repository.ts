import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { DistanceSource, LineString } from '../domain/road';
import type { RouteStop } from '../domain/route';

/** A trip.routes row (internal ids). Numerics are read as float8, so they arrive as numbers. */
export interface RouteRow {
  id: string;
  publicId: string;
  name: string;
  depotId: string;
  originName: string | null;
  originLatitude: number | null;
  originLongitude: number | null;
  destinationName: string | null;
  destinationLatitude: number | null;
  destinationLongitude: number | null;
  stops: RouteStop[];
  distanceKm: number | null;
  estimatedDurationSeconds: number | null;
  distanceSource: DistanceSource | null;
  /** When the road (geometry) was measured; null while it is not. */
  measuredAt: Date | null;
  /** Made for one unplanned trip (FMS-139): left out of the lists. */
  isAdhoc: boolean;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Columns as written. `stops` is JSON text: node-pg would send an array as a Postgres array. */
export interface RouteWrite {
  name?: string;
  depot_id?: string;
  origin_name?: string | null;
  origin_latitude?: number | null;
  origin_longitude?: number | null;
  destination_name?: string | null;
  destination_latitude?: number | null;
  destination_longitude?: number | null;
  stops?: string;
  distance_km?: number | null;
  estimated_duration_seconds?: number | null;
  distance_source?: DistanceSource | null;
  /** GeoJSON text, as `stops`. */
  geometry?: string | null;
  measured_at?: Date | null;
  is_adhoc?: boolean;
  is_active?: boolean;
}

/** An active route whose road is still to be measured (the route-roads job). */
export interface UnmeasuredRoute {
  id: string;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  stops: RouteStop[];
  distanceSource: DistanceSource | null;
}

export interface RouteListFilter extends Page {
  scope: Scope;
  depotId?: string;
  search?: string;
  status: 'active' | 'retired' | 'all';
  sortBy: 'name' | 'distance_km' | 'updated_at';
  sortOrder: 'asc' | 'desc';
}

const SORT = { name: 'lower(r.name)', distance_km: 'r.distance_km', updated_at: 'r.updated_at' } as const;

const ROW_SQL = `
  SELECT r.id, r.public_id AS "publicId", r.name, r.depot_id AS "depotId",
         r.origin_name AS "originName", r.origin_latitude::float8 AS "originLatitude", r.origin_longitude::float8 AS "originLongitude",
         r.destination_name AS "destinationName", r.destination_latitude::float8 AS "destinationLatitude",
         r.destination_longitude::float8 AS "destinationLongitude", r.stops,
         r.distance_km::float8 AS "distanceKm", r.estimated_duration_seconds AS "estimatedDurationSeconds",
         r.distance_source AS "distanceSource", r.measured_at AS "measuredAt",
         r.is_adhoc AS "isAdhoc", r.is_active AS "isActive", r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt"
    FROM trip.routes r`;

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** trip.routes (FMS-83). Every route belongs to one depot; a depot-scoped caller sees only theirs. */
export class RouteRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async list(db: Queryable, f: RouteListFilter): Promise<{ rows: RouteRow[]; total: number }> {
    const scope = scopeClause(f.scope, 'r.depot_id', 1);
    const params: unknown[] = [...scope.params];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    // One-off routes (FMS-139) belong to their trip: never offered in the lists.
    const where = [scope.sql, 'NOT r.is_adhoc'];
    if (f.status !== 'all') where.push(f.status === 'active' ? 'r.is_active' : 'NOT r.is_active');
    if (f.depotId) where.push(`r.depot_id = ${add(f.depotId)}`);
    if (f.search) {
      const p = add(containsPattern(f.search));
      where.push(`(r.name ILIKE ${p} OR r.origin_name ILIKE ${p} OR r.destination_name ILIKE ${p})`);
    }
    const whereSql = where.join(' AND ');
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM trip.routes r WHERE ${whereSql}`, params);
    const dir = f.sortOrder === 'desc' ? 'DESC' : 'ASC';
    const { limit, offset } = limitOffset(f);
    const res = await db.query<RouteRow>(
      `${ROW_SQL} WHERE ${whereSql} ORDER BY ${SORT[f.sortBy]} ${dir} NULLS LAST, r.id ${dir} LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findVisible(db: Queryable, publicId: string, scope: Scope, lock = false): Promise<RouteRow | null> {
    const clause = scopeClause(scope, 'r.depot_id', 2);
    const res = await db.query<RouteRow>(`${ROW_SQL} WHERE r.public_id = $1 AND ${clause.sql}${lock ? ' FOR UPDATE' : ''}`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<RouteRow> {
    const res = await db.query<RouteRow>(`${ROW_SQL} WHERE r.id = $1`, [id]);
    return res.rows[0];
  }

  /** The road of a route the scope may see: undefined when the route is not visible, null when it has no road yet. */
  async geometryOf(db: Queryable, publicId: string, scope: Scope): Promise<LineString | null | undefined> {
    const clause = scopeClause(scope, 'r.depot_id', 2);
    const res = await db.query<{ geometry: LineString | null }>(`SELECT r.geometry FROM trip.routes r WHERE r.public_id = $1 AND ${clause.sql}`, [publicId, ...clause.params]);
    return res.rows.length === 0 ? undefined : res.rows[0].geometry;
  }

  /** Up to `limit` active routes with both ends and no road yet, oldest change first, locked and skipped by another run. */
  async unmeasured(db: Queryable, limit: number): Promise<UnmeasuredRoute[]> {
    const res = await db.query<UnmeasuredRoute>(
      `SELECT r.id, r.origin_latitude::float8 AS "originLatitude", r.origin_longitude::float8 AS "originLongitude",
              r.destination_latitude::float8 AS "destinationLatitude", r.destination_longitude::float8 AS "destinationLongitude",
              r.stops, r.distance_source AS "distanceSource"
         FROM trip.routes r
        WHERE r.is_active AND r.geometry IS NULL AND r.origin_latitude IS NOT NULL AND r.destination_latitude IS NOT NULL
        ORDER BY r.updated_at, r.id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return res.rows;
  }

  insert(ctx: MutationContext, data: RouteWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'trip.routes', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: RouteWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'trip.routes', 'UPDATE', id, { ...data }, client);
  }
}
