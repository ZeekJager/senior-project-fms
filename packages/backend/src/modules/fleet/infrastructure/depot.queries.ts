import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';

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
