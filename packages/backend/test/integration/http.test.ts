// Requires a migrated database and the runtime role, like the other integration tests.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { errorHandler } from '../../src/middleware/errorHandler';
import { requestContext } from '../../src/middleware/requestContext';
import { asyncHandler } from '../../src/shared/http/async-handler';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Envelope {
  error: { code: string; message: string; details?: { field?: string; reason: string }[]; stack?: string };
  meta: { request_id: string; timestamp: string };
}

const servers: Server[] = [];
async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await pool.end();
});

describe('request ids', () => {
  let base: string;
  before(async () => {
    base = await serve(createApp());
  });

  test('a client UUID in X-Request-Id is echoed back', async () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const res = await fetch(`${base}/health/live`, { headers: { 'X-Request-Id': id } });
    assert.equal(res.headers.get('x-request-id'), id);
  });

  test("a non-UUID value such as 'abc' is replaced by a generated UUID", async () => {
    const res = await fetch(`${base}/health/live`, { headers: { 'X-Request-Id': 'abc' } });
    assert.match(res.headers.get('x-request-id') ?? '', UUID);
  });

  test('error responses carry the same id in the header and in meta.request_id', async () => {
    const res = await fetch(`${base}/api/v1/no-such-route`);
    const body = (await res.json()) as Envelope;
    assert.equal(body.meta.request_id, res.headers.get('x-request-id'));
  });
});

describe('error envelope', () => {
  let base: string;
  before(async () => {
    base = await serve(createApp());
  });

  test('unknown route returns 404 NOT_FOUND as JSON', async () => {
    const res = await fetch(`${base}/api/v1/no-such-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(!Number.isNaN(Date.parse(body.meta.timestamp)));
  });

  test('malformed JSON returns 400 VALIDATION_FAILED', async () => {
    const res = await fetch(`${base}/api/v1/test-audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(body.error.details, [{ reason: 'malformed_json' }]);
  });

  test('a body over 1 MB returns 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await fetch(`${base}/api/v1/test-audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(1_100_000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as Envelope).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('database and unexpected errors', () => {
  let base: string;
  const code = `IT-${Date.now()}`;
  before(async () => {
    const app = express();
    app.use(requestContext);
    app.post('/duplicate', asyncHandler(async (_req, res) => {
      await pool.query("INSERT INTO fleet.depots (name, location, code) VALUES ('A', 'Addis Ababa', $1)", [code]);
      await pool.query("INSERT INTO fleet.depots (name, location, code) VALUES ('B', 'Addis Ababa', $1)", [code]);
      res.json({ unreachable: true });
    }));
    app.get('/boom', () => {
      throw new Error('internal detail: password=hunter2');
    });
    app.use(errorHandler);
    base = await serve(app);
  });

  test('a real unique violation becomes 409 with the column but not the value', async () => {
    const res = await fetch(`${base}/duplicate`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error.code, 'CONFLICT_DUPLICATE');
    assert.deepEqual(body.error.details, [{ field: 'code', reason: 'already_exists' }]);
    assert.ok(!JSON.stringify(body).includes(code));
  });

  test('an unexpected error returns a generic 500 without internals', async () => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as Envelope;
    assert.equal(body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(body.error.message, 'An unexpected error occurred.');
    assert.ok(!body.error.message.includes('hunter2'));
    // The stack (which names the error) is returned only in development.
    assert.equal(body.error.stack !== undefined, config.nodeEnv === 'development');
  });

  test('every constraint the error mapper names exists in the migrated schema', async () => {
    const names = [
      'uq_fleet_vehicle_registration',
      'drivers_license_number_key',
      'driver_attendance_driver_id_attendance_date_key',
      'ex_trip_driver_overlap',
      'ex_trip_vehicle_overlap',
    ];
    const res = await pool.query('SELECT conname FROM pg_constraint WHERE conname = ANY($1)', [names]);
    assert.deepEqual(res.rows.map((r) => r.conname).sort(), [...names].sort());
  });
});

describe('health', () => {
  test('ready is 200 with the database reachable', async () => {
    const base = await serve(createApp());
    const res = await fetch(`${base}/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { checks: Record<string, string> }).checks, { database: 'ok' });
  });

  test('ready is 503 when the database check fails', async () => {
    const base = await serve(createApp({ readinessChecks: { database: () => Promise.reject(new Error('down')) } }));
    const res = await fetch(`${base}/health/ready`);
    assert.equal(res.status, 503);
  });
});
