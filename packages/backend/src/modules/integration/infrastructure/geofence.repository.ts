import type { PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { auditedMutation, type MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { Polygon } from '../domain/geometry';
import type { FenceRule, GeofenceApplies, GeofenceKind } from '../domain/location-rules';

/** A row of tracking.geofences. Internal ids. */
export interface GeofenceRow {
  id: string;
  publicId: string;
  depotId: string;
  name: string;
  description: string | null;
  kind: GeofenceKind;
  applies: GeofenceApplies;
  polygon: Polygon;
  areaM2: number;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

/** A fence as the rules check it, with what its events and flags name. */
export interface ActiveFence extends FenceRule {
  publicId: string;
  name: string;
}

/** The columns a write sets (snake case, as tracking.geofences has them). */
export interface GeofenceWrite {
  depot_id?: string;
  name?: string;
  description?: string | null;
  kind?: GeofenceKind;
  applies?: GeofenceApplies;
  polygon?: Polygon;
  min_lat?: number;
  max_lat?: number;
  min_lng?: number;
  max_lng?: number;
  area_m2?: number;
}

const TABLE = 'tracking.geofences';

const COLUMNS = `g.id, g.public_id AS "publicId", g.depot_id AS "depotId", g.name, g.description, g.kind, g.applies, g.polygon,
       g.area_m2 AS "areaM2", g.is_active AS "isActive", g.version, g.created_at AS "createdAt", g.updated_at AS "updatedAt",
       g.updated_by AS "updatedBy"`;

/** tracking.geofences (FMS-90). Every change is audited; removal is soft. */
export class GeofenceRepository {
  /** The fences in a scope, of one depot (internal id) if given, by depot then name. */
  async list(db: Queryable, filter: { scope: Scope; depotId: string | null; status: 'active' | 'inactive' | 'all' }): Promise<GeofenceRow[]> {
    const clause = scopeClause(filter.scope, 'g.depot_id', 3);
    const res = await db.query<GeofenceRow>(
      `SELECT ${COLUMNS} FROM tracking.geofences g
        WHERE ($1::bigint IS NULL OR g.depot_id = $1)
          AND ($2::text = 'all' OR g.is_active = ($2::text = 'active'))
          AND ${clause.sql}
        ORDER BY g.depot_id, lower(g.name), g.id`,
      [filter.depotId, filter.status, ...clause.params],
    );
    return res.rows;
  }

  async find(db: Queryable, publicId: string): Promise<GeofenceRow | null> {
    const res = await db.query<GeofenceRow>(`SELECT ${COLUMNS} FROM tracking.geofences g WHERE g.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<GeofenceRow> {
    const res = await db.query<GeofenceRow>(`SELECT ${COLUMNS} FROM tracking.geofences g WHERE g.id = $1`, [id]);
    return res.rows[0];
  }

  /** The fence, locked until the transaction ends, so two changes to it queue. */
  async lock(client: PoolClient, publicId: string): Promise<GeofenceRow | null> {
    const res = await client.query<GeofenceRow>(`SELECT ${COLUMNS} FROM tracking.geofences g WHERE g.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  /**
   * How many active fences the depot has, after waiting for any other change to its fences: two fences drawn at
   * once cannot both pass the limit.
   */
  async countActive(client: PoolClient, depotId: string): Promise<number> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('tracking.geofences'), $1::int)`, [Number(depotId) % 2_147_483_647]);
    const res = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM tracking.geofences WHERE depot_id = $1 AND is_active`, [depotId]);
    return res.rows[0].n;
  }

  /** A depot's active fences, as the rules check them. */
  async activeForDepot(db: Queryable, depotId: string): Promise<ActiveFence[]> {
    const res = await db.query<{ id: string; publicId: string; name: string; version: number; kind: GeofenceKind; applies: GeofenceApplies; polygon: Polygon; minLat: number; maxLat: number; minLng: number; maxLng: number }>(
      `SELECT id, public_id AS "publicId", name, version, kind, applies, polygon,
              min_lat::float8 AS "minLat", max_lat::float8 AS "maxLat", min_lng::float8 AS "minLng", max_lng::float8 AS "maxLng"
         FROM tracking.geofences
        WHERE depot_id = $1 AND is_active
        ORDER BY id`,
      [depotId],
    );
    return res.rows.map(({ minLat, maxLat, minLng, maxLng, ...f }) => ({ ...f, box: { minLat, maxLat, minLng, maxLng } }));
  }

  async insert(client: PoolClient, ctx: MutationContext, data: GeofenceWrite): Promise<GeofenceRow> {
    const row = await auditedMutation(client, ctx, TABLE, 'INSERT', null, { ...data, created_by: ctx.userId, updated_by: ctx.userId });
    return this.findById(client, row.id as string);
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, data: GeofenceWrite): Promise<GeofenceRow> {
    await auditedMutation(client, ctx, TABLE, 'UPDATE', id, { ...data, updated_by: ctx.userId });
    return this.findById(client, id);
  }

  /** Soft: is_active goes false, the audit keeps the row. */
  async deactivate(client: PoolClient, ctx: MutationContext, id: string): Promise<GeofenceRow> {
    await auditedMutation(client, ctx, TABLE, 'DELETE', id, { updated_by: ctx.userId });
    return this.findById(client, id);
  }

  async reactivate(client: PoolClient, ctx: MutationContext, id: string): Promise<GeofenceRow> {
    await auditedMutation(client, ctx, TABLE, 'UPDATE', id, { is_active: true, updated_by: ctx.userId });
    return this.findById(client, id);
  }
}
