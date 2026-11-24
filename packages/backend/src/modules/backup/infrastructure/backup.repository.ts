import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { BackupKind, BackupStatus } from '../domain/backup';
import type { BaseBackupView, PitrDrillState, PitrState, RepositoryState } from '../domain/pitr';

/** A backup.base_backups row (FMS-108). */
export interface BaseBackupRow {
  publicId: string;
  label: string | null;
  type: BaseBackupView['type'];
  triggeredBy: BaseBackupView['triggered_by'];
  repoKey: number;
  status: BaseBackupView['status'];
  startedAt: Date;
  finishedAt: Date | null;
  sizeBytes: number | null;
  repoSizeBytes: number | null;
  error: string | null;
}

/** A backup.backups row (internal ids; size as a number: a dump is far below 2^53 bytes). */
export interface BackupRow {
  id: string;
  publicId: string;
  kind: BackupKind;
  status: BackupStatus;
  databaseName: string;
  requestedBy: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  storageKey: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  error: string | null;
  expiresAt: Date | null;
  correlationId: string;
}

export interface RestoreDrillRow {
  publicId: string;
  backupPublicId: string;
  targetDatabase: string;
  status: 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt: Date;
  tablesRestored: number | null;
  error: string | null;
  runBy: string;
}

const ROW_SQL = `
  SELECT id, public_id AS "publicId", kind, status, database_name AS "databaseName", requested_by AS "requestedBy",
         requested_at AS "requestedAt", started_at AS "startedAt", finished_at AS "finishedAt", storage_key AS "storageKey",
         size_bytes::text AS "sizeBytes", checksum_sha256 AS checksum, error, expires_at AS "expiresAt",
         correlation_id AS "correlationId"
    FROM backup.backups`;

type RawRow = Omit<BackupRow, 'sizeBytes'> & { sizeBytes: string | null };

const toRow = (r: RawRow): BackupRow => ({
  ...r,
  sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
});

/** backup.backups and backup.restore_drills (FMS-144). Audit entries are the service's, in the same transaction. */
export class BackupRepository {
  constructor(private readonly pool: Pool) {}

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  async list(db: Queryable, page: number, pageSize: number): Promise<{ rows: BackupRow[]; total: number }> {
    const res = await db.query<RawRow>(`${ROW_SQL} ORDER BY requested_at DESC, id DESC LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]);
    const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM backup.backups`);
    return { rows: res.rows.map(toRow), total: Number(count.rows[0].n) };
  }

  async find(db: Queryable, publicId: string): Promise<BackupRow | null> {
    const res = await db.query<RawRow>(`${ROW_SQL} WHERE public_id = $1`, [publicId]);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  /** The queued or running backup, if any: one at a time. Locks the table's queue for the caller's transaction. */
  async pending(db: Queryable): Promise<BackupRow | null> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('backup.backups:queue'))`);
    const res = await db.query<RawRow>(`${ROW_SQL} WHERE status IN ('queued', 'running') ORDER BY requested_at LIMIT 1`);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  async insert(db: Queryable, row: { kind: BackupKind; databaseName: string; requestedBy: string | null; correlationId: string }): Promise<BackupRow> {
    const res = await db.query(
      `INSERT INTO backup.backups (kind, database_name, requested_by, correlation_id) VALUES ($1, $2, $3, $4)
       RETURNING public_id AS "publicId"`,
      [row.kind, row.databaseName, row.requestedBy, row.correlationId],
    );
    return (await this.find(db, res.rows[0].publicId))!;
  }

  /**
   * Takes the oldest queued backup and marks it running, so no other instance takes it: SKIP LOCKED, and the
   * status change commits before the dump starts.
   */
  async claimNext(now: Date): Promise<BackupRow | null> {
    return this.inTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT id FROM backup.backups WHERE status = 'queued' ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!res.rows[0]) return null;
      await client.query(`UPDATE backup.backups SET status = 'running', started_at = $2 WHERE id = $1`, [res.rows[0].id, now]);
      const row = await client.query<RawRow>(`${ROW_SQL} WHERE id = $1`, [res.rows[0].id]);
      return toRow(row.rows[0]);
    });
  }

  async markSucceeded(db: Queryable, id: string, file: { storageKey: string; sizeBytes: number; checksum: string }, finishedAt: Date, expiresAt: Date): Promise<void> {
    await db.query(
      `UPDATE backup.backups
          SET status = 'succeeded', storage_key = $2, size_bytes = $3, checksum_sha256 = $4, finished_at = $5, expires_at = $6, error = NULL
        WHERE id = $1`,
      [id, file.storageKey, file.sizeBytes, file.checksum, finishedAt, expiresAt],
    );
  }

  async markFailed(db: Queryable, id: string, error: string, finishedAt: Date): Promise<void> {
    await db.query(`UPDATE backup.backups SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1`, [id, error, finishedAt]);
  }

  /** Runs still marked running since before `startedBefore`: their instance died mid-dump. */
  async stale(db: Queryable, startedBefore: Date): Promise<BackupRow[]> {
    const res = await db.query<RawRow>(`${ROW_SQL} WHERE status = 'running' AND started_at < $1 FOR UPDATE SKIP LOCKED`, [startedBefore]);
    return res.rows.map(toRow);
  }

  /** Succeeded backups past retention, oldest first, locked so two instances do not expire the same one. */
  async pastRetention(db: Queryable, now: Date, limit: number): Promise<BackupRow[]> {
    const res = await db.query<RawRow>(`${ROW_SQL} WHERE status = 'succeeded' AND expires_at <= $1 ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
    return res.rows.map(toRow);
  }

  async markExpired(db: Queryable, id: string): Promise<void> {
    await db.query(`UPDATE backup.backups SET status = 'expired' WHERE id = $1`, [id]);
  }

  async lastSucceededAt(db: Queryable): Promise<Date | null> {
    const res = await db.query<{ at: Date | null }>(`SELECT max(finished_at) AS at FROM backup.backups WHERE status IN ('succeeded', 'expired')`);
    return res.rows[0].at;
  }

  /** The last drill of a dump file (FMS-144); point-in-time drills are pitrState's. */
  async lastDrill(db: Queryable): Promise<RestoreDrillRow | null> {
    const res = await db.query<RestoreDrillRow>(
      `SELECT d.public_id AS "publicId", b.public_id AS "backupPublicId", d.target_database AS "targetDatabase", d.status,
              d.started_at AS "startedAt", d.finished_at AS "finishedAt", d.tables_restored AS "tablesRestored", d.error, d.run_by AS "runBy"
         FROM backup.restore_drills d JOIN backup.backups b ON b.id = d.backup_id
        WHERE d.method = 'dump'
        ORDER BY d.finished_at DESC, d.id DESC LIMIT 1`,
    );
    return res.rows[0] ?? null;
  }

  /**
   * Point-in-time recovery as the database container recorded it (FMS-108): the archiver, each repository, the
   * base backups and the last drill. pg_stat_archiver is readable by any role; the tables are granted to fms_app.
   */
  async pitrState(db: Queryable): Promise<PitrState> {
    const archiver = await db.query<{
      enabled: boolean;
      lastArchivedWal: string | null;
      lastArchivedAt: Date | null;
      lastFailedWal: string | null;
      lastFailedAt: Date | null;
    }>(
      `SELECT current_setting('archive_mode') IN ('on', 'always') AS enabled,
              last_archived_wal AS "lastArchivedWal", last_archived_time AS "lastArchivedAt",
              last_failed_wal AS "lastFailedWal", last_failed_time AS "lastFailedAt"
         FROM pg_stat_archiver`,
    );
    const repos = await db.query<RepositoryState>(
      `SELECT repo_key AS "repoKey", cipher, status_code AS "statusCode", status_message AS "statusMessage", status_since AS "statusSince",
              archive_min AS "archiveMin", archive_max AS "archiveMax", archive_max_seen_at AS "archiveMaxSeenAt", backups,
              oldest_backup_at AS "oldestBackupAt", newest_backup_at AS "newestBackupAt", checked_at AS "checkedAt"
         FROM backup.pitr_repositories ORDER BY repo_key`,
    );
    const base = await db.query<{ last: Date | null; first: Date | null }>(
      `SELECT max(finished_at) FILTER (WHERE status IN ('succeeded', 'expired')) AS last, min(started_at) AS first FROM backup.base_backups`,
    );
    const drill = await db.query<PitrDrillState>(
      `SELECT public_id AS "publicId", base_backup_label AS "baseBackupLabel", recovery_target AS "recoveryTarget", status,
              started_at AS "startedAt", finished_at AS "finishedAt", tables_restored AS "tablesRestored", rto_seconds AS "rtoSeconds",
              checks, error, run_by AS "runBy"
         FROM backup.restore_drills WHERE method = 'pitr' ORDER BY finished_at DESC, id DESC LIMIT 1`,
    );
    const passed = await db.query<{ at: Date | null }>(
      `SELECT max(finished_at) AS at FROM backup.restore_drills WHERE method = 'pitr' AND status = 'succeeded'`,
    );
    return {
      archiver: archiver.rows[0],
      repositories: repos.rows,
      lastBaseBackupAt: base.rows[0].last,
      firstBaseBackupStartedAt: base.rows[0].first,
      lastDrill: drill.rows[0] ?? null,
      lastPassedDrillAt: passed.rows[0].at,
    };
  }

  /** backup.base_backups, newest first (the database container writes them; FMS-108). */
  async listBaseBackups(db: Queryable, page: number, pageSize: number): Promise<{ rows: BaseBackupRow[]; total: number }> {
    const res = await db.query<Omit<BaseBackupRow, 'sizeBytes' | 'repoSizeBytes'> & { sizeBytes: string | null; repoSizeBytes: string | null }>(
      `SELECT public_id AS "publicId", label, backup_type AS type, triggered_by AS "triggeredBy", repo_key AS "repoKey", status, started_at AS "startedAt",
              finished_at AS "finishedAt", size_bytes::text AS "sizeBytes", repo_size_bytes::text AS "repoSizeBytes", error
         FROM backup.base_backups ORDER BY started_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );
    const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM backup.base_backups`);
    return {
      rows: res.rows.map((r) => ({
        ...r,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        repoSizeBytes: r.repoSizeBytes === null ? null : Number(r.repoSizeBytes),
      })),
      total: Number(count.rows[0].n),
    };
  }

  async recordDrill(
    db: Queryable,
    drill: { backupId: string; targetDatabase: string; status: 'succeeded' | 'failed'; startedAt: Date; finishedAt: Date; tablesRestored: number | null; error: string | null; runBy: string },
  ): Promise<void> {
    await db.query(
      `INSERT INTO backup.restore_drills (backup_id, target_database, status, started_at, finished_at, tables_restored, error, run_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [drill.backupId, drill.targetDatabase, drill.status, drill.startedAt, drill.finishedAt, drill.tablesRestored, drill.error, drill.runBy],
    );
  }
}
