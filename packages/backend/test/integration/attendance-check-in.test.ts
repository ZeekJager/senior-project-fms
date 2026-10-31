import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { operatingToday } from '../../src/modules/fleet/domain/attendance';
import { attendanceCodeKey, issueCode } from '../../src/modules/fleet/domain/attendance-code';
import { createDepot, createDriver, createUser, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

// Driver attendance by QR scan (FMS-141): the depot screen's code, a driver's check-in and check-out with it,
// what is refused, and the times entered by hand.

const app = createApp();
const PASSWORD = 'Attendance-Test-2';

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

/** A driver of the depot, signed in. */
async function driverOf(depot: Depot) {
  const { user, driver } = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = (SELECT password_hash FROM auth.users WHERE id = $2) WHERE id = $1', [
    user.id,
    (await createUser({ password: PASSWORD })).id,
  ]);
  return { user, driver, cookie: await login(user.email as string) };
}

const api = {
  get: (path: string, cookie = '') => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie = '') => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie = '') => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** The depot screen's code now, as a depot admin of it sees it. */
async function codeOf(depot: Depot): Promise<string> {
  const res = await api.get('/attendance/qr', await signIn(['depot_admin'], depot));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.code;
}

/** Every check-in is late (the day starts at midnight, no grace), or none is (it starts at 23:59). */
const setDay = (depot: Depot, start: string, grace = 0) =>
  pool.query('UPDATE fleet.depots SET work_starts_at = $2, late_after_minutes = $3 WHERE id = $1', [depot.id, start, grace]);

const auditOf = async (res: Response) =>
  (await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [res.headers['x-request-id']]))
    .rows;

describe('GET /attendance/qr', () => {
  test('the depot’s code, its window and the depot’s rules; not cached; never for a driver', async () => {
    const depot = await createDepot();
    const dispatcher = await signIn(['dispatcher'], depot);
    const res = await api.get('/attendance/qr', dispatcher);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ depot_id: depot.public_id, depot_name: depot.name, work_starts_at: '08:00', late_after_minutes: 15 });
    expect(res.body.data.code).toMatch(new RegExp(`^FMSA1\\.${depot.public_id}\\.`));
    expect(Date.parse(res.body.data.expires_at) - Date.parse(res.body.data.issued_at)).toBe(60_000);

    const { cookie } = await driverOf(depot);
    expect((await api.get('/attendance/qr', cookie)).status).toBe(403);
    // Someone over every depot names one; another depot is outside a dispatcher's scope.
    expect((await api.get('/attendance/qr', await signIn(['fleet_manager']))).body.error.details).toEqual([{ field: 'depot_id', reason: 'required' }]);
    const other = await createDepot();
    expect((await api.get(`/attendance/qr?depot_id=${other.public_id}`, dispatcher)).status).toBe(400);
  });
});

describe('POST /attendance/check-in', () => {
  test('a scan of the depot’s code checks the driver in, present, with the time; audited and published', async () => {
    const depot = await createDepot();
    await setDay(depot, '23:59');
    const { driver, cookie } = await driverOf(depot);
    const before = Date.now();

    const res = await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      action: 'checked_in',
      attendance: { driver_id: driver.public_id, date: operatingToday(), status: 'present', check_in_method: 'qr', check_out_at: null, check_out_method: null },
    });
    expect(Date.parse(res.body.data.attendance.check_in_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(await auditOf(res)).toEqual([{ action: 'INSERT', entity_type: 'fleet.driver_attendance' }]);
    const event = (await publishedEvents('AttendanceRecorded')).find((e) => e.correlation_id === res.headers['x-request-id']);
    expect(event).toMatchObject({ type: 'AttendanceRecorded', payload: { status: 'present', check_in_method: 'qr', previous_status: null } });

    // The roster shows it: the time and that it came from a scan.
    const roster = await api.get(`/attendance?driver_id=${driver.public_id}`, await signIn(['depot_admin'], depot));
    expect(roster.body.data[0].attendance).toMatchObject({ status: 'present', check_in_method: 'qr', check_in_at: res.body.data.attendance.check_in_at });
  });

  test('after the depot’s start and grace the driver is late; a day marked absent by hand is checked in by the scan', async () => {
    const depot = await createDepot();
    await setDay(depot, '00:00');
    const { driver, cookie } = await driverOf(depot);
    const admin = await signIn(['depot_admin'], depot);
    expect((await api.post('/attendance', { driver_id: driver.public_id, date: operatingToday(), status: 'absent' }, admin)).status).toBe(201);

    const res = await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie);
    expect(res.body.data).toMatchObject({ action: 'checked_in', attendance: { status: 'late', check_in_method: 'qr' } });
  });

  test('the next scan checks out; one moments after checking in, or after checking out, is a duplicate', async () => {
    const depot = await createDepot();
    const { driver, cookie } = await driverOf(depot);
    expect((await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie)).status).toBe(200);

    const again = await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CONFLICT_ATTENDANCE_DUPLICATE', details: [{ field: 'code', reason: 'just_checked_in' }] });

    // Checked in 20 minutes ago.
    await pool.query(
      `UPDATE fleet.driver_attendance SET check_in_at = check_in_at - interval '20 minutes' WHERE driver_id = $1`,
      [driver.id],
    );
    const out = await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ action: 'checked_out', attendance: { check_out_method: 'qr' } });
    expect(out.body.data.attendance.check_out_at).not.toBeNull();

    const third = await api.post('/attendance/check-in', { code: await codeOf(depot) }, cookie);
    expect(third.status).toBe(409);
    expect(third.body.error.details).toEqual([{ field: 'code', reason: 'already_checked_out' }]);
  });

  test('an expired code, another depot’s code and a forged one are refused, and nothing is recorded', async () => {
    const [depot, other] = [await createDepot(), await createDepot()];
    const { driver, cookie } = await driverOf(depot);
    const key = attendanceCodeKey(config.jwtSecret);

    const expired = issueCode(key, depot.public_id as string, new Date(Date.now() - 90_000)).code;
    const res = await api.post('/attendance/check-in', { code: expired }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'code', reason: 'expired' }]);

    const elsewhere = await api.post('/attendance/check-in', { code: await codeOf(other) }, cookie);
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.error.details).toEqual([{ field: 'code', reason: 'other_depot' }]);

    const forged = issueCode(attendanceCodeKey('f'.repeat(40)), depot.public_id as string, new Date()).code;
    expect((await api.post('/attendance/check-in', { code: forged }, cookie)).body.error.details).toEqual([{ field: 'code', reason: 'invalid' }]);

    const rows = await pool.query('SELECT 1 FROM fleet.driver_attendance WHERE driver_id = $1', [driver.id]);
    expect(rows.rowCount).toBe(0);
  });

  test('only a driver scans: staff have no attendance:check-in', async () => {
    const depot = await createDepot();
    const code = await codeOf(depot);
    for (const role of ['depot_admin', 'dispatcher', 'fleet_manager'] as RoleName[]) {
      expect((await api.post('/attendance/check-in', { code }, await signIn([role], depot))).status, role).toBe(403);
    }
  });
});

describe('check-in and check-out by hand', () => {
  test('staff record them as manual; a check-in time alone makes the day present or late', async () => {
    const depot = await createDepot();
    await setDay(depot, '00:00');
    const { driver } = await driverOf(depot);
    const admin = await signIn(['depot_admin'], depot);
    const at = new Date(Date.now() - 60_000).toISOString();
    const created = await api.post('/attendance', { driver_id: driver.public_id, date: operatingToday(), check_in_at: at }, admin);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'late', check_in_method: 'manual', check_in_at: at });

    const out = await api.patch(`/attendance/${created.body.data.id}`, { check_out_at: new Date().toISOString() }, admin);
    expect(out.body.data).toMatchObject({ status: 'late', check_out_method: 'manual' });
    const before = await api.patch(`/attendance/${created.body.data.id}`, { check_out_at: new Date(Date.parse(at) - 60_000).toISOString() }, admin);
    expect(before.body.error.details).toEqual([{ field: 'check_out_at', reason: 'before_check_in' }]);
  });

  test('a driver cannot type their own times: 403, even for their own day', async () => {
    const depot = await createDepot();
    const { driver, cookie } = await driverOf(depot);
    const res = await api.post('/attendance', { driver_id: driver.public_id, date: operatingToday(), status: 'present', check_in_at: new Date().toISOString() }, cookie);
    expect(res.status).toBe(403);
    const plain = await api.post('/attendance', { driver_id: driver.public_id, date: operatingToday(), status: 'present' }, cookie);
    expect(plain.status).toBe(201);
    expect((await api.patch(`/attendance/${plain.body.data.id}`, { check_in_at: new Date().toISOString() }, cookie)).status).toBe(403);
  });
});

describe('depot start time and grace', () => {
  test('set through the depot API, shown on the depot', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const res = await api.patch(`/depots/${depot.public_id}`, { work_starts_at: '06:30', late_after_minutes: 10 }, admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ work_starts_at: '06:30', late_after_minutes: 10 });
    expect((await api.patch(`/depots/${depot.public_id}`, { work_starts_at: '6:30' }, admin)).status).toBe(400);
  });
});
