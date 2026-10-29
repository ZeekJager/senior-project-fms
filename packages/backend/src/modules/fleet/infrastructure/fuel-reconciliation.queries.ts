import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';

/** A vehicle as the fuel reconciliation (FMS-41, fuel module) judges it: its fuel and its rated efficiency. Internal ids. */
export interface FuelVehicle {
  id: string;
  publicId: string;
  depotPublicId: string;
  fuelType: 'petrol' | 'diesel' | 'hybrid' | 'electric' | 'cng' | 'lpg' | 'other';
  /** Expected consumption, integer ml/km; null only for an electric vehicle. */
  fuelEfficiencyMlPerKm: number | null;
  isActive: boolean;
}

/**
 * The vehicles of a scope, optionally one vehicle (public id) or one depot (internal id), in id order. Retired
 * vehicles are included: a period before they were retired still has its trips and fill-ups.
 */
export async function fuelVehicles(db: Queryable, scope: Scope, filter: { publicId?: string; depotId?: string } = {}): Promise<FuelVehicle[]> {
  const clause = scopeClause(scope, 'v.depot_id', 1);
  const params: unknown[] = [...clause.params];
  const where = [clause.sql];
  if (filter.publicId) {
    params.push(filter.publicId);
    where.push(`v.public_id = $${params.length}`);
  }
  if (filter.depotId) {
    params.push(filter.depotId);
    where.push(`v.depot_id = $${params.length}`);
  }
  const res = await db.query<FuelVehicle>(
    `SELECT v.id, v.public_id AS "publicId", d.public_id AS "depotPublicId", v.fuel_type AS "fuelType",
            v.fuel_efficiency_ml_per_km AS "fuelEfficiencyMlPerKm", v.is_active AS "isActive"
       FROM fleet.vehicles v
       JOIN fleet.depots d ON d.id = v.depot_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.id`,
    params,
  );
  return res.rows;
}

/**
 * A live depot's internal id from its public id, if the scope includes it. Unlike resolveDepotInScope it takes no
 * lock: the reconciliation only reads, and is meant for the read replica (FMS-94), where a lock is refused.
 */
export async function fuelDepotInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null> {
  const clause = scopeClause(scope, 'd.id', 2);
  const res = await db.query<{ id: string }>(`SELECT d.id FROM fleet.depots d WHERE d.public_id = $1 AND d.is_active AND ${clause.sql}`, [publicId, ...clause.params]);
  return res.rows[0]?.id ?? null;
}
