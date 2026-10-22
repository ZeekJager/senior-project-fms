import type { Pool, PoolClient } from 'pg';
import { limitOffset } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FuelSource, FuelType } from '../domain/fuel-log';

/**
 * Which fuel logs a caller sees (FMS-39). A driver sees only their own. Staff
 * see the logs of the vehicles in their depots: the vehicles live in the
 * fleet schema, so the service hands over their ids.
 */
export type FuelVisibility = { kind: 'all' } | { kind: 'vehicles'; vehicleIds: readonly string[] } | { kind: 'driver'; driverId: string } | { kind: 'none' };

/** A fuel.fuel_logs row (internal ids). Volume and the odometer are read as float8 (BIGINT and NUMERIC arrive as strings otherwise). */
export interface FuelLogRow {
  id: string;
  publicId: string;
  vehicleId: string;
  driverId: string | null;
  tripId: string | null;
  fuelType: FuelType;
  quantityMl: number;
  unitPriceCents: number | null;
  totalCostCents: number;
  odometerKm: number | null;
  stationName: string | null;
  source: FuelSource;
  recordedAt: Date;
  createdAt: Date;
}

export interface FuelLogWrite {
  vehicle_id: string;
  driver_id: string | null;
  trip_id: string | null;
  fuel_type: FuelType;
  quantity_ml: number;
  unit_price_cents: number | null;
  total_cost_cents: number;
  odometer_km: number;
  station_name: string | null;
  source: FuelSource;
  /** When the fill-up happened (FMS-115). */
  recorded_at: Date;
}

export interface FuelLogFilter {
  visibility: FuelVisibility;
  vehicleId?: string;
  driverId?: string;
  tripId?: string;
  /** Logs recorded at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
  order: 'asc' | 'desc';
  page: number;
  page_size: number;
}

const ROW_SQL = `
  SELECT f.id, f.public_id AS "publicId", f.vehicle_id AS "vehicleId", f.driver_id AS "driverId", f.trip_id AS "tripId",
         f.fuel_type AS "fuelType", f.quantity_ml::float8 AS "quantityMl", f.unit_price_cents AS "unitPriceCents",
         f.total_cost_cents AS "totalCostCents", f.odometer_km::float8 AS "odometerKm", f.station_name AS "stationName",
         f.source, f.recorded_at AS "recordedAt", f.created_at AS "createdAt"
    FROM fuel.fuel_logs f`;

function visibilitySql(v: FuelVisibility, add: (value: unknown) => string): string {
  switch (v.kind) {
    case 'all':
      return 'TRUE';
    case 'vehicles':
      return `f.vehicle_id = ANY(${add(v.vehicleIds)}::bigint[])`;
    case 'driver':
      return `f.driver_id = ${add(v.driverId)}`;
    default:
      return 'FALSE';
  }
}

/** fuel.fuel_logs (FMS-39): raw fuel observations. Derived findings live in fuel.fuel_anomalies. */
export class FuelLogRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async list(db: Queryable, f: FuelLogFilter): Promise<{ rows: FuelLogRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [visibilitySql(f.visibility, add)];
    if (f.vehicleId) where.push(`f.vehicle_id = ${add(f.vehicleId)}`);
    if (f.driverId) where.push(`f.driver_id = ${add(f.driverId)}`);
    if (f.tripId) where.push(`f.trip_id = ${add(f.tripId)}`);
    if (f.from) where.push(`f.recorded_at >= ${add(f.from)}`);
    if (f.to) where.push(`f.recorded_at < ${add(f.to)}`);
    const condition = where.join(' AND ');
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    const { limit, offset } = limitOffset(f);

    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fuel.fuel_logs f WHERE ${condition}`, params);
    const res = await db.query<FuelLogRow>(`${ROW_SQL} WHERE ${condition} ORDER BY f.recorded_at ${dir}, f.id ${dir} LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows, total: total.rows[0].n };
  }

  /** A log by public id if the caller may see it; a log outside the scope is simply not found. */
  async findVisible(db: Queryable, publicId: string, visibility: FuelVisibility): Promise<FuelLogRow | null> {
    const params: unknown[] = [publicId];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const res = await db.query<FuelLogRow>(`${ROW_SQL} WHERE f.public_id = $1 AND ${visibilitySql(visibility, add)}`, params);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<FuelLogRow> {
    const res = await db.query<FuelLogRow>(`${ROW_SQL} WHERE f.id = $1`, [id]);
    return res.rows[0];
  }

  /** The highest odometer reading of a vehicle's fuel logs recorded at or before `at`, or null if none. */
  async lastOdometer(db: Queryable, vehicleId: string, at: Date): Promise<number | null> {
    const res = await db.query<{ km: number | null }>('SELECT max(odometer_km)::float8 AS km FROM fuel.fuel_logs WHERE vehicle_id = $1 AND recorded_at <= $2', [
      vehicleId,
      at,
    ]);
    return res.rows[0].km;
  }

  /** The lowest odometer reading of a vehicle's fuel logs recorded after `at` (a back-dated log's later neighbours), or null. */
  async nextOdometer(db: Queryable, vehicleId: string, at: Date): Promise<number | null> {
    const res = await db.query<{ km: number | null }>('SELECT min(odometer_km)::float8 AS km FROM fuel.fuel_logs WHERE vehicle_id = $1 AND recorded_at > $2', [
      vehicleId,
      at,
    ]);
    return res.rows[0].km;
  }

  insert(ctx: MutationContext, data: FuelLogWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fuel.fuel_logs', 'INSERT', null, { ...data }, client);
  }
}
