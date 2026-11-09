import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A vehicle as recall matching sees it (FMS-133, maintenance module). Internal ids. */
export interface RecallVehicle {
  id: string;
  publicId: string;
  depotId: string;
  make: string;
  model: string;
  modelYear: number | null;
}

/**
 * The vehicles not retired, or those of `ids` among them, whose make and model are those asked (ignoring
 * case and outer spaces) when `make` and `model` are given: what a manufacturer's recall can apply to.
 */
export async function recallVehicles(
  db: Queryable,
  filter: { ids?: readonly string[] | null; make?: string; model?: string },
): Promise<RecallVehicle[]> {
  const res = await db.query<RecallVehicle>(
    `SELECT v.id, v.public_id AS "publicId", v.depot_id AS "depotId", v.make, v.model, v.model_year AS "modelYear"
       FROM fleet.vehicles v
      WHERE v.is_active AND v.status <> 'retired'
        AND ($1::bigint[] IS NULL OR v.id = ANY($1::bigint[]))
        AND ($2::text IS NULL OR lower(btrim(v.make)) = lower(btrim($2)))
        AND ($3::text IS NULL OR lower(btrim(v.model)) = lower(btrim($3)))
      ORDER BY v.id`,
    [filter.ids ?? null, filter.make ?? null, filter.model ?? null],
  );
  return res.rows;
}

/** Of the vehicles asked (internal ids), those not retired, with their public ids. */
export async function activeVehiclePublicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await db.query<{ id: string; public_id: string }>(
    `SELECT id, public_id FROM fleet.vehicles WHERE id = ANY($1::bigint[]) AND is_active AND status <> 'retired'`,
    [ids],
  );
  return new Map(res.rows.map((r) => [r.id, r.public_id]));
}
