import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { Meter, MeterReadingView, MeterSource, NewReading } from '../domain/meter';

export interface MeterListFilter extends Page {
  meter?: Meter;
  /** Readings recorded at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
}

const VIEW_SQL = `
  SELECT m.public_id AS id, m.meter, m.value::float8 AS value, m.source, m.source_ref, m.recorded_at, m.suspect, m.created_at
    FROM fleet.meter_readings m`;

/**
 * fleet.meter_readings (FMS-126): odometer and engine-hour readings over time.
 * Append-only: a reading is never edited, and each insert is one audit row.
 */
export class MeterRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async insert(client: PoolClient, ctx: MutationContext, reading: NewReading, suspect: boolean): Promise<void> {
    await this.mutate(
      ctx,
      'fleet.meter_readings',
      'INSERT',
      null,
      {
        vehicle_id: reading.vehicleId,
        meter: reading.meter,
        value: reading.value,
        source: reading.source,
        source_ref: reading.sourceRef,
        recorded_at: reading.recordedAt,
        suspect,
      },
      client,
    );
  }

  /** Whether this source record already has its reading (a redelivered event, a re-run job). */
  async exists(db: Queryable, vehicleId: string, meter: Meter, source: MeterSource, sourceRef: string): Promise<boolean> {
    const res = await db.query(
      'SELECT 1 FROM fleet.meter_readings WHERE vehicle_id = $1 AND meter = $2 AND source = $3 AND source_ref = $4',
      [vehicleId, meter, source, sourceRef],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** The highest trusted reading of a vehicle's meter recorded at or before `at`, or null. */
  async highestTrusted(db: Queryable, vehicleId: string, meter: Meter, at: Date): Promise<number | null> {
    const res = await db.query<{ value: number | null }>(
      'SELECT max(value)::float8 AS value FROM fleet.meter_readings WHERE vehicle_id = $1 AND meter = $2 AND NOT suspect AND recorded_at <= $3',
      [vehicleId, meter, at],
    );
    return res.rows[0].value;
  }

  /** When a vehicle's newest reading from this source of this meter was true, or null. */
  async latestAt(db: Queryable, vehicleId: string, meter: Meter, source: MeterSource): Promise<Date | null> {
    const res = await db.query<{ at: Date | null }>(
      'SELECT max(recorded_at) AS at FROM fleet.meter_readings WHERE vehicle_id = $1 AND meter = $2 AND source = $3',
      [vehicleId, meter, source],
    );
    return res.rows[0].at;
  }

  /** Each vehicle's highest engine-hours reading recorded before `before` (internal ids; vehicles with none are left out). */
  async engineHoursBefore(db: Queryable, vehicleIds: readonly string[], before: Date): Promise<Map<string, number>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ vehicleId: string; value: number }>(
      `SELECT vehicle_id AS "vehicleId", max(value)::float8 AS value FROM fleet.meter_readings
        WHERE vehicle_id = ANY($1::bigint[]) AND meter = 'engine_hours' AND recorded_at < $2
        GROUP BY vehicle_id`,
      [vehicleIds, before],
    );
    return new Map(res.rows.map((r) => [r.vehicleId, r.value]));
  }

  /** The vehicles that already have an engine-hours reading for this day (`YYYY-MM-DD`). */
  async engineHoursDone(db: Queryable, day: string): Promise<Set<string>> {
    const res = await db.query<{ vehicleId: string }>(
      `SELECT vehicle_id AS "vehicleId" FROM fleet.meter_readings WHERE meter = 'engine_hours' AND source = 'gps_derived' AND source_ref = $1`,
      [day],
    );
    return new Set(res.rows.map((r) => r.vehicleId));
  }

  /** The source refs that already have a reading, among these, for a source. */
  async existingRefs(db: Queryable, source: MeterSource, refs: readonly string[]): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const res = await db.query<{ ref: string }>('SELECT source_ref AS ref FROM fleet.meter_readings WHERE source = $1 AND source_ref = ANY($2::text[])', [
      source,
      refs,
    ]);
    return new Set(res.rows.map((r) => r.ref));
  }

  /** A vehicle's readings, newest first (when they were true). */
  async list(db: Queryable, vehicleId: string, f: MeterListFilter): Promise<{ items: MeterReadingView[]; total: number }> {
    const params: unknown[] = [vehicleId];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['m.vehicle_id = $1'];
    if (f.meter) where.push(`m.meter = ${add(f.meter)}`);
    if (f.from) where.push(`m.recorded_at >= ${add(f.from)}`);
    if (f.to) where.push(`m.recorded_at < ${add(f.to)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM fleet.meter_readings m ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<MeterReadingView>(
      `${VIEW_SQL} ${whereSql} ORDER BY m.recorded_at DESC, m.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { items: res.rows, total: count.rows[0].total };
  }
}
