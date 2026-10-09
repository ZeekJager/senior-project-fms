import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A depot as GET /depots returns it (public id only). */
export interface DepotView {
  id: string;
  name: string;
  code: string | null;
  location: string;
}

/** Live depots in the caller's scope, by name: the choices for depot filters and pickers. */
export async function listDepots(db: Queryable, scope: Scope, page: Page): Promise<{ items: DepotView[]; total: number }> {
  const clause = scopeClause(scope, 'd.id', 1);
  const { limit, offset } = limitOffset(page);
  const n = clause.params.length;
  const count = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM fleet.depots d WHERE d.is_active AND ${clause.sql}`,
    clause.params,
  );
  const rows = await db.query<DepotView>(
    `SELECT d.public_id AS id, d.name, d.code, d.location
       FROM fleet.depots d
      WHERE d.is_active AND ${clause.sql}
      ORDER BY d.name, d.id
      LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...clause.params, limit, offset],
  );
  return { items: rows.rows, total: count.rows[0].total };
}

/** A depot's public_id from its internal id, or null if there is no such depot. */
export async function findDepotPublicId(db: Queryable, depotId: string): Promise<string | null> {
  const res = await db.query<{ public_id: string }>('SELECT public_id FROM fleet.depots WHERE id = $1', [depotId]);
  return res.rows[0]?.public_id ?? null;
}

/** Public ids of depots by internal id, for responses. */
export async function depotPublicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>> {
  if (depotIds.length === 0) return new Map();
  const res = await db.query<{ id: string; public_id: string }>(
    'SELECT id, public_id FROM fleet.depots WHERE id = ANY($1::bigint[])',
    [depotIds],
  );
  return new Map(res.rows.map((r) => [r.id, r.public_id]));
}

/** A live depot's internal id from its public id, if the caller's scope includes it. */
export async function resolveDepotInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null> {
  const clause = scopeClause(scope, 'd.id', 2);
  const res = await db.query<{ id: string }>(
    `SELECT d.id FROM fleet.depots d WHERE d.public_id = $1 AND d.is_active AND ${clause.sql}`,
    [publicId, ...clause.params],
  );
  return res.rows[0]?.id ?? null;
}

/** A live depot's public id from its code (as people write it in a spreadsheet), case-insensitively. */
export async function depotPublicIdByCode(db: Queryable, code: string): Promise<string | null> {
  const res = await db.query<{ public_id: string }>(
    'SELECT public_id FROM fleet.depots WHERE lower(code) = lower($1) AND is_active',
    [code.trim()],
  );
  return res.rows[0]?.public_id ?? null;
}
