import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A depot's public_id from its internal id, or null if there is no such depot. */
export async function findDepotPublicId(db: Queryable, depotId: string): Promise<string | null> {
  const res = await db.query<{ public_id: string }>('SELECT public_id FROM fleet.depots WHERE id = $1', [depotId]);
  return res.rows[0]?.public_id ?? null;
}
