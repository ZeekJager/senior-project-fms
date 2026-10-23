import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FuelType, VehicleStatus, VehicleTrip, VehicleType, VehicleView } from '../domain/vehicle';
import type { StatusChangeSource } from '../domain/availability';
import { EXPIRY_WINDOW_DAYS } from '../domain/expiry';
import { operatingToday } from '../domain/attendance';
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
  status: 'v.status::text',
  vehicle_type: 'v.vehicle_type::text',
  depot: 'd.name',
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
  /**
   * true: vehicles that can be sent out now (active, not flagged for maintenance,
   * not on an assigned or en-route trip, no expired document). false: the rest.
   */
  ready_to_dispatch?: boolean;
  /**
   * Vehicles with a live document that is `expired` (past its date), `expiring`
   * (within the expiry window, today included) or `due` (either).
   */
  documents?: 'expired' | 'expiring' | 'due';
  /** Matches registration number, VIN, make or model. */
  search?: string;
  sort_by: VehicleSortKey;
  sort_order: 'asc' | 'desc';
  /** A second sort, applied to rows the first leaves tied. Ignored when it is the same column as `sort_by`. */
  then_by?: VehicleSortKey;
  then_order?: 'asc' | 'desc';
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
const LOCKED_COLUMNS = `SELECT v.id, v.depot_id AS "depotId", v.is_active AS "isActive", v.status, v.fuel_type AS "fuelType",
       v.fuel_efficiency_ml_per_km AS "fuelEfficiencyMlPerKm", v.odometer_km::float8 AS "odometerKm",
       v.maintenance_flag AS "maintenanceFlag", v.version
  FROM fleet.vehicles v`;

/** A status change as fleet.vehicle_status_history keeps it (FMS-76). */
export interface StatusChangeRow {
  fromStatus: VehicleStatus;
  toStatus: VehicleStatus;
  reason: string | null;
  source: StatusChangeSource;
  maintenanceRecordId: string | null;
  /** Internal user id. */
  changedBy: string | null;
  changedAt: Date;
}

export interface LockedVehicle {
  id: string;
  depotId: string;
  isActive: boolean;
  status: VehicleStatus;
  fuelType: FuelType;
  fuelEfficiencyMlPerKm: number | null;
  odometerKm: number;
  maintenanceFlag: boolean;
  version: number;
}

/** What the maintenance module needs to know about a vehicle (vehicleMaintenance.findInScope). */
export interface MaintenanceVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  depotId: string;
  isActive: boolean;
  maintenanceFlag: boolean;
}

/** The trip module's SQL boolean for a vehicle column being on an assigned or en-route trip (see trip/index.ts). */
export type ActiveTripSql = (vehicleIdColumn: string) => string;

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
/** A vehicle as GPS ingestion needs it (FMS-88). */
export interface TrackingVehicle {
  id: string;
  publicId: string;
  /** Internal id, for the telemetry rules' per-depot thresholds (FMS-46). */
  depotId: string | null;
  depotPublicId: string | null;
  isActive: boolean;
}

/** A vehicle as the live map lists it (FMS-45). */
export interface LiveMapVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  vehicleType: string;
  status: string;
  maintenanceFlag: boolean;
  depotPublicId: string | null;
}

export class VehicleRepository extends Repository {
  constructor(
    db: Pool,
    private readonly activeTrips: ActiveTripLookup,
    private readonly onActiveTripSql: ActiveTripSql,
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

  /**
   * Any vehicle by public id, with its depot's internal id: what the vehicle
   * cache stores, so a later read can check the caller's depot scope without
   * PostgreSQL. The depot id stays on the server (in Redis), never in a response.
   */
  async findViewWithDepot(db: Queryable, publicId: string): Promise<{ view: VehicleView; depotId: string } | null> {
    const res = await db.query<VehicleRow & { internal_depot_id: string }>(
      `${VIEW_SQL.replace('SELECT v.id AS internal_id,', 'SELECT v.id AS internal_id, v.depot_id AS internal_depot_id,')} WHERE v.public_id = $1`,
      [publicId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const { internal_depot_id: depotId, ...rest } = row;
    const [view] = await this.withTrips(db, [rest]);
    return { view, depotId };
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

    // A deleted depot's vehicles stay in the database but leave every list (FMS-20).
    where.push('d.is_active');
    // Retired vehicles leave the default list; asking for a status shows that status, retired included.
    where.push(query.status ? `v.status = ${add(query.status)}` : 'v.is_active');
    if (query.depot_id) where.push(`d.public_id = ${add(query.depot_id)}`);
    if (query.maintenance_flag !== undefined) where.push(`v.maintenance_flag = ${add(query.maintenance_flag)}`);

    // Document dates are calendar dates in Ethiopia (the operating day), like licence dates.
    if (query.ready_to_dispatch !== undefined || query.documents) {
      const today = add(operatingToday());
      const liveDocument = (dateCondition: string) =>
        `EXISTS (SELECT 1 FROM document.documents doc WHERE doc.owner_type = 'vehicle' AND doc.owner_id = v.id AND doc.deleted_at IS NULL AND doc.expires_on ${dateCondition})`;
      const expired = liveDocument(`< ${today}::date`);
      const expiring = liveDocument(`BETWEEN ${today}::date AND ${today}::date + ${EXPIRY_WINDOW_DAYS}`);
      if (query.documents === 'expired') where.push(expired);
      if (query.documents === 'expiring') where.push(expiring);
      if (query.documents === 'due') where.push(`(${expired} OR ${expiring})`);
      if (query.ready_to_dispatch !== undefined) {
        const ready = `(v.status = 'active' AND NOT v.maintenance_flag AND NOT ${this.onActiveTripSql('v.id')} AND NOT ${expired})`;
        where.push(query.ready_to_dispatch ? ready : `NOT ${ready}`);
      }
    }
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
    const second =
      query.then_by && query.then_by !== query.sort_by ? `${VEHICLE_SORT_COLUMNS[query.then_by]} ${query.then_order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ` : '';
    const rows = await db.query<VehicleRow>(
      `${VIEW_SQL} WHERE ${whereSql}
        ORDER BY ${VEHICLE_SORT_COLUMNS[query.sort_by]} ${direction} NULLS LAST, ${second}v.id ${direction}
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
    const res = await client.query<LockedVehicle>(`${LOCKED_COLUMNS} WHERE v.public_id = $1 AND ${clause.sql} FOR UPDATE`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  /** The same by internal id, for another module's workflow that has already checked scope (maintenance). */
  async lockById(client: PoolClient, id: string): Promise<LockedVehicle | null> {
    const res = await client.query<LockedVehicle>(`${LOCKED_COLUMNS} WHERE v.id = $1 FOR UPDATE`, [id]);
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

  /**
   * A vehicle in the caller's scope for a maintenance write: both ids, plate,
   * internal depot and whether it is live. `lock` row-locks it, so two
   * maintenance writes on one vehicle (and its flag) happen one after the other.
   */
  async findForMaintenance(
    db: Queryable,
    by: { publicId: string } | { id: string },
    scope: Scope,
    lock = false,
  ): Promise<MaintenanceVehicle | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const column = 'publicId' in by ? 'v.public_id' : 'v.id';
    const res = await db.query<MaintenanceVehicle>(
      `SELECT v.id, v.public_id AS "publicId", v.registration_number AS "registrationNumber", v.depot_id AS "depotId",
              v.is_active AS "isActive", v.maintenance_flag AS "maintenanceFlag"
         FROM fleet.vehicles v WHERE ${column} = $1 AND ${clause.sql}${lock ? ' FOR UPDATE' : ''}`,
      ['publicId' in by ? by.publicId : by.id, ...clause.params],
    );
    return res.rows[0] ?? null;
  }

  /**
   * A vehicle for trip assignment (FMS-31): in the caller's scope, with its
   * status and maintenance flag, share-locked. Opening a maintenance record
   * locks the row to set the flag, so the two wait for each other.
   */
  async findForTrip(
    db: Queryable,
    publicId: string,
    scope: Scope,
  ): Promise<{ id: string; publicId: string; status: string; maintenanceFlag: boolean } | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<{ id: string; publicId: string; status: string; maintenanceFlag: boolean }>(
      `SELECT v.id, v.public_id AS "publicId", v.status, v.maintenance_flag AS "maintenanceFlag"
         FROM fleet.vehicles v WHERE v.public_id = $1 AND ${clause.sql} FOR SHARE`,
      [publicId, ...clause.params],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Vehicles for GPS ingestion (FMS-88), by public or internal ids, in the caller's scope: both ids, the
   * depot's public id (who receives VehicleLocationUpdated) and whether the vehicle is live.
   */
  async trackingRefs(db: Queryable, by: { publicIds: readonly string[] } | { ids: readonly string[] }, scope: Scope): Promise<TrackingVehicle[]> {
    const list = 'publicIds' in by ? by.publicIds : by.ids;
    if (list.length === 0) return [];
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<TrackingVehicle>(
      `SELECT v.id, v.public_id AS "publicId", v.depot_id AS "depotId", d.public_id AS "depotPublicId", v.is_active AS "isActive"
         FROM fleet.vehicles v
         LEFT JOIN fleet.depots d ON d.id = v.depot_id
        WHERE ${'publicIds' in by ? 'v.public_id = ANY($1::uuid[])' : 'v.id = ANY($1::bigint[])'} AND ${clause.sql}`,
      [list, ...clause.params],
    );
    return res.rows;
  }

  /** The vehicles in a scope that are not retired, optionally of one depot (internal id), by plate. */
  async liveMap(db: Queryable, scope: Scope, depotId: string | null): Promise<LiveMapVehicle[]> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<LiveMapVehicle>(
      `SELECT v.id, v.public_id AS "publicId", v.registration_number AS "registrationNumber", v.vehicle_type::text AS "vehicleType",
              v.status::text AS status, v.maintenance_flag AS "maintenanceFlag", d.public_id AS "depotPublicId"
         FROM fleet.vehicles v
         LEFT JOIN fleet.depots d ON d.id = v.depot_id
        WHERE v.status <> 'retired' AND ($1::bigint IS NULL OR v.depot_id = $1) AND ${clause.sql}
        ORDER BY v.registration_number, v.id`,
      [depotId, ...clause.params],
    );
    return res.rows;
  }

  /** A vehicle (any, retired too) by public id with its plate and depot (internal id): the subject of an alert (FMS-92). */
  async alertSubject(db: Queryable, publicId: string): Promise<{ id: string; publicId: string; registrationNumber: string; depotId: string | null } | null> {
    const res = await db.query<{ id: string; publicId: string; registrationNumber: string; depotId: string | null }>(
      `SELECT id, public_id AS "publicId", registration_number AS "registrationNumber", depot_id AS "depotId" FROM fleet.vehicles WHERE public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  /** Public id and plate of vehicles by internal id, for maintenance responses. */
  async refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>> {
    if (ids.length === 0) return new Map();
    const res = await db.query<{ id: string; publicId: string; registrationNumber: string }>(
      `SELECT id, public_id AS "publicId", registration_number AS "registrationNumber" FROM fleet.vehicles WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    return new Map(res.rows.map((r) => [r.id, { publicId: r.publicId, registrationNumber: r.registrationNumber }]));
  }

  /** Internal ids of the vehicles in a scope, for other modules' lists; null means every vehicle. */
  async idsInScope(db: Queryable, scope: Scope): Promise<string[] | null> {
    if (scope.kind === 'all') return null;
    const clause = scopeClause(scope, 'v.depot_id', 1);
    const res = await db.query<{ id: string }>(`SELECT v.id FROM fleet.vehicles v WHERE ${clause.sql}`, clause.params);
    return res.rows.map((r) => r.id);
  }

  /** Sets or clears the maintenance flag: one audited change, in the caller's transaction. */
  setMaintenanceFlag(ctx: MutationContext, id: string, flag: boolean, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.vehicles', 'UPDATE', id, { maintenance_flag: flag }, client);
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

  /** A status change other than retirement (FMS-76): one audited UPDATE. */
  setStatus(ctx: MutationContext, id: string, status: VehicleStatus, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.vehicles', 'UPDATE', id, { status }, client);
  }

  /** Records why and by whom a status changed (fleet.vehicle_status_history); audited like every write. */
  recordStatusChange(
    ctx: MutationContext,
    change: {
      vehicleId: string;
      from: VehicleStatus;
      to: VehicleStatus;
      reason: string | null;
      changedBy: string | null;
      source: StatusChangeSource;
      maintenanceRecordId: string | null;
    },
    client: PoolClient,
  ): Promise<Row> {
    return this.mutate(
      ctx,
      'fleet.vehicle_status_history',
      'INSERT',
      null,
      {
        vehicle_id: change.vehicleId,
        from_status: change.from,
        to_status: change.to,
        reason: change.reason,
        changed_by: change.changedBy,
        source: change.source,
        maintenance_record_id: change.maintenanceRecordId,
        correlation_id: ctx.correlationId,
      },
      client,
    );
  }

  /** The latest status change of a vehicle, if any; `changedBy` is the internal user id. */
  async lastStatusChange(db: Queryable, vehicleId: string): Promise<StatusChangeRow | null> {
    const res = await db.query<StatusChangeRow>(
      `SELECT from_status AS "fromStatus", to_status AS "toStatus", reason, source, maintenance_record_id AS "maintenanceRecordId",
              changed_by AS "changedBy", changed_at AS "changedAt"
         FROM fleet.vehicle_status_history WHERE vehicle_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1`,
      [vehicleId],
    );
    return res.rows[0] ?? null;
  }
}
