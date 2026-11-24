// Point-in-time recovery (FMS-108, ADR-07, docs/backups.md#continuous-archiving-and-point-in-time-recovery):
// what the database container records of its archiving, repositories, base backups and drills, how far back
// and how recently the database can be restored, and when that is at risk. Pure: no clock, no database.

export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The thresholds of the backup alerts (FMS-161). Fixed here until settings parameters (FMS-157) hold them. */
export const PITR_THRESHOLDS = {
  /** WAL archiving failing this long: changes since then are only on the database's disk. */
  archivingFailingMs: 5 * MINUTE_MS,
  /**
   * A repository unreachable this long. Shorter than archiving's 5 minutes, so the network to the off-site copy
   * cut is a critical alert within 5 minutes (FMS-161 criterion 1): measured, 4 min after the cut.
   */
  repositoryUnreachableMs: 3 * MINUTE_MS,
  /** The off-site copy this far behind the last WAL segment archived. */
  offsiteBehindMs: 15 * MINUTE_MS,
  /** No base backup this long: a daily one was missed. */
  baseBackupMaxAgeMs: 26 * HOUR_MS,
  /** No restore drill passed this long: a monthly one was missed. */
  drillMaxAgeMs: 35 * DAY_MS,
  /** The container's status loop writes once a minute; older than this, it is not running. */
  statusMaxAgeMs: 10 * MINUTE_MS,
} as const;

/** pg_stat_archiver, and whether archiving is on at all. */
export interface ArchiverState {
  enabled: boolean;
  lastArchivedWal: string | null;
  lastArchivedAt: Date | null;
  lastFailedWal: string | null;
  lastFailedAt: Date | null;
}

/** A backup.pitr_repositories row: a repository as the container's status loop last saw it. */
export interface RepositoryState {
  repoKey: number;
  cipher: string | null;
  statusCode: number;
  statusMessage: string;
  /** When its status last changed. */
  statusSince: Date;
  archiveMin: string | null;
  archiveMax: string | null;
  /** When its newest segment arrived (to the status loop's minute). */
  archiveMaxSeenAt: Date | null;
  backups: number;
  oldestBackupAt: Date | null;
  newestBackupAt: Date | null;
  checkedAt: Date;
}

export interface PitrDrillState {
  publicId: string;
  baseBackupLabel: string;
  recoveryTarget: string | null;
  status: 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt: Date;
  tablesRestored: number | null;
  rtoSeconds: number | null;
  checks: { table: string; live_rows: number; restored_rows: number | null; match: boolean }[] | null;
  error: string | null;
  runBy: string;
}

export interface PitrState {
  archiver: ArchiverState;
  repositories: RepositoryState[];
  /** The newest succeeded base backup's end, from backup.base_backups. */
  lastBaseBackupAt: Date | null;
  /** The first base backup ever started: with none succeeded, how long the database has gone without one. */
  firstBaseBackupStartedAt: Date | null;
  lastDrill: PitrDrillState | null;
  /** The last drill that passed, for "more than 35 days old". */
  lastPassedDrillAt: Date | null;
}

/**
 * Whether pgBackRest could read a repository: its info status 0 (ok) or 2 (no valid backups, such as while the first
 * one is taken; base_backup_missing covers that). Any other (missing stanza, another cipher, 99 for a storage error
 * such as the network to it being down) is an error.
 */
export const isReachable = (statusCode: number) => statusCode === 0 || statusCode === 2;

/** Repository 1 is the one beside the database; any other is off site (docs/backups.md). */
export const isOffsite = (repoKey: number) => repoKey !== 1;

/** Whether a repository holds the last segment archived: WAL names of one timeline order as text. */
const holds = (repo: RepositoryState, wal: string | null) => wal === null || (repo.archiveMax !== null && repo.archiveMax >= wal);

/** How far back and how recently a repository can restore: its oldest base backup's end, its newest segment's arrival. */
export function recoverableRange(repo: RepositoryState, archiver: ArchiverState): { from: Date | null; to: Date | null } {
  if (repo.backups === 0 || !repo.oldestBackupAt) return { from: null, to: null };
  // Holding the last archived segment, it reaches as far as the archiver does; otherwise as far as its own newest.
  const to = holds(repo, archiver.lastArchivedWal) && archiver.lastArchivedAt ? archiver.lastArchivedAt : repo.archiveMaxSeenAt;
  return { from: repo.oldestBackupAt, to: to && to.getTime() >= repo.oldestBackupAt.getTime() ? to : repo.newestBackupAt };
}

/** Across every repository: the earliest point any can restore, and the latest. */
export function overallRange(state: PitrState): { from: Date | null; to: Date | null } {
  let from: Date | null = null;
  let to: Date | null = null;
  for (const repo of state.repositories) {
    const r = recoverableRange(repo, state.archiver);
    if (r.from && (!from || r.from < from)) from = r.from;
    if (r.to && (!to || r.to > to)) to = r.to;
  }
  return { from, to };
}

/** When the archiver last succeeded, if it has failed since: archiving has been failing from then on. */
export function archivingFailingSince(a: ArchiverState): Date | null {
  if (!a.enabled || !a.lastFailedAt) return null;
  if (a.lastArchivedAt && a.lastArchivedAt >= a.lastFailedAt) return null;
  return a.lastArchivedAt ?? a.lastFailedAt;
}

export const BACKUP_CONDITIONS = [
  'archiving_failing',
  'repository_unreachable',
  'offsite_behind',
  'status_stale',
  'base_backup_missing',
  'drill_failed',
  'drill_overdue',
] as const;
export type BackupCondition = (typeof BACKUP_CONDITIONS)[number];

/** Critical alerts go out by email, SMS and push; high ones by push (FMS-161, CHANNELS_BY_SEVERITY). */
export type FindingSeverity = 'critical' | 'high';

/** Something that puts recovery at risk. `since` is fixed while it goes on, so the alert it raises is raised once. */
export interface BackupFinding {
  condition: BackupCondition;
  severity: FindingSeverity;
  /** The repository it is about, if any. */
  repoKey: number | null;
  since: Date;
  /** One sentence, for System health and the alert. */
  message: string;
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / MINUTE_MS));
const ageText = (ms: number) => {
  const m = minutes(ms);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

/**
 * What puts recovery at risk now, most severe first (FMS-161): archiving failing over 5 min, a repository
 * unreachable over 3 min, the off-site copy over 15 min behind, the container's status not written for 10 min,
 * no base backup in 26 h, the last drill failed, or none passed in 35 days. Nothing while archiving is off
 * (a server set up without it, such as the test database).
 */
export function backupFindings(state: PitrState, now: Date): BackupFinding[] {
  const t = now.getTime();
  const out: BackupFinding[] = [];
  const { archiver } = state;
  if (!archiver.enabled) return out;

  const failingSince = archivingFailingSince(archiver);
  if (failingSince && t - failingSince.getTime() > PITR_THRESHOLDS.archivingFailingMs) {
    out.push({
      condition: 'archiving_failing',
      severity: 'critical',
      repoKey: null,
      since: failingSince,
      message: `WAL archiving has failed for ${ageText(t - failingSince.getTime())}: changes since then are only on the database server's disk.`,
    });
  }

  const newestCheck = state.repositories.reduce<number | null>((m, r) => (m === null || r.checkedAt.getTime() > m ? r.checkedAt.getTime() : m), null);
  if (newestCheck === null || t - newestCheck > PITR_THRESHOLDS.statusMaxAgeMs) {
    out.push({
      condition: 'status_stale',
      severity: 'high',
      repoKey: null,
      since: newestCheck === null ? floorToDay(now) : new Date(newestCheck),
      message:
        newestCheck === null
          ? 'The backup repositories have not reported their status: the database container’s status loop is not running.'
          : `The backup repositories have not reported their status for ${ageText(t - newestCheck)}.`,
    });
  }

  for (const repo of state.repositories) {
    const where = isOffsite(repo.repoKey) ? 'The off-site backup repository' : 'The backup repository';
    if (!isReachable(repo.statusCode) && t - repo.statusSince.getTime() > PITR_THRESHOLDS.repositoryUnreachableMs) {
      out.push({
        condition: 'repository_unreachable',
        severity: 'critical',
        repoKey: repo.repoKey,
        since: repo.statusSince,
        message: `${where} (repo ${repo.repoKey}) cannot be reached: ${repo.statusMessage}`,
      });
    }
    // Behind since its newest segment arrived (since it was first seen, when it never held one).
    const seen = repo.archiveMaxSeenAt ?? repo.statusSince;
    if (isOffsite(repo.repoKey) && !holds(repo, archiver.lastArchivedWal) && t - seen.getTime() > PITR_THRESHOLDS.offsiteBehindMs) {
      out.push({
        condition: 'offsite_behind',
        severity: 'critical',
        repoKey: repo.repoKey,
        since: seen,
        message: `The off-site copy (repo ${repo.repoKey}) is ${ageText(t - seen.getTime())} behind: a loss of the site would lose the changes since.`,
      });
    }
  }

  // With none succeeded, counted from the first one started (the first start's full backup).
  const lastBase = state.lastBaseBackupAt ?? state.firstBaseBackupStartedAt;
  if (lastBase && t - lastBase.getTime() > PITR_THRESHOLDS.baseBackupMaxAgeMs) {
    out.push({
      condition: 'base_backup_missing',
      severity: 'high',
      repoKey: null,
      since: lastBase,
      message: state.lastBaseBackupAt
        ? `No base backup has succeeded for ${ageText(t - lastBase.getTime())}: restores take longer, and the oldest point drops out of reach.`
        : 'No base backup has succeeded yet: the database cannot be restored to a point in time.',
    });
  }

  const drill = state.lastDrill;
  if (drill?.status === 'failed') {
    out.push({
      condition: 'drill_failed',
      severity: 'high',
      repoKey: null,
      since: drill.finishedAt,
      message: `The last restore drill failed: ${drill.error ?? 'it did not finish'}.`,
    });
  }
  const passed = state.lastPassedDrillAt;
  // Without a passed drill, it is overdue 35 days after the first base backup could have been drilled.
  const dueFrom = passed ?? oldestBackup(state);
  if (dueFrom && t - dueFrom.getTime() > PITR_THRESHOLDS.drillMaxAgeMs) {
    out.push({
      condition: 'drill_overdue',
      severity: 'high',
      repoKey: null,
      since: dueFrom,
      message: passed
        ? `No restore drill has passed for ${ageText(t - passed.getTime())}: the backups are not proven to restore.`
        : 'No restore drill has passed yet: the backups are not proven to restore.',
    });
  }

  const rank = (f: BackupFinding) => (f.severity === 'critical' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

function oldestBackup(state: PitrState): Date | null {
  return state.repositories.reduce<Date | null>((m, r) => (r.oldestBackupAt && (!m || r.oldestBackupAt < m) ? r.oldestBackupAt : m), null);
}

const floorToDay = (at: Date) => new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);

/** A base backup as the API returns it (api-contract §5.3). */
export interface BaseBackupView {
  id: string;
  label: string | null;
  type: 'full' | 'diff' | 'incr';
  triggered_by: 'schedule' | 'first-start' | 'manual';
  /** The repository it went to: pgBackRest backs up to one at a time. */
  repo: number;
  location: 'local' | 'offsite';
  status: 'running' | 'succeeded' | 'failed' | 'expired';
  started_at: Date;
  finished_at: Date | null;
  size_bytes: number | null;
  repo_size_bytes: number | null;
  error: string | null;
}

export interface RepositoryView {
  repo: number;
  location: 'local' | 'offsite';
  status: 'ok' | 'error';
  message: string | null;
  encrypted: boolean;
  base_backups: number;
  recoverable_from: Date | null;
  recoverable_to: Date | null;
  checked_at: Date;
}

export interface PitrDrillView {
  id: string;
  base_backup_label: string;
  recovery_target: string | null;
  status: 'succeeded' | 'failed';
  started_at: Date;
  finished_at: Date;
  tables_restored: number | null;
  rto_seconds: number | null;
  checks: PitrDrillState['checks'];
  error: string | null;
  run_by: string;
}

/** GET /system/backups meta.pitr: point-in-time recovery at a glance. */
export interface PitrOverview {
  /** Whether this database archives its WAL; false on a server set up without it. */
  enabled: boolean;
  recoverable_from: Date | null;
  recoverable_to: Date | null;
  archiving: { last_archived_at: Date | null; last_failed_at: Date | null; failing_since: Date | null };
  repositories: RepositoryView[];
  last_base_backup_at: Date | null;
  last_drill: PitrDrillView | null;
  findings: { condition: BackupCondition; severity: FindingSeverity; repo: number | null; since: Date; message: string }[];
}

export function pitrOverview(state: PitrState, now: Date): PitrOverview {
  const range = overallRange(state);
  const d = state.lastDrill;
  return {
    enabled: state.archiver.enabled,
    recoverable_from: range.from,
    recoverable_to: range.to,
    archiving: {
      last_archived_at: state.archiver.lastArchivedAt,
      last_failed_at: state.archiver.lastFailedAt,
      failing_since: archivingFailingSince(state.archiver),
    },
    repositories: state.repositories.map((r) => {
      const range = recoverableRange(r, state.archiver);
      return {
        repo: r.repoKey,
        location: isOffsite(r.repoKey) ? 'offsite' : 'local',
        status: isReachable(r.statusCode) ? 'ok' : 'error',
        message: r.statusCode === 0 ? null : r.statusMessage,
        encrypted: r.cipher !== null && r.cipher !== 'none',
        base_backups: r.backups,
        recoverable_from: range.from,
        recoverable_to: range.to,
        checked_at: r.checkedAt,
      };
    }),
    last_base_backup_at: state.lastBaseBackupAt,
    last_drill: d && {
      id: d.publicId,
      base_backup_label: d.baseBackupLabel,
      recovery_target: d.recoveryTarget,
      status: d.status,
      started_at: d.startedAt,
      finished_at: d.finishedAt,
      tables_restored: d.tablesRestored,
      rto_seconds: d.rtoSeconds,
      checks: d.checks,
      error: d.error,
      run_by: d.runBy,
    },
    findings: backupFindings(state, now).map((f) => ({ condition: f.condition, severity: f.severity, repo: f.repoKey, since: f.since, message: f.message })),
  };
}
