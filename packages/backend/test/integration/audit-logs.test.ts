import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { recordAuditEntry } from '../../src/shared/infrastructure/audit-log';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { runJob } from '../../src/shared/jobs/scheduler';
import { createDepot, createUser, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Reader-Test-1';

async function signIn(roles: RoleName[]) {
  const user = await createUser({ roles, depot: await createDepot(), password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const publicId = (await pool.query<{ public_id: string }>('SELECT public_id FROM auth.users WHERE id = $1', [user.id])).rows[0].public_id;
  return { user, publicId, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** Inserts audit rows directly, with chosen timestamps (many identical, as in one transaction). */
async function seedRows(action: string, timestamps: string[]) {
  for (const [i, at] of timestamps.entries()) {
    await pool.query(
      `INSERT INTO audit.audit_logs (action, correlation_id, created_at, details, request_source, result)
       VALUES ($1, $2, $3, $4, '{"channel":"script"}', 'success')`,
      [action, randomUUID(), at, JSON.stringify({ n: i })],
    );
  }
}

describe('GET /audit-logs', () => {
  test('filtering by entity returns its history newest first, with public ids only', async () => {
    const { cookie, publicId } = await signIn(['admin']);
    const created = await request(app).post('/api/v1/depots').set('Cookie', cookie).send({ name: 'History Yard', location: 'Adama' });
    const depotId = created.body.data.id;
    await request(app).patch(`/api/v1/depots/${depotId}`).set('Cookie', cookie).send({ capacity: 40 });
    await request(app).patch(`/api/v1/depots/${depotId}`).set('Cookie', cookie).send({ capacity: 55 });

    const res = await get(`/audit-logs?entity_type=fleet.depots&entity_id=${depotId}`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(['UPDATE', 'UPDATE', 'INSERT']);
    expect(res.body.data.map((r: { new_values: { capacity: number } }) => r.new_values.capacity)).toEqual([55, 40, null]);
    expect(res.body.data[0]).toMatchObject({
      result: 'success',
      actor: { type: 'user', id: publicId },
      entity_type: 'fleet.depots',
      entity_id: depotId,
      request_source: { channel: 'web' },
      old_values: { capacity: 40, public_id: depotId },
    });
    // No internal numeric id anywhere: not the row's, not the depot's, not the actor's.
    for (const row of res.body.data) {
      expect(row.new_values).not.toHaveProperty('id');
      expect(Object.keys(row)).not.toContain('user_id');
    }
    const occurred = res.body.data.map((r: { occurred_at: string }) => r.occurred_at);
    expect([...occurred].sort().reverse()).toEqual(occurred);
  });

  test('500 rows page without skips or duplicates, even with identical timestamps and a row added mid-way', async () => {
    const { cookie } = await signIn(['compliance_officer']);
    const stamps = [
      ...Array.from({ length: 250 }, () => '2026-09-01T08:00:00.000000Z'), // one transaction's worth
      ...Array.from({ length: 250 }, (_, i) => `2026-09-01T07:${String(Math.floor(i / 5) % 60).padStart(2, '0')}:00.123456Z`), // ties in fives
    ];
    await seedRows('paging.test', stamps);

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/audit-logs?action=paging.test&page_size=37${cursor ? `&cursor=${cursor}` : ''}`, cookie);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((r: { details: { n: number } }) => r.details.n));
      cursor = res.body.meta.next_cursor;
      pages += 1;
      // A newer row written while paging lands before the cursor: never repeated, never shifts the pages.
      if (pages === 3) await seedRows('paging.test', ['2026-09-02T00:00:00.000000Z']);
    } while (cursor);

    expect(pages).toBe(Math.ceil(500 / 37));
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
  });

  test('a dispatcher and a fleet manager get 403; admin, fleet owner and compliance officer read; /audit is the alias', async () => {
    for (const role of ['dispatcher', 'fleet_manager'] as RoleName[]) {
      expect((await get('/audit-logs', (await signIn([role])).cookie)).status, role).toBe(403);
    }
    for (const role of ['admin', 'fleet_owner', 'compliance_officer'] as RoleName[]) {
      expect((await get('/audit-logs?page_size=1', (await signIn([role])).cookie)).status, role).toBe(200);
    }
    const { cookie } = await signIn(['admin']);
    await seedRows('alias.test', ['2026-09-03T00:00:00.000000Z']);
    const main = await get('/audit-logs?action=alias.test', cookie);
    const alias = await get('/audit?action=alias.test', cookie);
    expect(alias.body.data).toEqual(main.body.data);
    expect((await request(app).get('/api/v1/audit-logs')).status).toBe(401);
  });

  test('filters: actor, correlation id, result, account entity, dates; system and anonymous actors', async () => {
    const reader = await signIn(['admin']);
    const dispatcher = await signIn(['dispatcher']);
    const denied = await get('/users', dispatcher.cookie);
    expect(denied.status).toBe(403);

    // Who did what: the dispatcher's denied request, by actor and by result.
    const byActor = await get(`/audit-logs?user_id=${dispatcher.publicId}&result=denied`, reader.cookie);
    expect(byActor.body.data.map((r: { action: string }) => r.action)).toEqual(['access.denied']);
    const byCorrelation = await get(`/audit-logs?correlation_id=${denied.headers['x-request-id']}`, reader.cookie);
    expect(byCorrelation.body.data).toHaveLength(1);

    // An account's own history (its sign-in) by its public id.
    const account = await get(`/audit-logs?entity_type=auth.users&entity_id=${dispatcher.publicId}&action=auth.login_succeeded`, reader.cookie);
    expect(account.body.data).toEqual([expect.objectContaining({ entity_id: dispatcher.publicId, actor: expect.objectContaining({ id: dispatcher.publicId }) })]);

    // A failed login has no actor; a job's rows have the system.
    await request(app).post('/api/v1/auth/login').send({ email: 'nobody@test.fms', password: 'wrong-password' });
    const failed = await get('/audit-logs?action=auth.login_failed&page_size=1', reader.cookie);
    expect(failed.body.data[0]).toMatchObject({ actor: { type: 'anonymous' }, result: 'failed' });
    const run = await runJob(
      { name: `reader-${randomUUID()}`, at: '00:00', run: async () => ({}) },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test' },
    );
    const job = await get(`/audit-logs?correlation_id=${run.status === 'succeeded' ? run.correlationId : ''}`, reader.cookie);
    expect(job.body.data.map((r: { actor: unknown }) => r.actor)).toEqual([{ type: 'system' }, { type: 'system' }]);

    // Dates are Addis Ababa days; `to` includes its day.
    await seedRows('dates.test', ['2026-08-31T20:59:00.000000Z', '2026-08-31T21:00:00.000000Z', '2026-09-01T20:59:59.000000Z', '2026-09-01T21:00:00.000000Z']);
    const day = await get('/audit-logs?action=dates.test&from=2026-09-01&to=2026-09-01', reader.cookie);
    expect(day.body.data.map((r: { details: { n: number } }) => r.details.n)).toEqual([2, 1]);
    const instants = await get(`/audit-logs?action=dates.test&from=${encodeURIComponent('2026-08-31T21:00:00Z')}`, reader.cookie);
    expect(instants.body.data).toHaveLength(3);

    // An unknown actor finds nothing; bad input is 400.
    expect((await get(`/audit-logs?user_id=${randomUUID()}`, reader.cookie)).body.data).toEqual([]);
    const badCursor = await get('/audit-logs?cursor=bm90LWEtY3Vyc29y', reader.cookie);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.details).toEqual([{ field: 'cursor', reason: 'invalid_cursor' }]);
    expect((await get('/audit-logs?from=2026-09-02&to=2026-09-01', reader.cookie)).status).toBe(400);
    expect((await get('/audit-logs?entity_type=users;drop', reader.cookie)).status).toBe(400);
    expect((await get('/audit-logs?page_size=201', reader.cookie)).status).toBe(400);
  });

  test('action takes several actions and prefixes, so one view shows every change or every sign-in', async () => {
    const reader = await signIn(['admin']);
    for (const action of ['pick.one', 'pick.two', 'pick_x.three', 'pickyx.four', 'other']) await seedRows(action, ['2026-07-01T09:00:00.000000Z']);
    const actions = async (filter: string) =>
      (await get(`/audit-logs?from=2026-07-01&to=2026-07-01&action=${filter}`, reader.cookie)).body.data.map((r: { action: string }) => r.action).sort();

    expect(await actions('pick.one,other')).toEqual(['other', 'pick.one']);
    expect(await actions('pick.*')).toEqual(['pick.one', 'pick.two']);
    expect(await actions('pick.*,other')).toEqual(['other', 'pick.one', 'pick.two']);
    // `_` is part of the name, not LIKE's any-character: pick_x.* does not reach pickyx.four.
    expect(await actions('pick_x.*')).toEqual(['pick_x.three']);

    for (const bad of ['pick.%25', 'a,,b', '*', 'auth.*.x', Array(11).fill('a').join(',')]) {
      const res = await get(`/audit-logs?action=${bad}`, reader.cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'action', reason: 'invalid_action' })]);
    }
  });

  test('the reader never writes: the trail has no write endpoint', async () => {
    const { cookie } = await signIn(['admin']);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/v1/audit-logs').set('Cookie', cookie)).status).toBe(404);
    }
  });
});

describe('recordAuditEntry and the reader', () => {
  test('a row written before FMS-27 (no source or result) still reads', async () => {
    const { cookie } = await signIn(['admin']);
    await recordAuditEntry(pool, { action: 'legacy.test', userId: null, entityType: null, entityId: null, correlationId: randomUUID() });
    const res = await get('/audit-logs?action=legacy.test', cookie);
    expect(res.body.data[0]).toMatchObject({ actor: { type: 'anonymous' }, request_source: { channel: 'script' }, details: {} });
  });
});
