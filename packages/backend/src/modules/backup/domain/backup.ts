import { AppError } from '../../../shared/errors/app-error';

/** backup.backups.kind: the nightly job's, or an admin's Back up now (FMS-144). */
export const BACKUP_KINDS = ['scheduled', 'manual'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** Queued and running are under way; succeeded has a file; expired had one, removed past retention. */
export const BACKUP_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'expired'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/** A backup's file is kept this long, then removed (the row stays, as expired). */
export const BACKUP_RETENTION_DAYS = 30;

/** A download link works this long: enough to start a download, not to pass around. */
export const BACKUP_LINK_TTL_SECONDS = 5 * 60;

/** A run still marked running after this long died with its instance: it is failed, and the queue moves on. */
export const STALE_RUN_MINUTES = 120;

/** The most of pg_dump's own words kept as a failed backup's error. */
export const MAX_ERROR_LENGTH = 2000;

/** The file's name when downloaded: the database and the time it was taken, in UTC. */
export function backupFilename(databaseName: string, takenAt: Date): string {
  const stamp = takenAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `fms-${databaseName.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}Z.dump`;
}

/** Where a backup's file lives in the storage: nothing a client can steer (the storage's key rule). */
export function backupKey(publicId: string, at: Date): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `backups/${at.getUTCFullYear()}/${month}/${publicId.toLowerCase()}`;
}

/** A `password=…` pair in a connection string a tool echoes back. */
const SECRET_PAIR = /\b(password|pass)=\S+/gi;

/** pg_dump's message, trimmed to its last useful lines and stripped of anything that looks like a password. */
export function dumpError(stderr: string, fallback: string): string {
  const text = stderr
    .replace(SECRET_PAIR, '$1=***')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  const message = text || fallback;
  return message.length > MAX_ERROR_LENGTH ? `…${message.slice(-(MAX_ERROR_LENGTH - 1))}` : message;
}

/** A backup as the API returns it (api-contract §5.3). Public ids; sizes in bytes. */
export interface BackupView {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  database_name: string;
  requested_by: { id: string; name: string } | null;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  error: string | null;
  /** When the file is removed (succeeded), or was (expired). */
  expires_at: Date | null;
  /** Only a succeeded backup's file can be downloaded. */
  downloadable: boolean;
}

/** The last restore drill: proof a backup restores (FMS-108 runs them on a schedule). */
export interface RestoreDrillView {
  id: string;
  backup_id: string;
  target_database: string;
  status: 'succeeded' | 'failed';
  started_at: Date;
  finished_at: Date;
  tables_restored: number | null;
  error: string | null;
  run_by: string;
}

export interface BackupOverview {
  /** Whether this server can take a backup: pg_dump's credentials are configured. */
  available: boolean;
  retention_days: number;
  last_succeeded_at: Date | null;
  last_restore_drill: RestoreDrillView | null;
}

export const backupNotFound = () => new AppError(404, 'NOT_FOUND', 'Backup not found.');

export const backupNotDownloadable = (status: BackupStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', status === 'expired' ? 'This backup is past retention: its file was removed.' : `The backup is ${status}: there is no file to download.`, [
    { field: 'status', reason: status === 'expired' ? 'expired' : 'not_succeeded' },
  ]);

export const backupInProgress = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'A backup is already under way. Wait for it to finish.', [{ field: 'status', reason: 'backup_in_progress' }]);

export const backupsUnavailable = () =>
  new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Backups are not set up on this server: it has no database credentials for pg_dump.');

// As a document link's (FMS-17): an expired link is 401 AUTH_TOKEN_EXPIRED, anything else that is not ours 401 AUTH_TOKEN_INVALID.
export const linkExpired = () => new AppError(401, 'AUTH_TOKEN_EXPIRED', 'This download link has expired. Ask for a new one.');
export const linkInvalid = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'This download link is not valid.');
