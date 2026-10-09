import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { operatingToday } from '../../src/modules/fleet/domain/attendance';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createUser, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Attendance-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return login(user.email as string);
}

const api = {
  get: (path: string, cookie = '') => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie = '') => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object, cookie = '') => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie = '') => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

const today = operatingToday();
function shift(days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string; new_values: Record<string, unknown> }>(
    'SELECT action, entity_type, new_values FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

describe('POST /attendance', () => {
  test('records a day: 201, logged_by is the caller, one audit row', async () => {
    const depot = await createDepot();
    const admin = await createUser({ roles: ['depot_admin'], depot, password: PASSWORD, fullName: 'Depot Clerk' });
    const cookie = await login(admin.email as string);
    const { driver } = await createDriver({ depot });

    const res = await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'present' }, cookie);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/attendance/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      driver_id: driver.public_id,
      date: today,
      status: 'present',
      notes: null,
      logged_by: admin.public_id,
      logged_by_name: 'Depot Clerk',
    });
    expect((await auditRows(res)).map((r) => [r.action, r.entity_type])).toEqual([['INSERT', 'fleet.driver_attendance']]);
  });

  test('a second record for the same driver and day is 409 CONFLICT_ATTENDANCE_DUPLICATE', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    expect((await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'present' }, cookie)).status).toBe(201);

    const again = await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'absent' }, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_ATTENDANCE_DUPLICATE');
  });

  test('a dispatcher cannot write attendance: 403', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const res = await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'present' }, await signIn(['dispatcher'], depot));
    expect(res.status).toBe(403);
  });

  test('dates: presence not in the future, leave up to 60 days ahead', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    const future = await api.post('/attendance', { driver_id: driver.public_id, date: shift(1), status: 'present' }, cookie);
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual([{ field: 'date', reason: 'in_future' }]);
    expect((await api.post('/attendance', { driver_id: driver.public_id, date: shift(10), status: 'on_leave' }, cookie)).status).toBe(201);
    expect((await api.post('/attendance', { driver_id: driver.public_id, date: shift(61), status: 'on_leave' }, cookie)).status).toBe(400);
    expect((await api.post('/attendance', { driver_id: driver.public_id, date: shift(-3), status: 'absent' }, cookie)).status).toBe(201);
  });

  test('a driver in another depot is 400 references_missing_record; a retired driver is 409', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver: elsewhere } = await createDriver({ depot: await createDepot() });
    const res = await api.post('/attendance', { driver_id: elsewhere.public_id, date: today, status: 'present' }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'driver_id', reason: 'references_missing_record' }]);

    const { driver: retired } = await createDriver({ depot, is_active: false });
    expect((await api.post('/attendance', { driver_id: retired.public_id, date: today, status: 'present' }, cookie)).status).toBe(409);
  });

  test('a driver records only their own day', async () => {
    const depot = await createDepot();
    const { user, driver } = await createDriver({ depot });
    await pool.query('UPDATE auth.users SET password_hash = (SELECT password_hash FROM auth.users WHERE id = $2) WHERE id = $1', [
      user.id,
      (await createUser({ password: PASSWORD })).id,
    ]);
    const cookie = await login(user.email as string);
    const { driver: colleague } = await createDriver({ depot });

    expect((await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'late' }, cookie)).status).toBe(201);
    expect((await api.post('/attendance', { driver_id: colleague.public_id, date: today, status: 'present' }, cookie)).status).toBe(400);
    const roster = await api.get('/attendance', cookie);
    expect(roster.body.data.map((r: { driver_id: string }) => r.driver_id)).toEqual([driver.public_id]);
  });
});

describe('PUT and PATCH /attendance/{id}', () => {
  test('PUT updates the status and writes a new audit row', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    const created = await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'present' }, cookie);

    const res = await api.put(`/attendance/${created.body.data.id}`, { status: 'absent', notes: 'Called in sick' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'absent', notes: 'Called in sick' });
    const audit = await auditRows(res);
    expect(audit.map((r) => [r.action, r.entity_type])).toEqual([['UPDATE', 'fleet.driver_attendance']]);
    expect(audit[0].new_values).toMatchObject({ status: 'absent' });

    const patched = await api.patch(`/attendance/${created.body.data.id}`, { notes: null }, cookie);
    expect(patched.body.data).toMatchObject({ status: 'absent', notes: null });
  });

  test('another depot is 404; a dispatcher is 403; a future day cannot become present', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    const leave = await api.post('/attendance', { driver_id: driver.public_id, date: shift(5), status: 'on_leave' }, cookie);
    const id = leave.body.data.id;

    expect((await api.put(`/attendance/${id}`, { status: 'present' }, cookie)).status).toBe(400);
    expect((await api.put(`/attendance/${id}`, { status: 'present' }, await signIn(['depot_admin'], await createDepot()))).status).toBe(404);
    expect((await api.put(`/attendance/${id}`, { status: 'present' }, await signIn(['dispatcher'], depot))).status).toBe(403);
    expect((await api.get(`/attendance/${id}`, await signIn(['dispatcher'], depot))).status).toBe(200);
  });
});

describe('GET /attendance (the day roster)', () => {
  test("date=today lists every driver of the depot admin's depot, marked or not, and none from other depots", async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver: marked } = await createDriver({ depot });
    const { driver: unmarked } = await createDriver({ depot });
    const { driver: foreign } = await createDriver({ depot: other });
    const { driver: retired } = await createDriver({ depot, is_active: false });
    await api.post('/attendance', { driver_id: marked.public_id, date: today, status: 'absent' }, cookie);

    const res = await api.get('/attendance?date=today&page_size=100', cookie);
    expect(res.status).toBe(200);
    expect(res.body.meta.date).toBe(today);
    const byId = new Map(res.body.data.map((r: { driver_id: string }) => [r.driver_id, r]));
    expect([...byId.keys()].sort()).toEqual([marked.public_id, unmarked.public_id].sort());
    expect(byId.has(foreign.public_id)).toBe(false);
    expect(byId.has(retired.public_id)).toBe(false);
    expect(byId.get(marked.public_id)).toMatchObject({ depot_id: depot.public_id, attendance: { status: 'absent' } });
    expect(byId.get(unmarked.public_id)).toMatchObject({ attendance: null });

    const onlyUnmarked = await api.get('/attendance?status=unmarked&page_size=100', cookie);
    expect(onlyUnmarked.body.data.map((r: { driver_id: string }) => r.driver_id)).toEqual([unmarked.public_id]);
    expect((await api.get(`/attendance?depot_id=${other.public_id}`, cookie)).body.data).toEqual([]);
    expect((await api.get('/attendance?date=yesterday', cookie)).status).toBe(400);
  });

  test("an absent driver carries today's attendance in the driver list, for the dispatcher's warning", async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'absent' }, cookie);

    const list = await api.get(`/drivers?depot_id=${depot.public_id}`, await signIn(['dispatcher'], depot));
    expect(list.body.data.find((d: { id: string }) => d.id === driver.public_id)).toMatchObject({ attendance_today: 'absent' });
  });
});

describe('attendance events', () => {
  const seen: DomainEvent[] = [];
  let off: () => void;
  beforeAll(() => {
    off = eventBus.subscribe('AttendanceRecorded', (e) => void seen.push(e));
  });
  afterAll(() => off());
  beforeEach(() => {
    seen.length = 0;
  });

  test('create and update each publish AttendanceRecorded with the previous status', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    const created = await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'present' }, cookie);
    await api.put(`/attendance/${created.body.data.id}`, { status: 'on_leave' }, cookie);
    await api.post('/attendance', { driver_id: driver.public_id, date: today, status: 'absent' }, cookie); // 409: nothing

    expect(seen.map((e) => [e.payload.status, e.payload.previous_status])).toEqual([
      ['present', null],
      ['on_leave', 'present'],
    ]);
  });
});
