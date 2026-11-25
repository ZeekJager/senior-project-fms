import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';

// Saved filters, report schedules and their runs, and background exports (FMS-160, docs/reports.md): analytics.*
// tables, on the primary.

export interface SavedFilterRow {
  id: string;
  publicId: string;
  userId: string;
  name: string;
  filters: Record<string, unknown>;
  createdAt: Date;
}

export interface ScheduleRow {
  id: string;
  publicId: string;
  ownerId: string;
  name: string;
  report: string;
  filters: Record<string, unknown>;
  format: 'csv' | 'xlsx' | 'pdf';
  frequency: 'daily' | 'weekly' | 'monthly';
  day: number | null;
  hour: number;
  recipients: string[];
  nextRunAt: Date;
  isActive: boolean;
  version: number;
  createdAt: Date;
}

export interface RecipientOutcome {
  user_id: string;
  outcome: 'sent' | 'skipped' | 'failed';
  reason: string | null;
  delivered: 'attached' | 'link' | null;
}

export interface RunRow {
  id: string;
  publicId: string;
  scheduleId: string;
  dueAt: Date;
  periodFrom: Date;
  periodTo: Date;
  status: 'running' | 'sent' | 'partial' | 'failed' | 'retrying';
  attempts: number;
  nextAttemptAt: Date | null;
  outcomes: RecipientOutcome[];
  rows: number | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ExportRow {
  id: string;
  publicId: string;
  userId: string;
  report: string;
  format: 'csv' | 'xlsx' | 'pdf';
  filters: Record<string, unknown>;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  storageKey: string | null;
  filename: string | null;
  rows: number | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
}

const FILTER_COLUMNS = `id::text, public_id::text AS "publicId", user_id::text AS "userId", name, filters, created_at AS "createdAt"`;
const SCHEDULE_COLUMNS = `id::text, public_id::text AS "publicId", owner_id::text AS "ownerId", name, report, filters, format, frequency, day, hour,
  ARRAY(SELECT x::text FROM unnest(recipients) x) AS recipients, next_run_at AS "nextRunAt", is_active AS "isActive", version, created_at AS "createdAt"`;
const RUN_COLUMNS = `id::text, public_id::text AS "publicId", schedule_id::text AS "scheduleId", due_at AS "dueAt", period_from AS "periodFrom",
  period_to AS "periodTo", status, attempts, next_attempt_at AS "nextAttemptAt", outcomes, rows, size_bytes AS "sizeBytes", error,
  started_at AS "startedAt", finished_at AS "finishedAt"`;
const EXPORT_COLUMNS = `id::text, public_id::text AS "publicId", user_id::text AS "userId", report, format, filters, status, storage_key AS "storageKey",
  filename, rows, size_bytes AS "sizeBytes", error, created_at AS "createdAt", finished_at AS "finishedAt", expires_at AS "expiresAt"`;

export class ReportStoreRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  pool(): Pool {
    return this.db;
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  // Saved filters -------------------------------------------------------------------------------------------------

  async filters(db: Queryable, userId: string): Promise<SavedFilterRow[]> {
    const res = await db.query<SavedFilterRow>(`SELECT ${FILTER_COLUMNS} FROM analytics.report_filters WHERE user_id = $1 AND is_active ORDER BY lower(name)`, [userId]);
    return res.rows;
  }

  async filter(db: Queryable, publicId: string): Promise<SavedFilterRow | null> {
    const res = await db.query<SavedFilterRow>(`SELECT ${FILTER_COLUMNS} FROM analytics.report_filters WHERE public_id = $1 AND is_active`, [publicId]);
    return res.rows[0] ?? null;
  }

  insertFilter(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_filters', 'INSERT', null, data, client);
  }

  deleteFilter(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_filters', 'DELETE', id, {}, client);
  }

  // Schedules -----------------------------------------------------------------------------------------------------

  async schedules(db: Queryable, ownerId: string | null): Promise<ScheduleRow[]> {
    const res = await db.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM analytics.report_schedules WHERE is_active AND ($1::bigint IS NULL OR owner_id = $1) ORDER BY lower(name), id`,
      [ownerId],
    );
    return res.rows;
  }

  async schedule(db: Queryable, publicId: string, lock = false): Promise<ScheduleRow | null> {
    const res = await db.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM analytics.report_schedules WHERE public_id = $1 AND is_active${lock ? ' FOR UPDATE' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  async scheduleById(db: Queryable, id: string): Promise<ScheduleRow | null> {
    const res = await db.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM analytics.report_schedules WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  insertSchedule(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_schedules', 'INSERT', null, data, client);
  }

  updateSchedule(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_schedules', 'UPDATE', id, data, client);
  }

  deleteSchedule(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_schedules', 'DELETE', id, {}, client);
  }

  /** Schedules due by `now`, locked for this runner (another instance skips them). */
  async dueSchedules(client: PoolClient, now: Date, limit: number): Promise<ScheduleRow[]> {
    const res = await client.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM analytics.report_schedules WHERE is_active AND next_run_at <= $1 ORDER BY next_run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return res.rows;
  }

  // Runs ----------------------------------------------------------------------------------------------------------

  async insertRun(client: PoolClient, ctx: MutationContext, data: Row): Promise<RunRow | null> {
    const exists = await client.query('SELECT 1 FROM analytics.report_schedule_runs WHERE schedule_id = $1 AND due_at = $2', [data.schedule_id, data.due_at]);
    if (exists.rowCount) return null;
    const row = await this.mutate(ctx, 'analytics.report_schedule_runs', 'INSERT', null, data, client);
    return this.run(client, String(row.id));
  }

  updateRun(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_schedule_runs', 'UPDATE', id, data, client);
  }

  async run(db: Queryable, id: string): Promise<RunRow | null> {
    const res = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM analytics.report_schedule_runs WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async runs(db: Queryable, scheduleId: string, limit: number): Promise<RunRow[]> {
    const res = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM analytics.report_schedule_runs WHERE schedule_id = $1 ORDER BY due_at DESC, id DESC LIMIT $2`, [scheduleId, limit]);
    return res.rows;
  }

  /** Runs to retry now (some recipients failed), locked for this runner. */
  async dueRetries(client: PoolClient, now: Date, limit: number): Promise<RunRow[]> {
    const res = await client.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM analytics.report_schedule_runs WHERE status = 'retrying' AND next_attempt_at <= $1 ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return res.rows;
  }

  // Exports -------------------------------------------------------------------------------------------------------

  insertExport(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_exports', 'INSERT', null, data, client);
  }

  updateExport(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.report_exports', 'UPDATE', id, data, client);
  }

  async export(db: Queryable, publicId: string): Promise<ExportRow | null> {
    const res = await db.query<ExportRow>(`SELECT ${EXPORT_COLUMNS} FROM analytics.report_exports WHERE public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async exportById(db: Queryable, id: string): Promise<ExportRow | null> {
    const res = await db.query<ExportRow>(`SELECT ${EXPORT_COLUMNS} FROM analytics.report_exports WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /** The oldest queued export, locked for this runner; or none. */
  async nextExport(client: PoolClient): Promise<ExportRow | null> {
    const res = await client.query<ExportRow>(`SELECT ${EXPORT_COLUMNS} FROM analytics.report_exports WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    return res.rows[0] ?? null;
  }

  /** Ready exports past their 24 hours, for the files to be removed. */
  async expiredExports(db: Queryable, now: Date, limit: number): Promise<ExportRow[]> {
    const res = await db.query<ExportRow>(`SELECT ${EXPORT_COLUMNS} FROM analytics.report_exports WHERE status = 'ready' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [now, limit]);
    return res.rows;
  }
}
