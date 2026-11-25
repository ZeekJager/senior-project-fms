import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { reportJobsRun } from '../../src/modules/analytics';
import { addisDay } from '../../src/modules/analytics/domain/kpis';
import { createDepot, createDriver, createProvider, createUser, createVehicle, type RoleName } from '../support/factories';
import { smtpSink } from '../support/notification-servers';

// FMS-160: saved report filters, exports over 20,000 rows made in the background, and reports emailed on a schedule.
// A local SMTP server stands in for the email provider; the jobs are run by hand at the times a test needs.

const app = createApp();
const PASSWORD = 'Report-Jobs-Test-1';
const MIN = 60_000;
const DAY = 86_400_000;
const CID = randomUUID();
type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

let smtp: Awaited<ReturnType<typeof smtpSink>>;
beforeAll(async () => {
  smtp = await smtpSink();
  Object.assign(config.integrations.secrets, { 'test-report-smtp': {} });
});
afterAll(() => smtp.close());

const email = () => createProvider({ code: 'test-report-smtp', provider_type: 'notification', configuration: { channel: 'email', host: '127.0.0.1', port: smtp.port, tls: 'none', from: 'FMS Reports <reports@fleet.test>' } });

async function person(roles: RoleName[], depot: Depot | null = null, fullName = 'Test User') {
  const user = (await createUser({ roles, depot, password: PASSWORD, fullName })) as unknown as Row;
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const api = (cookie: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: unknown) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body as object),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
});

/** A depot with a truck, a driver and a route, and a completed trip on each of the last `days` days. */
async function world(days = 10) {
  const depot = await createDepot();
  const { driver } = await createDriver({ depot });
  const truck = (await createVehicle({ depot })) as Row;
  const road = (await pool.query('INSERT INTO trip.routes (name, depot_id, origin_name, destination_name) VALUES ($1, $2, $3, $4) RETURNING *', [`Bole - Adama ${depot.code}`, depot.id, 'Bole', 'Adama'])).rows[0] as Row;
  await pool.query(
    `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, planned_distance_km, actual_distance_km)
     SELECT $1, $2, $3, 'completed', s, s + interval '2 hours', s, s + interval '2 hours', 80, 80
       FROM generate_series(now() - ($4::int * interval '1 day'), now() - interval '1 day', interval '1 day') s`,
    [road.id, truck.id, (driver as Row).id, days],
  );
  return { depot, driver: driver as Row, truck, road };
}

const runsOf = async (cookie: string, scheduleId: string) => (await api(cookie).get(`/reports/schedules/${scheduleId}/runs`)).body.data as Record<string, unknown>[];
const mailsTo = (address: unknown) => smtp.mails.filter((m) => m.to.includes(`<${String(address)}>`));

describe('saved report filters (FMS-160)', () => {
  test('a filter combination is saved by name, listed, refused twice under one name, and deleted only by its owner', async () => {
    const { depot } = await world(1);
    const me = await person(['fleet_manager']);
    const other = await person(['fleet_manager']);
    const filters = { quarter: '2026-Q3', depot_ids: [depot.public_id], vehicle_type: 'truck' };

    const saved = await api(me.cookie).post('/reports/filters', { name: 'Trucks, Q3', filters });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({ name: 'Trucks, Q3', filters: { quarter: '2026-Q3', depot_ids: String(depot.public_id), vehicle_type: 'truck' } });
    // The saved filters drive the report as a query string.
    expect((await api(me.cookie).get(`/reports/trips?${new URLSearchParams(saved.body.data.filters).toString()}`)).status).toBe(200);

    const twice = await api(me.cookie).post('/reports/filters', { name: 'Trucks, Q3', filters: {} });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('CONFLICT_DUPLICATE');
    expect((await api(me.cookie).post('/reports/filters', { name: 'x', filters: { colour: 'red' } })).status).toBe(400);

    expect((await api(me.cookie).get('/reports/filters')).body.data.map((f: { name: string }) => f.name)).toEqual(['Trucks, Q3']);
    expect((await api(other.cookie).get('/reports/filters')).body.data).toEqual([]);
    expect((await api(other.cookie).delete(`/reports/filters/${saved.body.data.id}`)).status).toBe(404);
    expect((await api(me.cookie).delete(`/reports/filters/${saved.body.data.id}`)).status).toBe(204);
    expect((await api(me.cookie).get('/reports/filters')).body.data).toEqual([]);
  });
});

describe('background exports (FMS-160)', () => {
  test('over 20,000 rows the file is made in the background, downloadable by a signed link for 24 hours', { timeout: 120_000 }, async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const truck = (await createVehicle({ depot })) as Row;
    const road = (await pool.query('INSERT INTO trip.routes (name, depot_id, origin_name, destination_name) VALUES ($1, $2, $3, $4) RETURNING *', [`Export ${depot.code}`, depot.id, 'A', 'B'])).rows[0] as Row;
    const day = addisDay(new Date(Date.now() - 20 * DAY));
    // 20,001 trips on one day: one more than a file made at once.
    await pool.query(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, planned_distance_km)
       SELECT $1, $2, $3, 'cancelled', ($4::date + time '06:00') AT TIME ZONE 'Africa/Addis_Ababa' + n * interval '1 second',
              ($4::date + time '07:00') AT TIME ZONE 'Africa/Addis_Ababa' + n * interval '1 second', 10
         FROM generate_series(1, 20001) n`,
      [road.id, truck.id, (driver as Row).id, day],
    );
    const me = await person(['fleet_manager']);
    const other = await person(['fleet_manager']);

    const asked = await api(me.cookie).get(`/reports/trips?from=${day}&to=${day}&vehicle_id=${truck.public_id}&format=xlsx`);
    expect(asked.status).toBe(202);
    expect(asked.body.data).toMatchObject({ report: 'trips', format: 'xlsx', status: 'queued', url: null });
    const id = asked.body.data.id as string;
    expect((await api(other.cookie).get(`/reports/exports/${id}`)).status).toBe(404);

    const now = new Date();
    expect(await reportJobsRun.exports(now, CID)).toMatchObject({ made: 1, failed: 0 });
    const ready = (await api(me.cookie).get(`/reports/exports/${id}`)).body.data;
    expect(ready).toMatchObject({ status: 'ready', rows: 20001 });
    expect(new Date(ready.expires_at).getTime() - now.getTime()).toBe(24 * 3_600_000);
    expect(ready.url).toMatch(/^\/api\/v1\/report-files\/[0-9a-f-]{36}\/content\?expires=\d+&signature=[0-9a-f]+$/);

    // The link needs no session; a changed signature is refused.
    const file = await request(app).get(ready.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect((file.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const forged = await request(app).get(ready.url.replace(/signature=[0-9a-f]+/, 'signature=00'));
    expect([forged.status, forged.body.error.code]).toEqual([401, 'AUTH_TOKEN_INVALID']);

    // A day later the file is removed and the export expired.
    expect(await reportJobsRun.exports(new Date(now.getTime() + 24 * 3_600_000 + MIN), CID)).toMatchObject({ expired: 1 });
    expect((await api(me.cookie).get(`/reports/exports/${id}`)).body.data).toMatchObject({ status: 'expired', url: null });
  });

  test('up to 20,000 rows the file comes at once, as before', async () => {
    const { truck } = await world(3);
    const me = await person(['fleet_manager']);
    const res = await api(me.cookie).get(`/reports/trips?vehicle_id=${truck.public_id}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});

describe('report schedules (FMS-160)', () => {
  test('a weekly schedule sends on its day and hour, attached, for last week, and moves on a week', async () => {
    await email();
    const { depot } = await world(14);
    const owner = await person(['fleet_manager'], null, 'Owner Person');
    const clerk = await person(['finance_clerk'], depot, 'Clerk Person');

    const created = await api(owner.cookie).post('/reports/schedules', {
      name: 'Monday trips',
      report: 'trips',
      format: 'csv',
      frequency: 'weekly',
      day: 1,
      hour: 7,
      recipients: [owner.user.public_id, clerk.user.public_id],
      filters: { depot_ids: [depot.public_id] },
    });
    expect(created.status).toBe(201);
    const s = created.body.data;
    const first = new Date(s.next_run_at);
    // Monday, 07:00 in Addis Ababa, within the week.
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Addis_Ababa', weekday: 'long', hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(first)).toBe('Monday 07:00');
    expect(first.getTime() - Date.now()).toBeLessThanOrEqual(7 * DAY);
    // The run is tried at the last Monday 07:00 gone by, so the week it reports on is over.
    let due = first;
    while (due.getTime() > Date.now()) due = new Date(due.getTime() - 7 * DAY);
    await pool.query('UPDATE analytics.report_schedules SET next_run_at = $2 WHERE public_id = $1', [s.id, due]);
    expect(s.recipients.map((r: { name: string }) => r.name).sort()).toEqual(['Clerk Person', 'Owner Person']);

    expect(await reportJobsRun.schedules(new Date(due.getTime() - MIN), CID)).toMatchObject({ runs: 0 });
    expect(await reportJobsRun.schedules(due, CID)).toMatchObject({ runs: 1, sent: 2 });
    // Run twice for the same time, it is not sent again.
    expect(await reportJobsRun.schedules(due, CID)).toMatchObject({ runs: 0 });

    const [mail] = mailsTo(clerk.user.email);
    expect(mail.data).toMatch(/Subject: Monday trips: Trip history/);
    expect(mail.data).toMatch(/Content-Disposition: attachment;\s+filename=.*\.csv/);
    const [run] = await runsOf(owner.cookie, s.id);
    expect(run).toMatchObject({ status: 'sent', attempts: 1 });
    // Last week, Monday to Sunday.
    const period = run.period as { from: string; to: string };
    expect(due.getTime() - new Date(period.from).getTime()).toBe(7 * DAY + 7 * 3_600_000);
    expect(new Date(period.to).getTime() - new Date(period.from).getTime()).toBe(7 * DAY);
    expect((run.recipients as { outcome: string; delivered: string }[]).map((r) => [r.outcome, r.delivered])).toEqual([
      ['sent', 'attached'],
      ['sent', 'attached'],
    ]);
    const after = (await api(owner.cookie).get('/reports/schedules')).body.data[0];
    expect(new Date(after.next_run_at).getTime() - due.getTime()).toBe(7 * DAY);
  });

  test('each recipient gets the report in their own scope; the driver score only with tracking:read', async () => {
    await email();
    const a = await world(5);
    const b = await world(5);
    const owner = await person(['fleet_manager']);
    const clerk = await person(['finance_clerk'], a.depot);
    const dispatcher = await person(['dispatcher'], b.depot);
    const s = (
      await api(owner.cookie).post('/reports/schedules', { name: 'Drivers', report: 'drivers', format: 'csv', frequency: 'daily', hour: 6, recipients: [clerk.user.public_id, dispatcher.user.public_id] })
    ).body.data;
    // Due a minute from now: yesterday's report, when each depot had a trip.
    await pool.query('UPDATE analytics.report_schedules SET next_run_at = $2 WHERE public_id = $1', [s.id, new Date(Date.now() + MIN)]);
    expect(await reportJobsRun.schedules(new Date(Date.now() + 2 * MIN), CID)).toMatchObject({ runs: 1, sent: 2 });

    const csv = (address: unknown) => {
      const [mail] = mailsTo(address);
      const part = mail.data.split(/Content-Disposition: attachment[^\n]*\n/)[1];
      return Buffer.from(part.split(/\r?\n\r?\n/)[1].split(/\r?\n--/)[0].replace(/\s+/g, ''), 'base64').toString('utf8');
    };
    expect(csv(clerk.user.email)).not.toMatch(/Score/);
    expect(csv(dispatcher.user.email)).toMatch(/Score \(0-100\)/);
    // Each recipient's own depot only.
    expect(csv(clerk.user.email)).toContain(String(a.depot.name));
    expect(csv(clerk.user.email)).not.toContain(String(b.depot.name));
    expect(csv(dispatcher.user.email)).toContain(String(b.depot.name));
    expect(csv(dispatcher.user.email)).not.toContain(String(a.depot.name));
  });

  test('a recipient who lost access is skipped and the owner is told; a failed send is retried and shown in the history', async () => {
    await email();
    await world(3);
    const owner = await person(['fleet_manager'], null, 'Schedule Owner');
    const leaver = await person(['fleet_manager'], null, 'Moved Person');
    const keeper = await person(['finance_clerk'], null, 'Kept Person');
    const s = (
      await api(owner.cookie).post('/reports/schedules', { name: 'Daily cost', report: 'cost', format: 'xlsx', frequency: 'daily', hour: 8, recipients: [leaver.user.public_id, keeper.user.public_id] })
    ).body.data;
    // The leaver is now a depot admin: no analytics:read.
    await pool.query("DELETE FROM auth.user_roles WHERE user_id = $1", [leaver.user.id]);
    await pool.query("INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE name = 'depot_admin'", [leaver.user.id]);
    smtp.replies.rcpt = '451 Try again later';
    // Two days back, so the day after's run reports on a day already over.
    const due = new Date(new Date(s.next_run_at).getTime() - 2 * DAY);
    await pool.query('UPDATE analytics.report_schedules SET next_run_at = $2 WHERE public_id = $1', [s.id, due]);

    expect(await reportJobsRun.schedules(due, CID)).toMatchObject({ runs: 1, sent: 0, skipped: 1, failed: 1 });
    let [run] = await runsOf(owner.cookie, s.id);
    expect(run).toMatchObject({ status: 'retrying', attempts: 1 });
    expect(new Date(run.next_attempt_at as string).getTime() - due.getTime()).toBe(15 * MIN);
    expect((run.recipients as { user: { name: string }; outcome: string; reason: string }[]).map((r) => [r.user.name, r.outcome, r.reason])).toEqual([
      ['Moved Person', 'skipped', 'no_access'],
      ['Kept Person', 'failed', expect.stringMatching(/451/)],
    ]);
    // The owner is told (the mail server refused every recipient this time, so the notice is only attempted).
    smtp.replies.rcpt = '250 OK';

    expect(await reportJobsRun.schedules(new Date(due.getTime() + 14 * MIN), CID)).toMatchObject({ retried: 0 });
    expect(await reportJobsRun.schedules(new Date(due.getTime() + 15 * MIN), CID)).toMatchObject({ retried: 1, sent: 1 });
    [run] = await runsOf(owner.cookie, s.id);
    expect(run).toMatchObject({ status: 'partial', attempts: 2, next_attempt_at: null });
    expect((run.recipients as { outcome: string }[]).map((r) => r.outcome)).toEqual(['skipped', 'sent']);
    expect(mailsTo(keeper.user.email)).toHaveLength(1);
    expect(mailsTo(leaver.user.email)).toHaveLength(0);

    // Next day the leaver is skipped again and the owner hears of it.
    const next = new Date(due.getTime() + DAY);
    expect(await reportJobsRun.schedules(next, CID)).toMatchObject({ runs: 1, sent: 1, skipped: 1 });
    const notice = mailsTo(owner.user.email).find((m) => /not sent to one recipient/.test(m.data));
    expect(notice?.data).toMatch(/Moved Person/);
  });

  test('three failed attempts end the run as failed', async () => {
    await email();
    await world(2);
    const owner = await person(['fleet_manager']);
    const s = (await api(owner.cookie).post('/reports/schedules', { name: 'Fuel', report: 'fuel', format: 'pdf', frequency: 'daily', hour: 5, recipients: [owner.user.public_id] })).body.data;
    smtp.replies.rcpt = '451 Try again later';
    try {
      const due = new Date(s.next_run_at);
      await reportJobsRun.schedules(due, CID);
      await reportJobsRun.schedules(new Date(due.getTime() + 15 * MIN), CID);
      await reportJobsRun.schedules(new Date(due.getTime() + 30 * MIN), CID);
      const [run] = await runsOf(owner.cookie, s.id);
      expect(run).toMatchObject({ status: 'failed', attempts: 3, next_attempt_at: null });
    } finally {
      smtp.replies.rcpt = '250 OK';
    }
  });

  test('a file over the attachment limit goes as a signed link valid 7 days', async () => {
    await email();
    await world(3);
    const owner = await person(['fleet_manager']);
    const s = (await api(owner.cookie).post('/reports/schedules', { name: 'Big', report: 'trips', format: 'csv', frequency: 'daily', hour: 9, recipients: [owner.user.public_id] })).body.data;
    // A limit of 10 bytes stands in for 5 MB.
    expect(await reportJobsRun.schedules(new Date(s.next_run_at), CID, 10)).toMatchObject({ sent: 1 });
    const [mail] = mailsTo(owner.user.email);
    expect(mail.data).not.toMatch(/Content-Disposition: attachment/);
    const link = /\/api\/v1\/report-files\/[0-9a-f-]{36}\/content\?expires=(\d+)&signature=[0-9a-f]+/.exec(mail.data.replace(/=\r?\n/g, '').replace(/=3D/g, '='));
    expect(link).not.toBeNull();
    expect(Number(link![1]) * 1000 - Date.now()).toBeGreaterThan(7 * DAY - 5 * MIN);
    const [run] = await runsOf(owner.cookie, s.id);
    expect((run.recipients as { delivered: string }[])[0].delivered).toBe('link');
    expect((await request(app).get(link![0])).status).toBe(200);
  });

  test('validation, ownership and changes', async () => {
    const owner = await person(['fleet_manager']);
    const other = await person(['fleet_manager']);
    const admin = await person(['admin']);
    const noReports = await person(['depot_admin']);
    const base = { name: 'W', report: 'fuel', format: 'csv', frequency: 'weekly', day: 3, hour: 7, recipients: [owner.user.public_id] };
    expect((await api(owner.cookie).post('/reports/schedules', { ...base, day: undefined })).body.error.details[0]).toMatchObject({ field: 'day', reason: 'weekday_required' });
    expect((await api(owner.cookie).post('/reports/schedules', { ...base, day: 8 })).status).toBe(400);
    expect((await api(owner.cookie).post('/reports/schedules', { ...base, recipients: ['00000000-0000-4000-8000-000000000000'] })).body.error.details[0]).toMatchObject({ field: 'recipients', reason: 'unknown_user' });
    expect((await api(owner.cookie).post('/reports/schedules', { ...base, report: 'nope' })).status).toBe(400);
    expect((await api(noReports.cookie).post('/reports/schedules', base)).status).toBe(403);

    const s = (await api(owner.cookie).post('/reports/schedules', base)).body.data;
    expect((await api(other.cookie).patch(`/reports/schedules/${s.id}`, { hour: 9 })).status).toBe(404);
    expect((await api(other.cookie).get(`/reports/schedules/${s.id}/runs`)).status).toBe(404);
    expect((await api(other.cookie).get('/reports/schedules')).body.data).toEqual([]);
    expect((await api(admin.cookie).get('/reports/schedules')).body.data.map((x: { id: string }) => x.id)).toContain(s.id);

    // Who it can go to: active users who read reports, by name; not a depot admin (no analytics:read).
    const found = (await api(owner.cookie).get(`/reports/recipients?search=${encodeURIComponent(String(owner.user.email).slice(0, 12))}`)).body.data;
    expect(found).toEqual([{ id: owner.user.public_id, name: 'Test User', roles: ['fleet_manager'] }]);
    expect((await api(owner.cookie).get(`/reports/recipients?search=${encodeURIComponent(String(noReports.user.email))}`)).body.data).toEqual([]);

    const changed = await api(owner.cookie).patch(`/reports/schedules/${s.id}`, { frequency: 'monthly', day: 1, hour: 6 });
    expect(changed.status).toBe(200);
    expect(addisDay(new Date(changed.body.data.next_run_at)).slice(8)).toBe('01');
    expect((await api(owner.cookie).delete(`/reports/schedules/${s.id}`)).status).toBe(204);
    expect((await api(owner.cookie).get('/reports/schedules')).body.data).toEqual([]);
  });
});
