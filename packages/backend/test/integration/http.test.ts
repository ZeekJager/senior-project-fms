import { describe, expect, test } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { errorHandler } from '../../src/middleware/errorHandler';
import { requestContext } from '../../src/middleware/requestContext';
import { asyncHandler } from '../../src/shared/http/async-handler';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request ids', () => {
  const app = createApp();

  test('a client UUID in X-Request-Id is echoed back', async () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const res = await request(app).get('/health/live').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  test("a non-UUID value such as 'abc' is replaced by a generated UUID", async () => {
    const res = await request(app).get('/health/live').set('X-Request-Id', 'abc');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  test('error responses carry the same id in the header and in meta.request_id', async () => {
    const res = await request(app).get('/api/v1/no-such-route');
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
  });
});

describe('error envelope', () => {
  const app = createApp();

  test('unknown route returns 404 NOT_FOUND as JSON', async () => {
    const res = await request(app).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(Number.isNaN(Date.parse(res.body.meta.timestamp))).toBe(false);
  });

  test('malformed JSON returns 400 VALIDATION_FAILED', async () => {
    const res = await request(app).post('/api/v1/test-audit').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual([{ reason: 'malformed_json' }]);
  });

  test('a body over 1 MB returns 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app).post('/api/v1/test-audit').send({ blob: 'x'.repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('database and unexpected errors', () => {
  const code = `IT-${Date.now()}`;
  const app = express();
  app.use(requestContext);
  app.post(
    '/duplicate',
    asyncHandler(async (_req, res) => {
      await pool.query("INSERT INTO fleet.depots (name, location, code) VALUES ('A', 'Addis Ababa', $1)", [code]);
      await pool.query("INSERT INTO fleet.depots (name, location, code) VALUES ('B', 'Addis Ababa', $1)", [code]);
      res.json({ unreachable: true });
    }),
  );
  app.get('/boom', () => {
    throw new Error('internal detail: password=hunter2');
  });
  app.use(errorHandler);

  test('a real unique violation becomes 409 with the column but not the value', async () => {
    const res = await request(app).post('/duplicate');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE');
    expect(res.body.error.details).toEqual([{ field: 'code', reason: 'already_exists' }]);
    expect(JSON.stringify(res.body)).not.toContain(code);
  });

  test('an unexpected error returns a generic 500 without internals', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred.');
    // The stack (which names the error) is returned only in development.
    expect(res.body.error.stack !== undefined).toBe(config.nodeEnv === 'development');
  });

  test('every constraint the error mapper names exists in the migrated schema', async () => {
    const names = [
      'uq_fleet_vehicle_registration',
      'drivers_license_number_key',
      'driver_attendance_driver_id_attendance_date_key',
      'ex_trip_driver_overlap',
      'ex_trip_vehicle_overlap',
    ];
    const res = await pool.query<{ conname: string }>('SELECT conname FROM pg_constraint WHERE conname = ANY($1)', [names]);
    expect(res.rows.map((r) => r.conname).sort()).toEqual([...names].sort());
  });
});

describe('health', () => {
  test('ready is 200 with the database reachable', async () => {
    const res = await request(createApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'ok' });
  });

  test('ready is 503 when the database check fails', async () => {
    const app = createApp({ readinessChecks: { database: () => Promise.reject(new Error('down')) } });
    expect((await request(app).get('/health/ready')).status).toBe(503);
  });
});
