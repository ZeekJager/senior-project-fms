import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { operatingToday } from '../../src/modules/fleet/domain/attendance';
import { idempotencyPurgeJob, purgeExpiredIdempotencyKeys } from '../../src/shared/http/idempotency-purge';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';

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

// FMS-116: the driver's offline queue may hold a submission for up to 7 days, so the endpoints it sends to keep
// their keys that long; everything else keeps the default 24 hours.
describe('Idempotency-Key window on the offline-queue endpoints (FMS-116)', () => {
  const DAY_HOURS = 24;

  /** A driver who can sign in, with their fleet.drivers row. */
  async function driverSignIn(depot: Awaited<ReturnType<typeof createDepot>>) {
    const { user, driver } = await createDriver({ depot });
    await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
    const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return { user, driver, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
  }

  const send = (path: string, cookie: string, key: string, body: object) =>
    request(app).post(`/api/v1${path}`).set('Cookie', cookie).set('Idempotency-Key', key).send(body);

  /** How long the stored key lives, in hours, from when it was made. */
  async function windowHours(userId: string, key: string): Promise<number> {
    const { rows } = await pool.query<{ h: number }>(
      `SELECT extract(epoch FROM expires_at - created_at) / 3600 AS h FROM api.idempotency_keys WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return Math.round(Number(rows[0].h));
  }

  /** Makes the stored key `days` days old, as if its request had been made then. */
  const age = (userId: string, key: string, days: number) =>
    pool.query(
      `UPDATE api.idempotency_keys
          SET created_at = created_at - make_interval(days => $3), completed_at = completed_at - make_interval(days => $3),
              expires_at = expires_at - make_interval(days => $3)
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key, days],
    );

  const count = async (sql: string, ...params: unknown[]) => (await pool.query<{ n: number }>(sql, params)).rows[0].n;

  /** What a case needs to count its own records. */
  interface Scene {
    vehicle: { id: string };
    driver: { user: { id: string } };
  }
  async function setups() {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const driver = await driverSignIn(depot);
    const inspection = { vehicle_id: vehicle.public_id, type: 'pre_trip', items: [{ name: 'Brakes', passed: true }] };
    const fuel = { vehicle_id: vehicle.public_id, quantity_ml: 45_500, total_cost_cents: 380_000, odometer_km: 12_000.5 };
    const incident = { description: 'Rear-ended at the Bole junction, bumper hanging.', severity: 'high' };
    return {
      depot,
      driver,
      vehicle,
      cases: [
        { path: '/fuel-logs', body: fuel, records: (s: Scene) => count('SELECT count(*)::int AS n FROM fuel.fuel_logs WHERE vehicle_id = $1', s.vehicle.id) },
        { path: '/dvir-reports', body: inspection, records: (s: Scene) => count('SELECT count(*)::int AS n FROM fleet.dvir_reports WHERE vehicle_id = $1', s.vehicle.id) },
        { path: '/incidents', body: incident, records: (s: Scene) => count('SELECT count(*)::int AS n FROM alert.incident_reports WHERE reported_by = $1', s.driver.user.id) },
      ],
    };
  }

  test.each(['/fuel-logs', '/dvir-reports', '/incidents'])(
    'POST %s keeps its key 7 days: a replay 3 days later returns the original and records nothing',
    async (path) => {
      const s = await setups();
      const { body, records } = s.cases.find((c) => c.path === path)!;
      const key = `k-${randomUUID()}`;

      const first = await send(path, s.driver.cookie, key, body);
      expect(first.status).toBe(201);
      expect(await windowHours(s.driver.user.id, key)).toBe(7 * DAY_HOURS);
      expect(await records(s)).toBe(1);

      await age(s.driver.user.id, key, 3);
      const replay = await send(path, s.driver.cookie, key, body);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(await records(s)).toBe(1);
    },
  );

  test('past 7 days the key is forgotten: the purge removes it and the same key is a new request', async () => {
    const s = await setups();
    const { path, body, records } = s.cases[0];
    const key = `k-${randomUUID()}`;
    expect((await send(path, s.driver.cookie, key, body)).status).toBe(201);

    await age(s.driver.user.id, key, 6);
    expect(await purgeExpiredIdempotencyKeys(pool)).toBe(0); // 6 days old: still kept
    await age(s.driver.user.id, key, 2);
    expect(await purgeExpiredIdempotencyKeys(pool)).toBeGreaterThanOrEqual(1); // 8 days old: gone
    expect(await count('SELECT count(*)::int AS n FROM api.idempotency_keys WHERE user_id = $1 AND idempotency_key = $2', s.driver.user.id, key)).toBe(0);

    const again = await send(path, s.driver.cookie, key, body);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(await records(s)).toBe(2);
  });

  test('other endpoints still keep keys 24 hours: POST /attendance replayed after 3 days runs again', async () => {
    const depot = await createDepot();
    const { user, cookie } = await signIn(depot);
    const { driver } = await createDriver({ depot });
    const key = `k-${randomUUID()}`;
    const body = { driver_id: driver.public_id, date: operatingToday(), status: 'present' };

    expect((await post(cookie, key, body)).status).toBe(201);
    expect(await windowHours(user.id, key)).toBe(DAY_HOURS);
    await age(user.id, key, 3);
    const later = await post(cookie, key, body);
    expect(later.headers['idempotent-replayed']).toBeUndefined();
  });

  test('keys stay per user: another driver reusing a key on /fuel-logs is not answered with the first one\'s record', async () => {
    const s = await setups();
    const other = await driverSignIn(s.depot);
    const key = `k-${randomUUID()}`;
    const mine = await send('/fuel-logs', s.driver.cookie, key, s.cases[0].body);
    const theirs = await send('/fuel-logs', other.cookie, key, s.cases[0].body);

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(theirs.body.data.id).not.toBe(mine.body.data.id);
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
