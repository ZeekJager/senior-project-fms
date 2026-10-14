import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { operatingToday } from '../../src/modules/fleet/domain/attendance';
import { idempotencyPurgeJob, purgeExpiredIdempotencyKeys } from '../../src/shared/http/idempotency-purge';
import { createDepot, createDriver, createUser } from '../support/factories';

const app = createApp();
const PASSWORD = 'Replay-Test-1';

async function signIn(depot: Awaited<ReturnType<typeof createDepot>>) {
  const user = await createUser({ roles: ['depot_admin'], depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const post = (cookie: string, key: string, body: object) =>
  request(app).post('/api/v1/attendance').set('Cookie', cookie).set('Idempotency-Key', key).send(body);

describe('Idempotency-Key on POST /attendance (FMS-87)', () => {
  test('a retry replays the stored 201; the same key with another body is 409 CONFLICT_IDEMPOTENCY_KEY_REUSED', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(depot);
    const { driver } = await createDriver({ depot });
    const body = { driver_id: driver.public_id, date: operatingToday(), status: 'present' };
    const key = `k-${randomUUID()}`;

    const first = await post(cookie, key, body);
    expect(first.status).toBe(201);
    const retry = await post(cookie, key, body);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);

    const reused = await post(cookie, key, { ...body, status: 'absent' });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSED');
  });

  test('a key whose first request is still running is 409 CONFLICT_IDEMPOTENCY_IN_PROGRESS, and the handler does not run', async () => {
    const depot = await createDepot();
    const { user, cookie } = await signIn(depot);
    const { driver } = await createDriver({ depot });
    const body = { driver_id: driver.public_id, date: operatingToday(), status: 'present' };
    const key = `k-${randomUUID()}`;
    // The harness shares one connection per test, so a true race can't run here (docs/testing.md):
    // a stored in_progress row is what a second request meets while the first is still running.
    await pool.query(
      `INSERT INTO api.idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash, expires_at)
       VALUES ($1, $2, 'POST', '/api/v1/attendance', repeat('0', 64), now() + interval '1 hour')`,
      [user.id, key],
    );

    const busy = await post(cookie, key, body);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('CONFLICT_IDEMPOTENCY_IN_PROGRESS');
    expect((await pool.query('SELECT count(*)::int AS n FROM fleet.driver_attendance WHERE driver_id = $1', [driver.id])).rows[0].n).toBe(0);
  });

  test('keys are per user: another caller may reuse the same key', async () => {
    const depot = await createDepot();
    const [one, two] = [await signIn(depot), await signIn(depot)];
    const [d1, d2] = [await createDriver({ depot }), await createDriver({ depot })];
    const key = `k-${randomUUID()}`;
    const date = operatingToday();

    expect((await post(one.cookie, key, { driver_id: d1.driver.public_id, date, status: 'present' })).status).toBe(201);
    const other = await post(two.cookie, key, { driver_id: d2.driver.public_id, date, status: 'present' });
    expect(other.status).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('idempotency key purge job (FMS-87)', () => {
  test('deletes expired keys and keeps live ones', async () => {
    const user = await createUser({ roles: ['admin'] });
    const insert = (key: string, expires: string) =>
      pool.query(
        `INSERT INTO api.idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash, created_at, expires_at)
         VALUES ($1, $2, 'POST', '/api/v1/attendance', repeat('0', 64), now() - interval '48 hours', now() + $3::interval)`,
        [user.id, key, expires],
      );
    const [old, live] = [`old-${randomUUID()}`, `live-${randomUUID()}`];
    await insert(old, '-1 hour');
    await insert(live, '1 hour');

    const result = await idempotencyPurgeJob(pool).run({ now: new Date(), correlationId: randomUUID(), runKey: 'test' });
    expect(result).toMatchObject({ purged: expect.any(Number) });

    const left = await pool.query<{ idempotency_key: string }>('SELECT idempotency_key FROM api.idempotency_keys WHERE user_id = $1', [user.id]);
    expect(left.rows.map((r) => r.idempotency_key)).toEqual([live]);
    expect(await purgeExpiredIdempotencyKeys(pool)).toBe(0);
  });
});
