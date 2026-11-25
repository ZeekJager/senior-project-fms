import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';

// Maintenance windows (FMS-163, docs/observability.md): system.maintenance_windows, and the database's own query
// statistics for the Resources tab's slowest queries.

export interface WindowRow {
  id: string;
  publicId: string;
  hosts: string[];
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdBy: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  startRecordedAt: Date | null;
  endRecordedAt: Date | null;
  suppressedCount: number;
  createdAt: Date;
  version: number;
}

const COLUMNS = `id::text, public_id::text AS "publicId", hosts, starts_at AS "startsAt", ends_at AS "endsAt", reason,
  created_by::text AS "createdBy", cancelled_at AS "cancelledAt", cancelled_by::text AS "cancelledBy",
  start_recorded_at AS "startRecordedAt", end_recorded_at AS "endRecordedAt", suppressed_count AS "suppressedCount",
  created_at AS "createdAt", version`;

export class MaintenanceRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  pool(): Pool {
    return this.db;
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  insert(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'system.maintenance_windows', 'INSERT', null, data, client);
  }

  update(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'system.maintenance_windows', 'UPDATE', id, data, client);
  }

  async find(db: Queryable, publicId: string, lock = false): Promise<WindowRow | null> {
    const res = await db.query<WindowRow>(`SELECT ${COLUMNS} FROM system.maintenance_windows WHERE public_id = $1 AND is_active${lock ? ' FOR UPDATE' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<WindowRow | null> {
    const res = await db.query<WindowRow>(`SELECT ${COLUMNS} FROM system.maintenance_windows WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /** Windows that end after `since`, soonest first: the current and coming ones, and those just past. */
  async list(db: Queryable, since: Date, limit: number): Promise<WindowRow[]> {
    const res = await db.query<WindowRow>(`SELECT ${COLUMNS} FROM system.maintenance_windows WHERE is_active AND ends_at >= $1 ORDER BY starts_at, id LIMIT $2`, [since, limit]);
    return res.rows;
  }

  /** Windows in force at `now` (not cancelled). */
  async inForce(db: Queryable, now: Date): Promise<WindowRow[]> {
    const res = await db.query<WindowRow>(`SELECT ${COLUMNS} FROM system.maintenance_windows WHERE is_active AND cancelled_at IS NULL AND starts_at <= $1 AND ends_at > $1`, [now]);
    return res.rows;
  }

  /** Windows whose start or end has passed and is not yet written to the audit log. */
  async unrecorded(db: Queryable, now: Date): Promise<WindowRow[]> {
    const res = await db.query<WindowRow>(
      `SELECT ${COLUMNS} FROM system.maintenance_windows
        WHERE is_active AND ((start_recorded_at IS NULL AND starts_at <= $1 AND cancelled_at IS NULL) OR (end_recorded_at IS NULL AND start_recorded_at IS NOT NULL AND (ends_at <= $1 OR cancelled_at IS NOT NULL)))
        ORDER BY starts_at, id LIMIT 200`,
      [now],
    );
    return res.rows;
  }

  async countSuppressed(client: PoolClient, ids: readonly string[]): Promise<void> {
    if (ids.length) await client.query('UPDATE system.maintenance_windows SET suppressed_count = suppressed_count + 1 WHERE id = ANY($1::bigint[])', [ids]);
  }

  /** The 5 slowest statements by mean time, from pg_stat_statements (constants already replaced by $n), or none when it is off. */
  async slowestQueries(db: Queryable, limit = 5): Promise<{ query: string; calls: number; meanMs: number; totalMs: number }[]> {
    try {
      const res = await db.query<{ query: string; calls: string; meanMs: number; totalMs: number }>(
        `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query, calls::text, mean_exec_time AS "meanMs", total_exec_time AS "totalMs"
           FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND calls > 0
          ORDER BY mean_exec_time DESC
          LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => ({ query: r.query, calls: Number(r.calls), meanMs: Math.round(r.meanMs * 10) / 10, totalMs: Math.round(r.totalMs) }));
    } catch {
      return [];
    }
  }
}
