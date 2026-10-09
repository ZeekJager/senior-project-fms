import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FuelType, VehicleStatus, VehicleTrip, VehicleType, VehicleView } from '../domain/vehicle';
import { resolveDepotInScope } from './depot.queries';

/** Columns a list can be sorted by, and the SQL behind each. */
export const VEHICLE_SORT_COLUMNS = {
  registration_number: 'v.registration_number',
  make: 'v.make',
  model: 'v.model',
  year: 'v.model_year',
  odometer_km: 'v.odometer_km',
  health_score: 'v.health_score',
  created_at: 'v.created_at',
  updated_at: 'v.updated_at',
} as const;

export type VehicleSortKey = keyof typeof VEHICLE_SORT_COLUMNS;

export interface VehicleListQuery {
  page: number;
  page_size: number;
  /** A depot's public id. */
  depot_id?: string;
  /** Given: vehicles in that status, retired ones included. Omitted: live (not retired) vehicles only. */
  status?: VehicleStatus;
  maintenance_flag?: boolean;
  /** Matches registration number, VIN, make or model. */
  search?: string;
  sort_by: VehicleSortKey;
  sort_order: 'asc' | 'desc';
}

/** The columns of fleet.vehicles a write may set. */
export interface VehicleWrite {
  depot_id?: string;
  registration_number?: string;
  vin?: string | null;
  make?: string;
  model?: string;
  model_year?: number | null;
  vehicle_type?: string;
  fuel_type?: string;
  fuel_efficiency_ml_per_km?: number | null;
  odometer_km?: number;
}

/** What a write needs to know about the current row, read under a row lock. */
export interface LockedVehicle {
  id: string;
  depotId: string;
  isActive: boolean;
  fuelType: FuelType;
  fuelEfficiencyMlPerKm: number | null;
  odometerKm: number;
  version: number;
}

/** Current trips by vehicle internal id: the trip module's query, passed in through its index.ts. */
export type ActiveTripLookup = (db: Queryable, vehicleIds: readonly string[]) => Promise<Map<string, VehicleTrip>>;

/** A VIEW_SQL row: the view before its trip is attached, plus the internal id to attach it by. */
type VehicleRow = Omit<VehicleView, 'current_trip'> & { internal_id: string };

const VIEW_SQL = `
  SELECT v.id AS internal_id, v.public_id AS id, v.registration_number, v.vin, v.make, v.model, v.model_year AS year,
         v.vehicle_type, v.fuel_type, v.fuel_efficiency_ml_per_km, v.status, v.maintenance_flag,
         v.health_score, d.public_id AS depot_id, v.odometer_km::float8 AS odometer_km,
         v.version, v.created_at, v.updated_at
    FROM fleet.vehicles v
    JOIN fleet.depots d ON d.id = v.depot_id`;

/** `%term%` for ILIKE, with the user's `%`, `_` and `\` matched literally. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * fleet.vehicles. Every read and write by id takes the caller's depot scope,
 * so a vehicle outside it is simply not found (404, never 403). Writes go
 * through `mutate`, one audit row each.
 */
export class VehicleRepository extends Repository {
  constructor(
    db: Pool,
    private readonly activeTrips: ActiveTripLookup,
  ) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async findView(db: Queryable, publicId: string, scope: Scope): Promise<VehicleView | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<VehicleRow>(`${VIEW_SQL} WHERE v.public_id = $1 AND ${clause.sql}`, [publicId, ...clause.params]);
    const [view] = await this.withTrips(db, res.rows);
    return view ?? null;
  }

  /** By internal id, without a scope: for re-reading a row the caller has just written. */
  async findViewById(db: Queryable, id: string): Promise<VehicleView> {
    const res = await db.query<VehicleRow>(`${VIEW_SQL} WHERE v.id = $1`, [id]);
    const [view] = await this.withTrips(db, res.rows);
    return view;
  }

  async list(db: Queryable, query: VehicleListQuery, scope: Scope): Promise<{ items: VehicleView[]; total: number }> {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clause = scopeClause(scope, 'v.depot_id', params.length + 1);
    where.push(clause.sql);
    params.push(...clause.params);

    // Retired vehicles leave the default list; asking for a status shows that status, retired included.
    where.push(query.status ? `v.status = ${add(query.status)}` : 'v.is_active');
    if (query.depot_id) where.push(`d.public_id = ${add(query.depot_id)}`);
    if (query.maintenance_flag !== undefined) where.push(`v.maintenance_flag = ${add(query.maintenance_flag)}`);
    if (query.search) {
      const p = add(containsPattern(query.search));
      where.push(`(v.registration_number ILIKE ${p} OR v.vin ILIKE ${p} OR v.make ILIKE ${p} OR v.model ILIKE ${p})`);
    }

    const whereSql = where.join(' AND ');
    const count = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM fleet.vehicles v JOIN fleet.depots d ON d.id = v.depot_id WHERE ${whereSql}`,
      params,
    );

    // Sort column and direction come from the whitelist above, never from input text.
    const direction = query.sort_order === 'desc' ? 'DESC' : 'ASC';
    const limit = add(query.page_size);
    const offset = add((query.page - 1) * query.page_size);
    const rows = await db.query<VehicleRow>(
      `${VIEW_SQL} WHERE ${whereSql}
        ORDER BY ${VEHICLE_SORT_COLUMNS[query.sort_by]} ${direction} NULLS LAST, v.id ${direction}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: await this.withTrips(db, rows.rows), total: count.rows[0].total };
  }

  /** Attaches each vehicle's current trip (one query for all rows) and drops the internal id. */
  private async withTrips(db: Queryable, rows: VehicleRow[]): Promise<VehicleView[]> {
    const trips = await this.activeTrips(db, rows.map((r) => r.internal_id));
    return rows.map(({ internal_id, ...row }) => ({ ...row, current_trip: trips.get(internal_id) ?? null }));
  }

  /** A live depot's internal id from its public id, if the caller's scope includes it. */
  resolveDepot(db: Queryable, publicId: string, scope: Scope): Promise<string | null> {
    return resolveDepotInScope(db, publicId, scope);
  }

  /** Reads and row-locks a vehicle in the caller's scope, for a write in the same transaction. */
  async lockForWrite(client: PoolClient, publicId: string, scope: Scope): Promise<LockedVehicle | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await client.query<LockedVehicle>(
      `SELECT v.id, v.depot_id AS "depotId", v.is_active AS "isActive", v.fuel_type AS "fuelType",
              v.fuel_efficiency_ml_per_km AS "fuelEfficiencyMlPerKm", v.odometer_km::float8 AS "odometerKm",
              v.version
         FROM fleet.vehicles v
        WHERE v.public_id = $1 AND ${clause.sql}
          FOR UPDATE`,
      [publicId, ...clause.params],
    );
    return res.rows[0] ?? null;
  }

  /** Both ids of a vehicle in the caller's scope (retired included), by either id; null when not visible. */
  async findRef(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope): Promise<{ id: string; publicId: string } | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const column = 'publicId' in by ? 'v.public_id' : 'v.id';
    const res = await db.query<{ id: string; publicId: string }>(
      `SELECT v.id, v.public_id AS "publicId" FROM fleet.vehicles v WHERE ${column} = $1 AND ${clause.sql}`,
      ['publicId' in by ? by.publicId : by.id, ...clause.params],
    );
    return res.rows[0] ?? null;
  }

  /** Both ids of each vehicle in the caller's scope (retired included) among these public ids; the rest are left out. */
  async findRefs(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<{ id: string; publicId: string }[]> {
    if (publicIds.length === 0) return [];
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<{ id: string; publicId: string }>(
      `SELECT v.id, v.public_id AS "publicId" FROM fleet.vehicles v WHERE v.public_id = ANY($1::uuid[]) AND ${clause.sql}`,
      [publicIds, ...clause.params],
    );
    return res.rows;
  }

  /** A vehicle's type by internal id, or null if there is no such vehicle (used by driver eligibility). */
  async typeOf(db: Queryable, vehicleId: string): Promise<VehicleType | null> {
    const res = await db.query<{ vehicle_type: VehicleType }>('SELECT vehicle_type FROM fleet.vehicles WHERE id = $1', [vehicleId]);
    return res.rows[0]?.vehicle_type ?? null;
  }

  /** True while a driver holds an active assignment to the vehicle (fleet.driver_vehicle_assignments). */
  async hasActiveAssignment(db: Queryable, vehicleId: string): Promise<boolean> {
    const res = await db.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM fleet.driver_vehicle_assignments
          WHERE vehicle_id = $1 AND status = 'active'
            AND (assigned_until IS NULL OR assigned_until > CURRENT_TIMESTAMP)
       ) AS active`,
      [vehicleId],
    );
    return res.rows[0].active;
  }

  insert(ctx: MutationContext, data: VehicleWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.vehicles', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: VehicleWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.vehicles', 'UPDATE', id, { ...data }, client);
  }

  /** Soft retirement: `is_active = FALSE` and `status = 'retired'` in one audited change. */
  retire(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.vehicles', 'DELETE', id, { status: 'retired' }, client);
  }
}
