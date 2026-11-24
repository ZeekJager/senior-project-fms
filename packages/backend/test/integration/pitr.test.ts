import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { CHANNELS_BY_SEVERITY } from '../../src/modules/alert/domain/delivery';
import { PitrService } from '../../src/modules/backup/application/pitr.service';
import type { PitrState } from '../../src/modules/backup/domain/pitr';
import { BackupRepository } from '../../src/modules/backup/infrastructure/backup.repository';
import { systemHealth } from '../../src/modules/system';
import { eventBus } from '../../src/shared/events/event-bus';
import { deliverEvents, publishedEvents } from '../support/events';
import { createUser, type RoleName } from '../support/factories';
import { responseProblems } from '../support/openapi';

// Point-in-time recovery (FMS-108, docs/backups.md): the Backups API's meta.pitr and base backups, the backup alerts
// raised once per risk, and System health's Backups component. The database container writes the tables these read;
// here the state is given to the service, since the test role may only read them.

const app = createApp();
const PASSWORD = 'Pitr-Test-1';

async function signIn(roles: RoleName[]) {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), id: user.id as string };
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** Archiving failing for 20 minutes, and the off-site copy 40 minutes behind. */
const atRisk: PitrState = {
  archiver: { enabled: true, lastArchivedWal: '000000010000002E00000040', lastArchivedAt: ago(20), lastFailedWal: '000000010000002E00000041', lastFailedAt: ago(1) },
  repositories: [
    {
      repoKey: 1,
      cipher: 'aes-256-cbc',
      statusCode: 0,
      statusMessage: 'ok',
      statusSince: ago(5000),
      archiveMin: '000000010000002D000000E8',
      archiveMax: '000000010000002E00000040',
      archiveMaxSeenAt: ago(20),
      backups: 2,
      oldestBackupAt: ago(60_000),
      newestBackupAt: ago(600),
      checkedAt: ago(1),
    },
    {
      repoKey: 2,
      cipher: 'aes-256-cbc',
      statusCode: 0,
      statusMessage: 'ok',
      statusSince: ago(5000),
      archiveMin: '000000010000002D000000E8',
      archiveMax: '000000010000002E00000030',
      archiveMaxSeenAt: ago(40),
      backups: 2,
      oldestBackupAt: ago(60_000),
      newestBackupAt: ago(600),
      checkedAt: ago(1),
    },
  ],
  lastBaseBackupAt: ago(600),
  firstBaseBackupStartedAt: ago(3000),
  lastDrill: null,
  lastPassedDrillAt: null,
};

function serviceWith(state: PitrState, now = NOW): PitrService {
  const backups = new BackupRepository(pool);
  backups.pitrState = async () => state;
  return new PitrService({ db: pool, backups, events: eventBus, now: () => now });
}

async function adminAlerts(adminId: string) {
  const res = await pool.query<{ alert_type: string; severity: string; title: string; description: string }>(
    `SELECT a.alert_type, a.severity, a.title, a.description
       FROM alert.alerts a JOIN alert.notifications n ON n.alert_id = a.id
      WHERE n.recipient_user_id = $1 AND n.channel = 'in_app' AND a.alert_type = 'backup_at_risk' ORDER BY a.id`,
    [adminId],
  );
  return res.rows;
}

describe('point-in-time recovery on the Backups API', () => {
  test('meta.pitr and GET /system/base-backups: admin only, as the database records them', async () => {
    const admin = await signIn(['admin']);
    const list = await get('/system/backups', admin.cookie);
    expect(list.status).toBe(200);
    expect(list.body.meta.pitr).toMatchObject({
      enabled: expect.any(Boolean),
      repositories: expect.any(Array),
      findings: expect.any(Array),
      archiving: expect.objectContaining({ failing_since: null }),
    });
    expect(responseProblems('/system/backups', 'get', 200, list.body)).toBeNull();

    const base = await get('/system/base-backups', admin.cookie);
    expect(base.status).toBe(200);
    expect(base.body.meta).toMatchObject({ page: 1, total_items: expect.any(Number) });
    expect(Array.isArray(base.body.data)).toBe(true);
    expect(responseProblems('/system/base-backups', 'get', 200, base.body)).toBeNull();

    const dispatcher = await signIn(['dispatcher']);
    expect((await get('/system/base-backups', dispatcher.cookie)).status).toBe(403);
  });

  test('a base backup the database container recorded is listed, newest first, with its sizes', async () => {
    // The container writes these as the schema owner; the API role can only read them.
    const admin = await signIn(['admin']);
    const grants = await pool.query<{ ins: boolean }>(`SELECT has_table_privilege('backup.base_backups', 'INSERT') AS ins`);
    expect(grants.rows[0].ins).toBe(false);
    const res = await get('/system/base-backups?page_size=5', admin.cookie);
    for (const b of res.body.data as { status: string; type: string }[]) {
      expect(['running', 'succeeded', 'failed', 'expired']).toContain(b.status);
      expect(['full', 'diff', 'incr']).toContain(b.type);
    }
  });
});

describe('backup alerts (backup-monitor)', () => {
  test('each risk raises one alert for administrators: critical ones by email, SMS and push', async () => {
    const admin = await signIn(['admin']);
    const result = await serviceWith(atRisk).monitor('00000000-0000-4000-8000-000000000108');
    expect(result).toEqual({ at_risk: 3, critical: 2 });

    const events = await publishedEvents('BackupAtRisk');
    expect(events.map((e) => e.payload.condition).sort()).toEqual(['archiving_failing', 'drill_overdue', 'offsite_behind']);
    expect(events.find((e) => e.payload.condition === 'offsite_behind')!.payload).toMatchObject({ severity: 'critical', repo: 2, since: ago(40).toISOString() });

    await deliverEvents();
    const alerts = await adminAlerts(admin.id);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'critical', title: 'WAL archiving is failing' }),
        expect.objectContaining({ severity: 'critical', title: 'Off-site backup copy behind' }),
        expect.objectContaining({ severity: 'high', title: 'Restore drill overdue' }),
      ]),
    );
    // Outside the app, by the severity's channels (those this server has on; alerts.test.ts covers the sending).
    expect(CHANNELS_BY_SEVERITY.critical).toEqual(['email', 'sms', 'push']);
    expect(CHANNELS_BY_SEVERITY.high).toEqual(['push']);
  });

  test('a risk that goes on is published once; one that clears and comes back is new', async () => {
    await signIn(['admin']);
    await serviceWith(atRisk).monitor('00000000-0000-4000-8000-000000000108');
    await serviceWith(atRisk, new Date(NOW.getTime() + 10 * 60_000)).monitor('00000000-0000-4000-8000-000000000108');
    expect((await publishedEvents('BackupAtRisk')).filter((e) => e.payload.condition === 'archiving_failing')).toHaveLength(1);

    // Archiving recovered, then failed again: a new since, so a new event.
    const again: PitrState = { ...atRisk, archiver: { ...atRisk.archiver, lastArchivedAt: ago(-30), lastFailedAt: ago(-50) } };
    await serviceWith(again, new Date(NOW.getTime() + 60 * 60_000)).monitor('00000000-0000-4000-8000-000000000108');
    expect((await publishedEvents('BackupAtRisk')).filter((e) => e.payload.condition === 'archiving_failing')).toHaveLength(2);
  });

  test('nothing is raised while the database does not archive its WAL', async () => {
    const off: PitrState = { ...atRisk, archiver: { enabled: false, lastArchivedWal: null, lastArchivedAt: null, lastFailedWal: null, lastFailedAt: null } };
    expect(await serviceWith(off).monitor('00000000-0000-4000-8000-000000000108')).toEqual({ at_risk: 0 });
    expect(await publishedEvents('BackupAtRisk')).toEqual([]);
  });
});

describe("System health's Backups component", () => {
  const backupsProbe = async (backups: () => Promise<{ enabled: boolean; findings: { message: string }[] }>) =>
    (await systemHealth.probes({ backups })()).find((p) => p.component === 'backups')!;

  test('down with the most severe risk, ok without one, disabled without archiving', async () => {
    const service = serviceWith(atRisk);
    const down = await backupsProbe(() => service.findings());
    await expect(down.check()).rejects.toThrow(/WAL archiving has failed for 20 min/);

    const ok = await backupsProbe(async () => ({ enabled: true, findings: [] }));
    await expect(ok.check()).resolves.toEqual({});

    const off = await backupsProbe(async () => ({ enabled: false, findings: [] }));
    await expect(off.check()).resolves.toEqual({ disabled: true });
    expect(down.label).toBe('Backups');
  });
});
