import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { backupService, restoreBackup, restoreDeps } from '../../src/modules/backup';
import { BackupService } from '../../src/modules/backup/application/backup.service';
import { BackupLinkSigner } from '../../src/modules/backup/domain/backup-link';
import { BackupRepository } from '../../src/modules/backup/infrastructure/backup.repository';
import { pgClientTools } from '../../src/modules/backup/infrastructure/pg-tools';
import { userDirectory } from '../../src/modules/auth';
import { createDocumentStorage } from '../../src/shared/storage/document-storage';
import { createUser, type RoleName } from '../support/factories';

// Database backups (FMS-144): Back up now takes a real pg_dump that restores into an empty database; a failed
// dump is recorded with pg_dump's own error; downloads are signed, short-lived and audited; admin only.
// pg_dump and pg_restore run on this machine, or in the test database's container with BACKUP_PG_CONTAINER.

const app = createApp();
const PASSWORD = 'Backup-Test-2';

async function signIn(roles: RoleName[]): Promise<{ cookie: string; id: string; name: string }> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return {
    cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '),
    id: user.id as string,
    name: user.full_name as string,
  };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send({}),
};

/** The bytes of a download, whatever its content type. */
const download = (url: string) =>
  request(app)
    .get(url)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

const auditActions = async (entityId: string) =>
  (await pool.query<{ action: string; user_id: string | null; result: string }>(
    `SELECT action, user_id, result FROM audit.audit_logs WHERE entity_type = 'backup.backups' AND entity_id = $1 ORDER BY id`,
    [entityId],
  )).rows;

const internalId = async (publicId: string) => (await pool.query<{ id: string }>('SELECT id FROM backup.backups WHERE public_id = $1', [publicId])).rows[0].id;

describe('database backups', () => {
  test('Back up now: queued, taken by the runner, listed with its size and who started it, and it restores into an empty database', async () => {
    const admin = await signIn(['admin']);
    const before = await api.get('/system/backups', admin.cookie);
    expect(before.status).toBe(200);
    expect(before.body.meta).toMatchObject({ available: true, retention_days: 30 });

    const started = await api.post('/system/backups', admin.cookie);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body.data).toMatchObject({ kind: 'manual', status: 'queued', requested_by: { name: admin.name }, downloadable: false });
    const id = started.body.data.id as string;

    // One at a time.
    const again = await api.post('/system/backups', admin.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.details).toEqual([{ field: 'status', reason: 'backup_in_progress' }]);

    await backupService.drain();
    const done = await api.get(`/system/backups/${id}`, admin.cookie);
    expect(done.body.data, JSON.stringify(done.body.data.error)).toMatchObject({ status: 'succeeded', downloadable: true, error: null });
    expect(done.body.data.size_bytes).toBeGreaterThan(10_000);
    expect(done.body.data.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(done.body.data.expires_at) - Date.parse(done.body.data.finished_at)).toBe(30 * 24 * 60 * 60 * 1000);
    const list = await api.get('/system/backups', admin.cookie);
    expect(list.body.data[0]).toMatchObject({ id, status: 'succeeded' });
    expect(list.body.meta.last_succeeded_at).toBe(done.body.data.finished_at);

    // The download: a link for this admin, then the file, audited as theirs.
    const link = await api.post(`/system/backups/${id}/download-link`, admin.cookie);
    expect(link.status).toBe(200);
    expect(link.body.data.filename).toMatch(/^fms-[a-z0-9_]+-\d{8}-\d{4}Z\.dump$/);
    const file = await download(link.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${link.body.data.filename}"`);
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(createHash('sha256').update(file.body as Buffer).digest('hex')).toBe(done.body.data.checksum_sha256);
    // pg_dump's custom format.
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('PGDMP');
    // Always a different first digit: overwriting it with a fixed one leaves 1 signature in 16 unchanged.
    const tampered = await download(link.body.data.url.replace(/signature=(.)/, (_: string, c: string) => `signature=${c === '0' ? '1' : '0'}`));
    expect(tampered.status).toBe(401);

    const audit = await auditActions(await internalId(id));
    expect(audit.map((a) => a.action)).toEqual(['backup.requested', 'backup.succeeded', 'backup.downloaded']);
    expect(audit.every((a) => a.user_id === admin.id)).toBe(true);

    // It restores: into a new database, checked against its SHA-256, recorded as a drill and dropped.
    const database = `fms_restore_${randomUUID().slice(0, 8)}`;
    const restored = await restoreBackup(restoreDeps()!, { backupId: id, database, drill: true, runBy: 'integration test' });
    expect(restored.checksum).toBe(done.body.data.checksum_sha256);
    expect(restored.tables).toBeGreaterThan(50);
    const drill = (await api.get('/system/backups', admin.cookie)).body.meta.last_restore_drill;
    expect(drill).toMatchObject({ backup_id: id, target_database: database, status: 'succeeded', tables_restored: restored.tables, run_by: 'integration test' });
    const left = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    expect(left.rowCount).toBe(0);

    // Never over the live database.
    await expect(restoreBackup(restoreDeps()!, { backupId: id, database: config.db.database, drill: false, runBy: 'test' })).rejects.toThrow(/live database/);
  }, 120_000);

  test('a failed dump is recorded with pg_dump’s own error, and audited as failed', async () => {
    const admin = await signIn(['admin']);
    const backups = new BackupRepository(pool);
    const live = restoreDeps()!.live;
    const failing = new BackupService({
      db: pool,
      backups,
      storage: createDocumentStorage(config.storage),
      tools: pgClientTools({ binDir: config.backup.binDir, container: config.backup.container }),
      links: new BackupLinkSigner(config.jwtSecret),
      // A database that does not exist: pg_dump cannot connect.
      target: { ...live, database: 'fms_no_such_database' },
      users: userDirectory,
      log: { info: () => undefined, error: () => undefined },
      autoStart: false,
    });
    const queued = await failing.request({ user: { id: admin.id, publicId: null, roles: ['admin'], permissions: [], depotId: null }, correlationId: randomUUID() });
    await failing.drain();
    const row = await api.get(`/system/backups/${queued.id}`, admin.cookie);
    expect(row.body.data).toMatchObject({ status: 'failed', downloadable: false, size_bytes: null });
    expect(row.body.data.error).toMatch(/fms_no_such_database/);
    expect(row.body.data.finished_at).not.toBeNull();
    const link = await api.post(`/system/backups/${queued.id}/download-link`, admin.cookie);
    expect(link.status).toBe(409);
    const audit = await auditActions(await internalId(queued.id));
    expect(audit.map((a) => [a.action, a.result])).toEqual([
      ['backup.requested', 'success'],
      ['backup.failed', 'failed'],
    ]);
    // The queue is free again.
    expect((await api.post('/system/backups', admin.cookie)).status).toBe(202);
  }, 60_000);

  test('past retention the file is removed and the backup kept as expired', async () => {
    const admin = await signIn(['admin']);
    const started = await api.post('/system/backups', admin.cookie);
    await backupService.drain();
    const id = started.body.data.id as string;
    const key = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM backup.backups WHERE public_id = $1', [id])).rows[0].storage_key;
    await pool.query(`UPDATE backup.backups SET expires_at = now() - interval '1 minute' WHERE public_id = $1`, [id]);
    expect(await backupService.expire(randomUUID())).toMatchObject({ expired: 1 });
    const row = await api.get(`/system/backups/${id}`, admin.cookie);
    expect(row.body.data).toMatchObject({ status: 'expired', downloadable: false });
    await expect(createDocumentStorage(config.storage).get(key)).rejects.toThrow();
    const link = await api.post(`/system/backups/${id}/download-link`, admin.cookie);
    expect(link.status).toBe(409);
    expect(link.body.error.details).toEqual([{ field: 'status', reason: 'expired' }]);
  }, 60_000);

  test('admin only: other roles see and start nothing', async () => {
    for (const role of ['fleet_manager', 'fleet_owner', 'compliance_officer'] as RoleName[]) {
      const { cookie } = await signIn([role]);
      expect((await api.get('/system/backups', cookie)).status).toBe(403);
      expect((await api.post('/system/backups', cookie)).status).toBe(403);
    }
    expect((await request(app).get('/api/v1/system/backups')).status).toBe(401);
  });
});
