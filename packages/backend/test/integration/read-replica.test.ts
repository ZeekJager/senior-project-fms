import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { ReadRouter } from '../../src/shared/infrastructure/read-router';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// Read routing (FMS-94) against real connections. Tests run without a replica, so the app's reporting reads use the
// primary; here a second pool to the test database stands in for a replica that answers, and a closed port for one
// that is down. That writes on the primary reach a real replica is checked on the Compose stack (docker-stack job).

const PASSWORD = 'Reads-Test-1';
const answering = new Pool({ ...config.db, max: 1 });
const down = new Pool({ ...config.db, host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500, max: 1 });

afterAll(async () => {
  await answering.end();
  await down.end();
});

async function signIn(roles: RoleName[]): Promise<string> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(createApp()).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

describe('read routing', () => {
  test('a replica that answers serves the session; its lag query runs as fms_app', async () => {
    const router = new ReadRouter(pool, answering, { maxLagSeconds: 30 });
    const session = await router.session();
    const res = await session.query<{ who: string }>('SELECT current_user AS who');
    expect(res.rows).toEqual([{ who: config.db.user }]);
    // Not a standby, so nothing to replay: 0 s behind.
    expect(session.freshness()).toMatchObject({ source: 'replica', lag_seconds: 0 });
    expect(router.state()).toBe('ok');
    await expect(router.ping()).resolves.toBeUndefined();
  });

  test('a replica that is down: reads fall back to the primary and readiness reports it degraded, still 200', async () => {
    const router = new ReadRouter(pool, down, { maxLagSeconds: 30 });
    const session = await router.session();
    expect((await session.query<{ n: number }>('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    expect(session.freshness()).toMatchObject({ source: 'primary', lag_seconds: 0 });

    const res = await request(createApp({ optionalDependencies: { replica: router }, metrics: { replica: () => router.metrics() } })).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { database: 'ok', replica: 'degraded' }, metrics: { replica: { in_use: 0, lag_seconds: -1 } } });
  });
});

describe('data_freshness on reporting reads', () => {
  test('GET /fuel-reconciliation, /vehicles/{id}/fuel-summary and /audit-logs say which database answered', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const owner = await signIn(['fleet_owner']);
    const app = createApp();
    const before = Date.now();

    for (const path of ['/fuel-reconciliation', `/vehicles/${vehicle.public_id}/fuel-summary`, '/audit-logs']) {
      const res = await request(app).get(`/api/v1${path}`).set('Cookie', owner);
      expect(res.status, path).toBe(200);
      expect(res.body.meta.data_freshness, path).toEqual({ source: 'primary', lag_seconds: 0, as_of: expect.any(String) });
      expect(Date.parse(res.body.meta.data_freshness.as_of)).toBeGreaterThanOrEqual(before - 1000);
    }
  });
});
