// Requires a migrated database and the runtime role (DB_USER=fms_app), as
// set up by CI's backend-ci job or `make dev` + `make migrate`.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { auditLogMiddleware } from '../../src/middleware/auditLog';
import { requestContext } from '../../src/middleware/requestContext';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fakeRequest(): Request {
  const req = {} as Request;
  const next: NextFunction = () => {};
  requestContext(req, {} as Response, next);
  auditLogMiddleware(req, {} as Response, next);
  return req;
}

async function auditRows(correlationId: string) {
  const res = await pool.query(
    `SELECT entity_type, action, old_values IS NOT NULL AS has_old, new_values IS NOT NULL AS has_new
       FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id`,
    [correlationId],
  );
  return res.rows as { entity_type: string; action: string; has_old: boolean; has_new: boolean }[];
}

after(async () => {
  await pool.end();
});

describe('req.dbMutate', () => {
  const req = fakeRequest();
  const suffix = Date.now();

  test('correlation id is a UUID', () => {
    assert.match(req.correlationId, UUID);
  });

  test('INSERT, UPDATE and soft DELETE on fleet.depots, each audited', async () => {
    const inserted = await req.dbMutate('fleet.depots', 'INSERT', null, { name: `IT Depot ${suffix}`, location: 'Addis Ababa' });
    assert.equal(inserted.name, `IT Depot ${suffix}`);

    const id = inserted.id as string;
    const updated = await req.dbMutate('fleet.depots', 'UPDATE', id, { location: 'Adama' });
    assert.equal(updated.location, 'Adama');

    const deleted = await req.dbMutate('fleet.depots', 'DELETE', id);
    assert.equal(deleted.is_active, false);

    const still = await pool.query('SELECT count(*)::int AS n FROM fleet.depots WHERE id = $1', [id]);
    assert.equal(still.rows[0].n, 1, 'soft delete keeps the row');

    const rows = await auditRows(req.correlationId);
    assert.deepEqual(rows.map((r) => r.action), ['INSERT', 'UPDATE', 'DELETE']);
    assert.ok(rows.every((r) => r.entity_type === 'fleet.depots'));
    assert.deepEqual([rows[0].has_old, rows[0].has_new], [false, true]);
    assert.deepEqual([rows[1].has_old, rows[1].has_new], [true, true]);
  });

  test('DELETE on auth.users deactivates through status', async () => {
    const r = fakeRequest();
    const user = await r.dbMutate('auth.users', 'INSERT', null, { email: `it-${suffix}@example.com`, password_hash: 'x', full_name: 'IT' });
    const deactivated = await r.dbMutate('auth.users', 'DELETE', user.id as string);
    assert.equal(deactivated.status, 'inactive');
    assert.equal(deactivated.is_active, false);
  });

  test('a failed mutation rolls back and writes no audit row', async () => {
    const r = fakeRequest();
    await assert.rejects(r.dbMutate('fleet.depots', 'INSERT', null, { name: 'missing location' }));
    assert.equal((await auditRows(r.correlationId)).length, 0);
  });

  test('unsafe identifiers are rejected before reaching SQL', async () => {
    const r = fakeRequest();
    await assert.rejects(r.dbMutate('depots', 'INSERT', null, { name: 'x', location: 'y' }), /Invalid table name/);
    await assert.rejects(r.dbMutate('fleet.depots; DROP TABLE fleet.depots', 'INSERT', null, {}), /Invalid table name/);
    await assert.rejects(r.dbMutate('fleet.depots', 'INSERT', null, { 'name) VALUES (1); --': 'x' }), /Invalid column name/);
  });
});

describe('audit trail is append-only for the app role', () => {
  for (const sql of [
    "UPDATE audit.audit_logs SET action = 'x'",
    "DELETE FROM audit.audit_logs WHERE action = 'x'",
    'TRUNCATE audit.audit_logs',
  ]) {
    test(sql.split(' ')[0], async () => {
      await assert.rejects(pool.query(sql), /permission denied/);
    });
  }
});

describe('composition root', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('GET /api/v1/health', async () => {
    const res = await fetch(`${base}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, 'ok');
  });

  test('fleet module route POST /api/v1/test-audit is mounted and audited', async () => {
    const res = await fetch(`${base}/api/v1/test-audit`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { correlationId: string; deleted: { is_active: boolean } };
    assert.equal(body.deleted.is_active, false);
    assert.equal((await auditRows(body.correlationId)).length, 2);
  });
});
