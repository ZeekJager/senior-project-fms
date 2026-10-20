import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Lifecycle-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string };

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  return login((await createUser({ roles, depot, password: PASSWORD })).email);
}

/** A driver of the depot who can sign in, licensed for trucks. */
async function driverWithLogin(depot: Depot, extra: Record<string, unknown> = {}) {
  const { user, driver } = await createDriver({ depot, license_categories: ['C'], ...extra });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { user, driver, cookie: () => login(user.email) };
}

const HOUR = 60 * 60 * 1000;

/** A trip on a depot route, written directly in the given state. */
async function trip(depot: Depot, fields: Record<string, unknown>): Promise<Row> {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Lifecycle ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
  const start = new Date(Date.now() + HOUR);
  const row = { route_id: route.id, status: 'assigned', scheduled_start: start, scheduled_end: new Date(start.getTime() + 2 * HOUR), ...fields };
  const keys = Object.keys(row);
  const res = await pool.query<Row>(
    `INSERT INTO trip.trips (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return res.rows[0];
}

/** A depot with a dispatcher, a truck, a driver who can sign in, and an assigned trip starting in an hour. */
async function setup() {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot });
  const driver = await driverWithLogin(depot);
  const assigned = await trip(depot, { vehicle_id: vehicle.id, driver_id: driver.driver.id });
  return { depot, vehicle, driver, assigned, dispatcher: await signIn(['dispatcher'], depot) };
}

const command = (cookie: string, t: Row, path: 'start' | 'end' | 'status', body: object = {}) =>
  request(app).post(`/api/v1/trips/${t.public_id}/${path}`).set('Cookie', cookie).send(body);

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [
    res.headers['x-request-id'],
  ]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

describe('POST /trips/{id}/start', () => {
  test('assigned → en_route: actual_start recorded, audited, TripStarted published, the vehicle shows the trip under way', async () => {
    const s = await setup();
    const before = Date.now();
    const res = await command(s.dispatcher, s.assigned, 'start');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'en_route', version: 1, actual_end: null });
    expect(new Date(res.body.data.actual_start).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(res.body.meta.warnings).toEqual([]);
    expect(res.headers.etag).toBe('"1"');
    expect(await auditRows(res)).toEqual(['UPDATE trip.trips']);

    const [event] = await publishedEvents('TripStarted');
    expect(event.payload).toMatchObject({
      trip_id: s.assigned.public_id,
      driver_id: s.driver.driver.public_id,
      vehicle_id: s.vehicle.public_id,
      depot_id: s.depot.public_id,
      actual_start: res.body.data.actual_start,
    });
    expect(event.aggregate).toBe(`trip:${s.assigned.public_id}`);
    // Fleet's read model follows inside the same transaction.
    const status = await request(app).get(`/api/v1/vehicles/${s.vehicle.public_id}/status`).set('Cookie', s.dispatcher);
    expect(status.body.data.current_assignment).toMatchObject({ trip_id: s.assigned.public_id, status: 'en_route' });
  });

  test('starting a scheduled trip is 409 with the transitions allowed from scheduled', async () => {
    const s = await setup();
    const scheduled = await trip(s.depot, { status: 'scheduled' });
    const res = await command(s.dispatcher, scheduled, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_INVALID_STATE_TRANSITION',
      details: [{ field: 'status', reason: 'scheduled_to_en_route', allowed_transitions: ['assigned', 'cancelled'] }],
    });
  });

  test('the assignment rules are read again: a vehicle flagged since cannot start (BR-2); an expired licence blocks', async () => {
    const s = await setup();
    await pool.query('UPDATE fleet.vehicles SET maintenance_flag = TRUE WHERE id = $1', [s.vehicle.id]);
    const flagged = await command(s.dispatcher, s.assigned, 'start');
    expect(flagged.status).toBe(409);
    expect(flagged.body.error.code).toBe('CONFLICT_VEHICLE_FLAGGED');

    const other = await setup();
    await pool.query("UPDATE fleet.drivers SET license_expiry = '2020-01-01' WHERE id = $1", [other.driver.driver.id]);
    const expired = await command(other.dispatcher, other.assigned, 'start');
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({ code: 'CONFLICT_DRIVER_NOT_ELIGIBLE', details: [{ field: 'driver_id', reason: 'license_expired' }] });
    expect(await publishedEvents('TripStarted')).toEqual([]);
  });

  test('another trip of the driver still under way: the start goes ahead with PREVIOUS_TRIP_OVERRUN', async () => {
    const s = await setup();
    const earlier = await trip(s.depot, {
      status: 'en_route',
      vehicle_id: (await createVehicle({ depot: s.depot })).id,
      driver_id: s.driver.driver.id,
      scheduled_start: new Date(Date.now() - 3 * HOUR),
      scheduled_end: new Date(Date.now() - 2 * HOUR),
      actual_start: new Date(Date.now() - 3 * HOUR),
    });
    const res = await command(s.dispatcher, s.assigned, 'start');
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings).toEqual([{ warning: 'PREVIOUS_TRIP_OVERRUN', field: 'driver_id', trip_id: earlier.public_id, expected_end: expect.any(String) }]);
  });
});

describe('POST /trips/{id}/end', () => {
  test('en_route → completed: actual_end recorded after actual_start, duration kept, TripCompleted, the vehicle is free', async () => {
    const s = await setup();
    const started = await command(s.dispatcher, s.assigned, 'start');
    const res = await command(s.dispatcher, s.assigned, 'end');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'completed', version: 2 });
    expect(new Date(res.body.data.actual_end).getTime()).toBeGreaterThanOrEqual(new Date(started.body.data.actual_start).getTime());
    const stored = await pool.query('SELECT actual_duration_seconds FROM trip.trips WHERE id = $1', [s.assigned.id]);
    expect(stored.rows[0].actual_duration_seconds).toBeGreaterThanOrEqual(0);

    const [event] = await publishedEvents('TripCompleted');
    expect(event.payload).toMatchObject({ trip_id: s.assigned.public_id, actual_start: started.body.data.actual_start, actual_end: res.body.data.actual_end, duration_seconds: expect.any(Number) });
    const status = await request(app).get(`/api/v1/vehicles/${s.vehicle.public_id}/status`).set('Cookie', s.dispatcher);
    expect(status.body.data).toMatchObject({ current_assignment: null, availability: { availability: 'available' } });
  });

  test('ending a trip that has not started is 409 with what it can do instead', async () => {
    const s = await setup();
    const res = await command(s.dispatcher, s.assigned, 'end');
    expect(res.body.error.details).toEqual([{ field: 'status', reason: 'assigned_to_completed', allowed_transitions: ['en_route', 'cancelled'] }]);
  });
});

describe('POST /trips/{id}/status', () => {
  test('completed and cancelled are terminal: every command is 409 with no allowed transitions', async () => {
    const s = await setup();
    const done = await trip(s.depot, { status: 'completed', vehicle_id: s.vehicle.id, driver_id: s.driver.driver.id, scheduled_start: new Date(Date.now() - 5 * HOUR), scheduled_end: new Date(Date.now() - 4 * HOUR) });
    const cancelled = await trip(s.depot, { status: 'cancelled' });
    for (const t of [done, cancelled]) {
      for (const [path, body] of [['start', {}], ['end', {}], ['status', { status: 'cancelled' }], ['status', { status: 'scheduled' }]] as const) {
        const res = await command(s.dispatcher, t, path, body);
        expect(res.status, `${t.status} ${path} ${JSON.stringify(body)}`).toBe(409);
        expect(res.body.error.details[0].allowed_transitions).toEqual([]);
      }
    }
  });

  test('en_route and completed are start and end; assigned needs POST /assign', async () => {
    const s = await setup();
    expect((await command(s.dispatcher, s.assigned, 'status', { status: 'en_route' })).body.data.status).toBe('en_route');
    expect((await command(s.dispatcher, s.assigned, 'status', { status: 'completed' })).body.data.status).toBe('completed');
    expect((await publishedEvents('TripStarted', 'TripCompleted')).map((e) => e.type)).toEqual(['TripStarted', 'TripCompleted']);

    const scheduled = await trip(s.depot, { status: 'scheduled' });
    const assign = await command(s.dispatcher, scheduled, 'status', { status: 'assigned' });
    expect(assign.status).toBe(409);
    expect(assign.body.error.details).toEqual([{ field: 'status', reason: 'assign_required', allowed_transitions: ['assigned', 'cancelled'] }]);
  });

  test('a draft with both times can be scheduled; without them it cannot', async () => {
    const s = await setup();
    const ready = await trip(s.depot, { status: 'draft' });
    const res = await command(s.dispatcher, ready, 'status', { status: 'scheduled' });
    expect(res.body.data.status).toBe('scheduled');
    expect((await publishedEvents('TripUpdated'))[0].payload).toEqual({ trip_id: ready.public_id, changed_fields: ['status'], status: 'scheduled' });

    const bare = await trip(s.depot, { status: 'draft', scheduled_start: null, scheduled_end: null });
    expect((await command(s.dispatcher, bare, 'status', { status: 'scheduled' })).body.error.details).toEqual([
      { field: 'status', reason: 'schedule_required', allowed_transitions: ['scheduled', 'cancelled'] },
    ]);
  });

  test('cancel from draft, scheduled or assigned publishes TripCancelled; a trip under way cannot be cancelled', async () => {
    const s = await setup();
    const res = await command(s.dispatcher, s.assigned, 'status', { status: 'cancelled' });
    expect(res.body.data.status).toBe('cancelled');
    expect((await publishedEvents('TripCancelled'))[0].payload).toMatchObject({ trip_id: s.assigned.public_id, previous_status: 'assigned', vehicle_id: s.vehicle.public_id });

    const other = await setup();
    await command(other.dispatcher, other.assigned, 'start');
    expect((await command(other.dispatcher, other.assigned, 'status', { status: 'cancelled' })).body.error.details).toEqual([
      { field: 'status', reason: 'en_route_to_cancelled', allowed_transitions: ['completed'] },
    ]);
  });

  test('an unknown status, or draft, is 400', async () => {
    const s = await setup();
    expect((await command(s.dispatcher, s.assigned, 'status', { status: 'draft' })).status).toBe(400);
    expect((await command(s.dispatcher, s.assigned, 'status', { status: 'paused' })).status).toBe(400);
  });
});

describe('who may move a trip', () => {
  test('a driver starts and ends their own trip; another driver gets 404; a driver cannot cancel', async () => {
    const s = await setup();
    const own = await s.driver.cookie();
    expect((await command(own, s.assigned, 'start')).body.data.status).toBe('en_route');
    expect((await command(own, s.assigned, 'end')).body.data.status).toBe('completed');

    const another = await driverWithLogin(s.depot);
    const theirs = await trip(s.depot, { vehicle_id: (await createVehicle({ depot: s.depot })).id, driver_id: another.driver.id });
    expect((await command(own, theirs, 'start')).status).toBe(404);
    const cancel = await command(await another.cookie(), theirs, 'status', { status: 'cancelled' });
    expect(cancel.status).toBe(403);
    expect(cancel.body.error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE');
  });

  test('trip:execute is needed (a depot admin gets 403); a stale If-Match is 409; a body on start is 400', async () => {
    const s = await setup();
    expect((await command(await signIn(['depot_admin'], s.depot), s.assigned, 'start')).status).toBe(403);
    const stale = await request(app).post(`/api/v1/trips/${s.assigned.public_id}/start`).set('Cookie', s.dispatcher).set('If-Match', '"7"').send({});
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
    expect((await command(s.dispatcher, s.assigned, 'start', { actual_start: '2026-01-01T00:00:00Z' })).status).toBe(400);
  });

  test('a retried start with the same Idempotency-Key replays the first answer, not a second move', async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await request(app).post(`/api/v1/trips/${s.assigned.public_id}/start`).set('Cookie', s.dispatcher).set('Idempotency-Key', key).send({});
    const again = await request(app).post(`/api/v1/trips/${s.assigned.public_id}/start`).set('Cookie', s.dispatcher).set('Idempotency-Key', key).send({});
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect(await publishedEvents('TripStarted')).toHaveLength(1);
  });
});
