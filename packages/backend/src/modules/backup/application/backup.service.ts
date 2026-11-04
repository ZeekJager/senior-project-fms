import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestUser } from '../../../types/express';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import { AppError } from '../../../shared/errors/app-error';
import {
  BACKUP_RETENTION_DAYS,
  STALE_RUN_MINUTES,
  backupFilename,
  backupInProgress,
  backupKey,
  backupNotDownloadable,
  backupNotFound,
  backupsUnavailable,
  dumpError,
  linkExpired,
  linkInvalid,
  type BackupKind,
  type BackupOverview,
  type BackupView,
} from '../domain/backup';
import type { BackupLinkSigner } from '../domain/backup-link';
import type { BackupRepository, BackupRow } from '../infrastructure/backup.repository';
import type { DbTarget, PgTools } from '../infrastructure/pg-tools';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

export interface BackupServiceDeps {
  db: Queryable;
  backups: BackupRepository;
  storage: DocumentStorage;
  tools: PgTools;
  links: BackupLinkSigner;
  /** The database to back up, with credentials that may read all of it; null when none are configured. */
  target: DbTarget | null;
  users: {
    findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]>;
    findByPublicId(db: Queryable, publicId: string): Promise<{ id: string; status: string } | null>;
  };
  log: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** Start a requested backup at once, in the background (the server); tests run the queue themselves. */
  autoStart: boolean;
  now?: () => Date;
}

const DUMP_TYPE = 'application/octet-stream';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Most files removed by one retention run. */
const EXPIRE_BATCH = 100;

/**
 * Database backups (api-contract §5.3, FMS-144): pg_dump of the whole database in its custom format, compressed,
 * into the backup storage, one at a time; a record of each with its size, SHA-256, who started it and how it ended.
 * Restore is a documented command (docs/backups.md), never a button: it replaces the live data.
 */
export class BackupService {
  private draining: Promise<void> | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async overview(): Promise<BackupOverview> {
    const { db, backups, target } = this.deps;
    const drill = await backups.lastDrill(db);
    return {
      available: target !== null,
      retention_days: BACKUP_RETENTION_DAYS,
      last_succeeded_at: await backups.lastSucceededAt(db),
      last_restore_drill: drill && {
        id: drill.publicId,
        backup_id: drill.backupPublicId,
        target_database: drill.targetDatabase,
        status: drill.status,
        started_at: drill.startedAt,
        finished_at: drill.finishedAt,
        tables_restored: drill.tablesRestored,
        error: drill.error,
        run_by: drill.runBy,
      },
    };
  }

  async list(page: number, pageSize: number): Promise<{ items: BackupView[]; total: number }> {
    const { rows, total } = await this.deps.backups.list(this.deps.db, page, pageSize);
    return { items: await this.views(rows), total };
  }

  async get(publicId: string): Promise<BackupView> {
    const row = await this.deps.backups.find(this.deps.db, publicId);
    if (!row) throw backupNotFound();
    return (await this.views([row]))[0];
  }

  /** POST /system/backups (Back up now): queues a manual backup, 409 while another is under way. */
  async request(caller: Caller): Promise<BackupView> {
    const row = await this.enqueue('manual', caller.user.id, caller.correlationId);
    if (this.deps.autoStart) void this.drain().catch((err: unknown) => this.deps.log.error({ err }, 'backup runner failed'));
    return (await this.views([row]))[0];
  }

  /** The nightly job: a scheduled backup, unless one is already under way, taken now. */
  async scheduled(correlationId: string): Promise<Record<string, unknown>> {
    if (!this.deps.target) return { skipped: 1 };
    try {
      await this.enqueue('scheduled', null, correlationId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT_DUPLICATE') return { already_running: 1 };
      throw err;
    }
    await this.drain();
    return { started: 1 };
  }

  private async enqueue(kind: BackupKind, userId: string | null, correlationId: string): Promise<BackupRow> {
    const { backups, target } = this.deps;
    if (!target) throw backupsUnavailable();
    return backups.inTransaction(async (client) => {
      if (await backups.pending(client)) throw backupInProgress();
      const row = await backups.insert(client, { kind, databaseName: target.database, requestedBy: userId, correlationId });
      await recordAuditEntry(client, {
        action: 'backup.requested',
        userId,
        entityType: 'backup.backups',
        entityId: row.id,
        correlationId,
        newValues: { kind, database_name: target.database },
      });
      return row;
    });
  }

  /**
   * Takes every queued backup, one after another. One drain at a time per instance; SKIP LOCKED keeps two instances
   * off the same backup. Called after a request, and every minute by the runner job (a request whose instance died).
   */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = (async () => {
        try {
          for (let row = await this.deps.backups.claimNext(this.now()); row; row = await this.deps.backups.claimNext(this.now())) await this.take(row);
        } finally {
          this.draining = null;
        }
      })();
    }
    return this.draining;
  }

  /** The runner job: fails runs left running by a dead instance, then takes what is queued. */
  async runQueue(): Promise<Record<string, unknown>> {
    const interrupted = await this.failStale();
    await this.drain();
    return { interrupted };
  }

  private async take(row: BackupRow): Promise<void> {
    const { backups, storage, tools, log } = this.deps;
    const target = this.deps.target!;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fms-backup-'));
    const file = path.join(dir, 'backup.dump');
    const key = backupKey(row.publicId, row.requestedAt);
    let stored = false;
    try {
      await tools.dump(target, file);
      const { size } = await stat(file);
      const hash = createHash('sha256');
      await pipeline(createReadStream(file), hash);
      const checksum = hash.digest('hex');
      await storage.putFile(key, file, DUMP_TYPE);
      stored = true;
      const finishedAt = this.now();
      await backups.inTransaction(async (client) => {
        await backups.markSucceeded(client, row.id, { storageKey: key, sizeBytes: size, checksum }, finishedAt, new Date(finishedAt.getTime() + BACKUP_RETENTION_DAYS * DAY_MS));
        await recordAuditEntry(client, {
          action: 'backup.succeeded',
          userId: row.requestedBy,
          entityType: 'backup.backups',
          entityId: row.id,
          correlationId: row.correlationId,
          details: { kind: row.kind, size_bytes: size, checksum_sha256: checksum },
        });
      });
      log.info({ backup: row.publicId, kind: row.kind, sizeBytes: size }, 'database backup succeeded');
    } catch (err) {
      if (stored) await storage.remove(key).catch(() => undefined);
      const error = dumpError(err instanceof Error ? err.message : String(err), 'The backup failed.');
      await backups.inTransaction(async (client) => {
        await backups.markFailed(client, row.id, error, this.now());
        await recordAuditEntry(client, {
          action: 'backup.failed',
          userId: row.requestedBy,
          entityType: 'backup.backups',
          entityId: row.id,
          correlationId: row.correlationId,
          result: 'failed',
          details: { kind: row.kind, error },
        });
      });
      log.error({ backup: row.publicId, kind: row.kind, error }, 'database backup failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async failStale(): Promise<number> {
    const { backups } = this.deps;
    const before = new Date(this.now().getTime() - STALE_RUN_MINUTES * 60_000);
    return backups.inTransaction(async (client) => {
      const stale = await backups.stale(client, before);
      for (const row of stale) {
        await backups.markFailed(client, row.id, `The backup was interrupted: still running after ${STALE_RUN_MINUTES} minutes (its server stopped).`, this.now());
      }
      return stale.length;
    });
  }

  /** The retention job: removes the files of backups past BACKUP_RETENTION_DAYS; their rows stay, as expired. */
  async expire(correlationId: string): Promise<Record<string, unknown>> {
    const { backups, storage } = this.deps;
    return backups.inTransaction(async (client) => {
      const old = await backups.pastRetention(client, this.now(), EXPIRE_BATCH);
      for (const row of old) {
        await storage.remove(row.storageKey!);
        await backups.markExpired(client, row.id);
        await recordAuditEntry(client, {
          action: 'backup.expired',
          userId: null,
          entityType: 'backup.backups',
          entityId: row.id,
          correlationId,
          details: { retention_days: BACKUP_RETENTION_DAYS },
        });
      }
      return { expired: old.length };
    });
  }

  /** POST /system/backups/{id}/download-link: a link for the caller, alive five minutes. */
  async link(caller: Caller, publicId: string): Promise<{ url: string; expires_at: Date; filename: string }> {
    const row = await this.deps.backups.find(this.deps.db, publicId);
    if (!row) throw backupNotFound();
    if (row.status !== 'succeeded') throw backupNotDownloadable(row.status);
    const { url, expiresAt } = this.deps.links.sign(row.publicId, caller.user.publicId!);
    return { url, expires_at: expiresAt, filename: backupFilename(row.databaseName, row.startedAt ?? row.requestedAt) };
  }

  /** The signed link's bytes, audited as a download by the admin it was made for. */
  async content(
    publicId: string,
    link: { user?: string; expires?: string; signature?: string },
    correlationId: string,
  ): Promise<{ stream: Readable; sizeBytes: number; filename: string }> {
    const { db, backups, storage, links, users } = this.deps;
    const verdict = links.verify(publicId, link.user, link.expires, link.signature);
    if (verdict === 'expired') throw linkExpired();
    if (verdict !== 'ok') throw linkInvalid();
    const user = await users.findByPublicId(db, link.user!);
    if (!user || user.status !== 'active') throw linkInvalid();
    const row = await backups.find(db, publicId);
    if (!row) throw backupNotFound();
    if (row.status !== 'succeeded') throw backupNotDownloadable(row.status);
    const stream = await storage.get(row.storageKey!);
    await recordAuditEntry(db, {
      action: 'backup.downloaded',
      userId: user.id,
      entityType: 'backup.backups',
      entityId: row.id,
      correlationId,
      details: { size_bytes: row.sizeBytes, checksum_sha256: row.checksum },
    });
    return { stream, sizeBytes: row.sizeBytes!, filename: backupFilename(row.databaseName, row.startedAt ?? row.requestedAt) };
  }

  private async views(rows: BackupRow[]): Promise<BackupView[]> {
    const ids = [...new Set(rows.flatMap((r) => (r.requestedBy ? [r.requestedBy] : [])))];
    const people = new Map((await this.deps.users.findByIds(this.deps.db, ids)).map((u) => [u.id, u]));
    return rows.map((r) => {
      const who = r.requestedBy ? people.get(r.requestedBy) : undefined;
      return {
        id: r.publicId,
        kind: r.kind,
        status: r.status,
        database_name: r.databaseName,
        requested_by: who ? { id: who.publicId, name: who.fullName } : null,
        requested_at: r.requestedAt,
        started_at: r.startedAt,
        finished_at: r.finishedAt,
        size_bytes: r.sizeBytes,
        checksum_sha256: r.checksum,
        error: r.error,
        expires_at: r.expiresAt,
        downloadable: r.status === 'succeeded',
      };
    });
  }
}
