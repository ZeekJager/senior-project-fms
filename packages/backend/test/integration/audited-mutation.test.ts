import { describe, expect, test } from 'vitest';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { auditLogMiddleware } from '../../src/middleware/auditLog';
import { requestContext } from '../../src/middleware/requestContext';
import { createUser } from '../support/factories';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fakeRequest(): Request {
  const req = { headers: {} } as Request;
  const next: NextFunction = () => {};
  requestContext(req, { setHeader: () => undefined } as unknown as Response, next);
  auditLogMiddleware(req, {} as Response, next);
  return req;
}

/** Signs in over HTTP and returns the session cookies for the next request. */
async function loginCookie(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Correct-Horse-7' });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function auditRows(correlationId: string) {
  const res = await pool.query(
    `SELECT entity_type, action, old_values IS NOT NULL AS has_old, new_values IS NOT NULL AS has_new
       FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id`,
    [correlationId],
  );
  return res.rows as { entity_type: string; action: string; has_old: boolean; has_new: boolean }[];
}

describe('req.dbMutate', () => {
  test('correlation id is a UUID', () => {
    expect(fakeRequest().correlationId).toMatch(UUID);
  });

  test('INSERT, UPDATE and soft DELETE on fleet.depots, each audited', async () => {
    const req = fakeRequest();
    const inserted = await req.dbMutate('fleet.depots', 'INSERT', null, { name: 'IT Depot', location: 'Addis Ababa' });
    expect(inserted.name).toBe('IT Depot');

    const id = inserted.id as string;
    expect((await req.dbMutate('fleet.depots', 'UPDATE', id, { location: 'Adama' })).location).toBe('Adama');
    expect((await req.dbMutate('fleet.depots', 'DELETE', id)).is_active).toBe(false);

    const still = await pool.query('SELECT count(*)::int AS n FROM fleet.depots WHERE id = $1', [id]);
    expect(still.rows[0].n, 'soft delete keeps the row').toBe(1);

    const rows = await auditRows(req.correlationId);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(rows.every((r) => r.entity_type === 'fleet.depots')).toBe(true);
    expect([rows[0].has_old, rows[0].has_new]).toEqual([false, true]);
    expect([rows[1].has_old, rows[1].has_new]).toEqual([true, true]);
  });

  test('DELETE on auth.users deactivates through status', async () => {
    const req = fakeRequest();
    const user = await req.dbMutate('auth.users', 'INSERT', null, { email: 'it@example.com', password_hash: 'x', full_name: 'IT' });
    const deactivated = await req.dbMutate('auth.users', 'DELETE', user.id as string);
    expect(deactivated.status).toBe('inactive');
    expect(deactivated.is_active).toBe(false);
  });

  test('password hashes are redacted in audit rows', async () => {
    const req = fakeRequest();
    const user = await req.dbMutate('auth.users', 'INSERT', null, { email: 'hash@example.com', password_hash: 'x', full_name: 'IT' });
    await req.dbMutate('auth.users', 'UPDATE', user.id as string, { full_name: 'Renamed' });
    const res = await pool.query(
      'SELECT old_values, new_values FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
      [req.correlationId],
    );
    expect(res.rows.map((r) => r.new_values.password_hash)).toEqual(['[REDACTED]', '[REDACTED]']);
    expect(res.rows[1].old_values.password_hash).toBe('[REDACTED]');
    expect(res.rows[1].new_values.full_name).toBe('Renamed');
  });

  test('a failed mutation rolls back and writes no audit row', async () => {
    const req = fakeRequest();
    await expect(req.dbMutate('fleet.depots', 'INSERT', null, { name: 'missing location' })).rejects.toThrow();
    expect(await auditRows(req.correlationId)).toHaveLength(0);
  });

  test('unsafe identifiers are rejected before reaching SQL', async () => {
    const req = fakeRequest();
    await expect(req.dbMutate('depots', 'INSERT', null, { name: 'x', location: 'y' })).rejects.toThrow(/Invalid table name/);
    await expect(req.dbMutate('fleet.depots; DROP TABLE fleet.depots', 'INSERT', null, {})).rejects.toThrow(/Invalid table name/);
    await expect(req.dbMutate('fleet.depots', 'INSERT', null, { 'name) VALUES (1); --': 'x' })).rejects.toThrow(/Invalid column name/);
  });
});

describe('audit trail is append-only for the app role', () => {
  test.each([
    "UPDATE audit.audit_logs SET action = 'x'",
    "DELETE FROM audit.audit_logs WHERE action = 'x'",
    'TRUNCATE audit.audit_logs',
  ])('%s is refused', async (sql) => {
    await expect(pool.query(sql)).rejects.toThrow(/permission denied/);
  });
});

describe('composition root', () => {
  test('GET /health/ready', async () => {
    const res = await request(createApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('fleet module route POST /api/v1/depots is mounted, audited and needs depot:write', async () => {
    const app = createApp();

    const anonymous = await request(app).post('/api/v1/depots').send({ name: 'X', location: 'Y' });
    expect(anonymous.status).toBe(401);

    const driver = await createUser({ roles: ['driver'], password: 'Correct-Horse-7' });
    const driverCookie = await loginCookie(app, driver.email as string);
    expect((await request(app).post('/api/v1/depots').set('Cookie', driverCookie).send({ name: 'X', location: 'Y' })).status).toBe(403);

    const admin = await createUser({ roles: ['admin'], password: 'Correct-Horse-7' });
    const res = await request(app)
      .post('/api/v1/depots')
      .set('Cookie', await loginCookie(app, admin.email as string))
      .send({ name: 'Audit Depot', location: 'Addis Ababa' });
    expect(res.status).toBe(201);
    expect(await auditRows(res.headers['x-request-id'] as string)).toHaveLength(1);
  });
});
