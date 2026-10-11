import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { auditedMutation } from '../../src/shared/infrastructure/audited-mutation';
import { recordAuditEntry } from '../../src/shared/infrastructure/audit-log';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { runJob } from '../../src/shared/jobs/scheduler';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { createDepot, createUser, type RoleName } from '../support/factories';

// FMS-27: every audit row says where the action came from (request_source)
// and how it ended (result).

const app = createApp();
const PASSWORD = 'Audit-Test-1';

interface AuditRow {
  action: string;
  user_id: string | null;
  ip: string | null;
  result: string;
  request_source: Record<string, unknown>;
  details: Record<string, unknown>;
}

async function rowsFor(res: Response | string): Promise<AuditRow[]> {
  const id = typeof res === 'string' ? res : res.headers['x-request-id'];
  const rows = await pool.query<AuditRow>(
    'SELECT action, user_id, host(ip_address) AS ip, result, request_source, details FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [id],
  );
  return rows.rows;
}

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  request(app).post('/api/v1/auth/login').set('User-Agent', 'audit-agent/1.0').set(headers).send({ email, password });

async function signIn(roles: RoleName[]) {
  const depot = await createDepot();
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await login(user.email as string, PASSWORD);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

describe('authentication events', () => {
  test('a failed login writes result failed with the source IP, user agent and channel', async () => {
    const user = await createUser({ password: PASSWORD });
    const res = await login(user.email as string, 'wrong-password');
    expect(res.status).toBe(401);
    const [row] = await rowsFor(res);
    expect(row).toMatchObject({ action: 'auth.login_failed', result: 'failed', user_id: null });
    expect(row.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(row.request_source).toEqual({ channel: 'web', ip: expect.stringMatching(/127\.0\.0\.1|::1/), user_agent: 'audit-agent/1.0' });
  });

  test('success, throttling and logout: success, denied, success', async () => {
    const user = await createUser({ password: PASSWORD });
    const ok = await login(user.email as string, PASSWORD);
    expect((await rowsFor(ok)).map((r) => [r.action, r.result])).toEqual([['auth.login_succeeded', 'success']]);

    for (let i = 0; i < 5; i++) await login(user.email as string, 'wrong-password');
    const throttled = await login(user.email as string, PASSWORD);
    expect(throttled.status).toBe(429);
    expect((await rowsFor(throttled)).map((r) => [r.action, r.result])).toEqual([['auth.login_throttled', 'denied']]);

    const cookie = (ok.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect((await rowsFor(out)).map((r) => [r.action, r.result])).toEqual([['auth.logout', 'success']]);
  });

  test('the installed app is channel pwa; a client cannot claim job or webhook', async () => {
    const user = await createUser({ password: PASSWORD });
    const pwa = await login(user.email as string, PASSWORD, { 'X-Client-Channel': 'pwa' });
    expect((await rowsFor(pwa))[0].request_source.channel).toBe('pwa');
    const forged = await login(user.email as string, PASSWORD, { 'X-Client-Channel': 'job' });
    expect((await rowsFor(forged))[0].request_source.channel).toBe('web');
  });
});

describe('role changes and mutations', () => {
  test('a role change writes a ROLE_CHANGE row with the request source and result success', async () => {
    const { cookie } = await signIn(['admin']);
    const target = await createUser({ roles: ['fleet_owner'] });
    const id = (await pool.query<{ public_id: string }>('SELECT public_id FROM auth.users WHERE id = $1', [target.id])).rows[0].public_id;
    const res = await request(app).patch(`/api/v1/users/${id}`).set('Cookie', cookie).set('User-Agent', 'audit-agent/1.0').send({ roles: ['compliance_officer'] });
    expect(res.status).toBe(200);
    const change = (await rowsFor(res)).find((r) => r.action === 'ROLE_CHANGE')!;
    expect(change).toMatchObject({ result: 'success', request_source: { channel: 'web', user_agent: 'audit-agent/1.0' } });
    expect(change.ip).not.toBeNull();
  });

  test('a mutation through the API records the source, including after a multipart upload', async () => {
    const { cookie } = await signIn(['admin']);
    const depot = await request(app).post('/api/v1/depots').set('Cookie', cookie).set('User-Agent', 'audit-agent/1.0').send({ name: 'Audit Yard', location: 'Adama' });
    expect(await rowsFor(depot)).toEqual([expect.objectContaining({ action: 'INSERT', result: 'success', request_source: expect.objectContaining({ channel: 'web' }) })]);

    const vehicle = await request(app)
      .post('/api/v1/vehicles')
      .set('Cookie', cookie)
      .send({ registration_number: 'AA 3-77001', make: 'Isuzu', model: 'NPR', vehicle_type: 'truck', fuel_type: 'diesel', fuel_efficiency_ml_per_km: 180, depot_id: depot.body.data.id });
    const upload = await request(app)
      .post('/api/v1/documents')
      .set('Cookie', cookie)
      .set('User-Agent', 'audit-agent/1.0')
      .field('owner_type', 'vehicle')
      .field('owner_id', vehicle.body.data.id)
      .field('document_type', 'registration')
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'r.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    const rows = await rowsFor(upload);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.request_source).toMatchObject({ channel: 'web', user_agent: 'audit-agent/1.0' });
  });
});

describe('denied access', () => {
  test('a refused request writes access.denied with result denied, the route pattern and the permission needed', async () => {
    const { user, cookie } = await signIn(['dispatcher']);
    const res = await request(app).get('/api/v1/users?search=secret').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(await rowsFor(res)).toEqual([
      expect.objectContaining({
        action: 'access.denied',
        result: 'denied',
        user_id: String(user.id),
        details: expect.objectContaining({ method: 'GET', route: '/api/v1/users', required: ['users:read'] }),
      }),
    ]);
  });

  test('not signed in is a 401, not an audit row', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
    expect(await rowsFor(res)).toEqual([]);
  });
});

describe('jobs', () => {
  test('a job mutation has actor system (no user), channel job and the run’s UUID correlation id', async () => {
    const outcome = await runJob(
      {
        name: 'audit-coverage-test',
        at: '00:00',
        run: async ({ correlationId }) => {
          await withTransaction(pool, (client) =>
            auditedMutation(client, { userId: null, correlationId }, 'fleet.depots', 'INSERT', null, { name: 'Job Depot', location: 'Jimma' }),
          );
          return { created: 1 };
        },
      },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test' },
    );
    expect(outcome.status).toBe('succeeded');
    const correlationId = outcome.status === 'succeeded' ? outcome.correlationId : '';
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const rows = await rowsFor(correlationId);
    expect(rows.map((r) => r.action)).toEqual(['job.started', 'INSERT', 'job.succeeded']);
    for (const row of rows) {
      expect(row).toMatchObject({ user_id: null, result: 'success', ip: null, request_source: { channel: 'job', actor: 'system', job: 'audit-coverage-test' } });
    }
  });

  test('a failed job run is recorded with result failed', async () => {
    const outcome = await runJob(
      { name: 'audit-coverage-failing', at: '00:00', run: async () => Promise.reject(new Error('upstream down')) },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test' },
    );
    expect(outcome.status).toBe('failed');
    const rows = await rowsFor(outcome.status === 'failed' ? outcome.correlationId : '');
    expect(rows.map((r) => [r.action, r.result])).toEqual([
      ['job.started', 'success'],
      ['job.failed', 'failed'],
    ]);
  });
});

describe('outside a request or job', () => {
  test('scripts are channel script; the database refuses a row without result or source', async () => {
    await recordAuditEntry(pool, { action: 'script.test', userId: null, entityType: null, entityId: null, correlationId: '00000000-0000-4000-8000-000000000027' });
    expect((await rowsFor('00000000-0000-4000-8000-000000000027'))[0]).toMatchObject({ result: 'success', request_source: { channel: 'script' } });

    await expect(
      pool.query("INSERT INTO audit.audit_logs (action, correlation_id) VALUES ('raw', '00000000-0000-4000-8000-000000000028')"),
    ).rejects.toThrow(/chk_audit_(result|request_source)/);
  });
});
