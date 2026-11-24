import { describe, expect, it } from 'vitest';
import { backupFindings, overallRange, pitrOverview, recoverableRange, type PitrState, type RepositoryState } from './pitr';

const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const MIN = 1;
const HOUR = 60;
const DAY = 24 * HOUR;

function repo(over: Partial<RepositoryState> = {}): RepositoryState {
  return {
    repoKey: 1,
    cipher: 'aes-256-cbc',
    statusCode: 0,
    statusMessage: 'ok',
    statusSince: ago(10 * DAY),
    archiveMin: '000000010000002D000000E8',
    archiveMax: '000000010000002E0000003F',
    archiveMaxSeenAt: ago(1 * MIN),
    backups: 3,
    oldestBackupAt: ago(15 * DAY),
    newestBackupAt: ago(10 * HOUR),
    checkedAt: ago(1 * MIN),
    ...over,
  };
}

function state(over: Partial<PitrState> = {}): PitrState {
  return {
    archiver: {
      enabled: true,
      lastArchivedWal: '000000010000002E0000003F',
      lastArchivedAt: ago(1 * MIN),
      lastFailedWal: null,
      lastFailedAt: null,
    },
    repositories: [repo()],
    lastBaseBackupAt: ago(10 * HOUR),
    firstBaseBackupStartedAt: ago(15 * DAY),
    lastDrill: {
      publicId: '7f2c1a40-0000-4000-8000-000000000001',
      baseBackupLabel: '20261123-220000F',
      recoveryTarget: 'fms-drill-20261123T230000Z',
      status: 'succeeded',
      startedAt: ago(5 * DAY),
      finishedAt: ago(5 * DAY - 2),
      tablesRestored: 74,
      rtoSeconds: 80,
      checks: [{ table: 'fleet.vehicles', live_rows: 50, restored_rows: 50, match: true }],
      error: null,
      runBy: 'monthly drill',
    },
    lastPassedDrillAt: ago(5 * DAY),
    ...over,
  };
}

const conditions = (s: PitrState, now = NOW) => backupFindings(s, now).map((f) => f.condition);

describe('backupFindings (FMS-108 backup alerts)', () => {
  it('finds nothing when archiving, the repositories, the base backups and the drill are all current', () => {
    expect(backupFindings(state(), NOW)).toEqual([]);
  });

  it('finds nothing at all while the database does not archive its WAL', () => {
    const s = state({ archiver: { enabled: false, lastArchivedWal: null, lastArchivedAt: null, lastFailedWal: null, lastFailedAt: null }, repositories: [] });
    expect(backupFindings(s, NOW)).toEqual([]);
  });

  it('raises archiving failing as critical only after 5 minutes of failures, from the last success', () => {
    const failing = (lastOkMinutesAgo: number) =>
      state({
        archiver: { enabled: true, lastArchivedWal: 'a', lastArchivedAt: ago(lastOkMinutesAgo), lastFailedWal: 'b', lastFailedAt: ago(0.5) },
        repositories: [repo({ archiveMax: 'a' })],
      });
    expect(conditions(failing(4))).toEqual([]);
    const [f] = backupFindings(failing(6), NOW);
    expect(f).toMatchObject({ condition: 'archiving_failing', severity: 'critical', since: ago(6) });
    expect(f.message).toMatch(/6 min/);
  });

  it('does not count an old failure that a later success followed', () => {
    const s = state({ archiver: { enabled: true, lastArchivedWal: 'b', lastArchivedAt: ago(1), lastFailedWal: 'a', lastFailedAt: ago(3 * HOUR) } });
    expect(conditions(s)).toEqual([]);
  });

  it('raises an unreachable repository after 3 minutes, counted from when its status changed', () => {
    const s = (minutes: number) => state({ repositories: [repo(), repo({ repoKey: 2, statusCode: 103, statusMessage: 'unable to connect', statusSince: ago(minutes) })] });
    expect(conditions(s(2))).toEqual([]);
    expect(backupFindings(s(4), NOW)).toEqual([expect.objectContaining({ condition: 'repository_unreachable', severity: 'critical', repoKey: 2, since: ago(4) })]);
  });

  it('does not call a repository unreachable while it holds no backup yet (status 2): base_backup_missing covers it', () => {
    const s = state({ repositories: [repo(), repo({ repoKey: 2, statusCode: 2, statusMessage: 'no valid backups', statusSince: ago(3 * HOUR), backups: 0, oldestBackupAt: null })] });
    expect(conditions(s)).toEqual([]);
    expect(pitrOverview(s, NOW).repositories[1]).toMatchObject({ status: 'ok', message: 'no valid backups', recoverable_from: null });
  });

  it('raises the off-site copy as critical once it is 15 minutes behind the last segment archived', () => {
    const behind = (minutes: number) => state({ repositories: [repo(), repo({ repoKey: 2, archiveMax: '000000010000002E00000030', archiveMaxSeenAt: ago(minutes) })] });
    expect(conditions(behind(14))).toEqual([]);
    expect(backupFindings(behind(16), NOW)).toEqual([expect.objectContaining({ condition: 'offsite_behind', severity: 'critical', repoKey: 2, since: ago(16) })]);
  });

  it('never calls repository 1 behind: it is the copy beside the database', () => {
    const s = state({ repositories: [repo({ archiveMax: '000000010000002E00000030', archiveMaxSeenAt: ago(2 * HOUR) })] });
    expect(conditions(s)).toEqual([]);
  });

  it('does not call an idle off-site copy behind when it holds the last segment', () => {
    const s = state({ repositories: [repo(), repo({ repoKey: 2, archiveMaxSeenAt: ago(5 * HOUR) })] });
    expect(conditions(s)).toEqual([]);
  });

  it('raises the status as stale when the container has not written it for 10 minutes, or never', () => {
    expect(conditions(state({ repositories: [repo({ checkedAt: ago(11) })] }))).toContain('status_stale');
    expect(conditions(state({ repositories: [repo({ checkedAt: ago(9) })] }))).not.toContain('status_stale');
    expect(conditions(state({ repositories: [] }))).toEqual(['status_stale']);
  });

  it('raises a missing base backup after 26 hours, and with none ever succeeded, 26 hours after the first was started', () => {
    expect(conditions(state({ lastBaseBackupAt: ago(25 * HOUR) }))).toEqual([]);
    expect(backupFindings(state({ lastBaseBackupAt: ago(27 * HOUR) }), NOW)).toEqual([
      expect.objectContaining({ condition: 'base_backup_missing', severity: 'high', since: ago(27 * HOUR) }),
    ]);
    expect(conditions(state({ lastBaseBackupAt: null, firstBaseBackupStartedAt: ago(2 * HOUR) }))).toEqual([]);
    expect(conditions(state({ lastBaseBackupAt: null, firstBaseBackupStartedAt: ago(30 * HOUR) }))).toEqual(['base_backup_missing']);
  });

  it('raises a failed drill, and a drill none of which passed in 35 days', () => {
    const failed = state({ lastDrill: { ...state().lastDrill!, status: 'failed', error: 'the restored key tables differ' } });
    expect(backupFindings(failed, NOW)).toEqual([expect.objectContaining({ condition: 'drill_failed', severity: 'high' })]);
    expect(conditions(state({ lastPassedDrillAt: ago(34 * DAY) }))).toEqual([]);
    expect(conditions(state({ lastPassedDrillAt: ago(36 * DAY) }))).toEqual(['drill_overdue']);
  });

  it('counts a drill never passed as overdue 35 days after the oldest base backup', () => {
    const none = (oldestDays: number) => state({ lastDrill: null, lastPassedDrillAt: null, repositories: [repo({ oldestBackupAt: ago(oldestDays * DAY) })] });
    expect(conditions(none(20))).toEqual([]);
    expect(conditions(none(40))).toEqual(['drill_overdue']);
  });

  it('keeps `since` fixed while a risk goes on, so the alert is raised once', () => {
    const s = state({ archiver: { enabled: true, lastArchivedWal: 'a', lastArchivedAt: ago(20), lastFailedWal: 'b', lastFailedAt: ago(0.2) } });
    const first = backupFindings(s, NOW)[0];
    const later = backupFindings(s, new Date(NOW.getTime() + 30 * 60_000))[0];
    expect(later.since).toEqual(first.since);
  });

  it('puts critical findings first', () => {
    const s = state({
      lastBaseBackupAt: ago(30 * HOUR),
      archiver: { enabled: true, lastArchivedWal: 'a', lastArchivedAt: ago(20), lastFailedWal: 'b', lastFailedAt: ago(1) },
    });
    expect(backupFindings(s, NOW).map((f) => f.severity)).toEqual(['critical', 'high']);
  });
});

describe('recoverable range', () => {
  it('reaches from the oldest base backup to the last segment archived when the repository holds it', () => {
    const s = state();
    expect(recoverableRange(s.repositories[0], s.archiver)).toEqual({ from: ago(15 * DAY), to: ago(1) });
  });

  it('reaches only to its own newest segment when the repository is behind', () => {
    const s = state();
    const behind = repo({ repoKey: 2, archiveMax: '000000010000002E00000030', archiveMaxSeenAt: ago(40), oldestBackupAt: ago(3 * DAY) });
    expect(recoverableRange(behind, s.archiver)).toEqual({ from: ago(3 * DAY), to: ago(40) });
    expect(overallRange({ ...s, repositories: [s.repositories[0], behind] })).toEqual({ from: ago(15 * DAY), to: ago(1) });
  });

  it('is empty for a repository with no base backup: archived WAL alone restores nothing', () => {
    const s = state();
    expect(recoverableRange(repo({ backups: 0, oldestBackupAt: null, newestBackupAt: null }), s.archiver)).toEqual({ from: null, to: null });
  });

  it('gives the overview the API returns: repositories, the last drill and the findings', () => {
    const o = pitrOverview(state({ repositories: [repo(), repo({ repoKey: 2, cipher: 'none' })] }), NOW);
    expect(o.recoverable_from).toEqual(ago(15 * DAY));
    expect(o.repositories.map((r) => [r.repo, r.location, r.encrypted])).toEqual([
      [1, 'local', true],
      [2, 'offsite', false],
    ]);
    expect(o.last_drill).toMatchObject({ rto_seconds: 80, status: 'succeeded' });
    expect(o.findings).toEqual([]);
  });
});
