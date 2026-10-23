import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-48: the in-app inbox. A user sees and marks read only their own in-app notifications, and their unread
// count is announced (NotificationUnreadChanged) in the same transaction as every change to it.

const app = createApp();
const PASSWORD = 'Inbox-Test-1';
type Row = Record<string, unknown> & { id: string };
const pub = (row: Row) => String(row.public_id);

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<{ cookie: string; user: Row }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), user };
}

const get = (cookie: string, path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const patchRead = (cookie: string, id: string, body: object = {}) => request(app).patch(`/api/v1/notifications/${id}/read`).set('Cookie', cookie).send(body);
const readAll = (cookie: string, body: object = {}) => request(app).post('/api/v1/notifications/read-all').set('Cookie', cookie).send(body);

let clock = 0;
/** A notification straight into the table. `age` orders them (higher is older); defaults to in-app, delivered, unread. */
async function notify(user: Row, extra: Record<string, unknown> = {}, age = ++clock): Promise<Row & { public_id: string }> {
  const values = {
    recipient_user_id: user.id,
    notification_type: 'alert',
    title: `Alert ${age}`,
    message: `Message ${age}`,
    channel: 'in_app',
    status: 'delivered',
    queued_at: new Date(Date.now() - age * 60_000).toISOString(),
    ...extra,
  };
  const keys = Object.keys(values);
  const res = await pool.query<Row & { public_id: string }>(
    `INSERT INTO alert.notifications (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(values),
  );
  return res.rows[0];
}

const ids = (res: Response) => (res.body.data as { id: string }[]).map((n) => n.id);
const unreadInDb = async (user: Row) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM alert.notifications WHERE recipient_user_id = $1 AND channel = 'in_app' AND read_at IS NULL", [user.id])).rows[0].n;
const readAtInDb = async (n: Row) => (await pool.query<{ r: Date | null }>('SELECT read_at AS r FROM alert.notifications WHERE id = $1', [n.id])).rows[0].r;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [res.headers['x-request-id']]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

const unreadEvents = async () => publishedEvents('NotificationUnreadChanged');

describe('GET /notifications', () => {
  test("a user sees only their own notifications: user A never sees user B's, not even an admin's", async () => {
    const depot = await createDepot();
    const [a, b, admin] = [await signIn(['technician'], depot), await signIn(['technician'], depot), await signIn(['admin'])];
    const [mineA, mineB, mineAdmin] = [await notify(a.user), await notify(b.user), await notify(admin.user)];

    const asA = await get(a.cookie, '/notifications');
    expect(asA.status).toBe(200);
    expect(ids(asA)).toEqual([pub(mineA)]);
    expect(ids(await get(b.cookie, '/notifications'))).toEqual([pub(mineB)]);
    // The admin sees every depot's alerts, but their inbox is still their own.
    expect(ids(await get(admin.cookie, '/notifications?page_size=100'))).toEqual([pub(mineAdmin)]);
  });

  test('only the in-app inbox: email, push and sms deliveries of the same user are not in it', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    const inApp = await notify(user);
    for (const channel of ['email', 'sms', 'push']) await notify(user, { channel, status: 'sent' });

    const res = await get(cookie, '/notifications');
    expect(ids(res)).toEqual([pub(inApp)]);
    expect(res.body.meta.total_items).toBe(1);
    expect(res.body.meta.unread_count).toBe(1);
  });

  test('a notification is returned with its alert as a public id, and read state', async () => {
    const depot = await createDepot();
    const { cookie, user } = await signIn(['depot_admin'], depot);
    const vehicle = await createVehicle({ depot });
    const alert = (
      await pool.query<Row & { public_id: string }>(
        "INSERT INTO alert.alerts (alert_type, severity, status, source_module, title, depot_id, vehicle_id) VALUES ('vehicle_fault', 'high', 'open', 'fleet', 'Defects', $1, $2) RETURNING *",
        [depot.id, vehicle.id],
      )
    ).rows[0];
    const withAlert = await notify(user, { alert_id: alert.id, title: 'Defects reported', message: '2 defects' }, 1);
    const without = await notify(user, { notification_type: 'trip_assigned', read_at: new Date().toISOString() }, 2);

    const res = await get(cookie, '/notifications');
    expect(res.body.data).toEqual([
      { id: pub(withAlert), type: 'alert', title: 'Defects reported', message: '2 defects', alert_id: pub(alert), read: false, read_at: null, created_at: expect.any(String) },
      { id: pub(without), type: 'trip_assigned', title: expect.any(String), message: expect.any(String), alert_id: null, read: true, read_at: expect.any(String), created_at: expect.any(String) },
    ]);
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
  });

  test('newest first, with paging and totals; the page size is capped at 100', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    const made: Row[] = [];
    for (let age = 5; age >= 1; age--) made.push(await notify(user, {}, age)); // the oldest first
    const newestFirst = made.map(pub).reverse();

    expect(ids(await get(cookie, '/notifications'))).toEqual(newestFirst);
    const page2 = await get(cookie, '/notifications?page=2&page_size=2');
    expect(ids(page2)).toEqual(newestFirst.slice(2, 4));
    expect(page2.body.meta).toMatchObject({ page: 2, page_size: 2, total_items: 5, total_pages: 3, unread_count: 5 });
    expect((await get(cookie, '/notifications?page_size=1000')).body.meta.page_size).toBe(100);
    expect(ids(await get(cookie, '/notifications?page=9&page_size=2'))).toEqual([]);
    expect((await get(cookie, '/notifications?page=0')).status).toBe(400);
  });

  test('status unread, read or all; the unread count in meta is the whole inbox, whatever the filter', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    const [unread1, unread2] = [await notify(user, {}, 1), await notify(user, {}, 2)];
    const read = await notify(user, { read_at: new Date().toISOString() }, 3);

    const unread = await get(cookie, '/notifications?status=unread');
    expect(ids(unread).sort()).toEqual([pub(unread1), pub(unread2)].sort());
    expect(unread.body.meta).toMatchObject({ total_items: 2, unread_count: 2 });
    const onlyRead = await get(cookie, '/notifications?status=read');
    expect(ids(onlyRead)).toEqual([pub(read)]);
    expect(onlyRead.body.meta).toMatchObject({ total_items: 1, unread_count: 2 });
    expect((await get(cookie, '/notifications?status=all')).body.meta.total_items).toBe(3);

    expect((await get(cookie, '/notifications?status=archived')).status).toBe(400);
  });

  test('filters by type (comma-separated); a bad type or an unknown parameter is 400', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    const [alert, escalated, trip] = [
      await notify(user, { notification_type: 'alert' }, 3),
      await notify(user, { notification_type: 'alert_escalated' }, 2),
      await notify(user, { notification_type: 'trip_assigned' }, 1),
    ];
    expect(ids(await get(cookie, '/notifications?type=alert'))).toEqual([pub(alert)]);
    expect(ids(await get(cookie, '/notifications?type=alert,alert_escalated'))).toEqual([pub(escalated), pub(alert)]);
    expect(ids(await get(cookie, '/notifications?type=trip_assigned'))).toEqual([pub(trip)]);
    expect((await get(cookie, '/notifications?type=Not%20A%20Type')).status).toBe(400);
    const unknown = await get(cookie, '/notifications?user_id=1');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ field: 'user_id', reason: 'not_writable' }]);
  });

  test('every role reads its own inbox (notification:read); no sign-in is 401; an empty inbox is an empty page', async () => {
    const depot = await createDepot();
    for (const role of ['admin', 'fleet_manager', 'dispatcher', 'depot_admin', 'technician', 'driver', 'finance_clerk', 'compliance_officer', 'fleet_owner'] as const) {
      const res = await get((await signIn([role], role === 'admin' ? null : depot)).cookie, '/notifications');
      expect(res.status, role).toBe(200);
      expect(res.body.data, role).toEqual([]);
      expect(res.body.meta, role).toMatchObject({ total_items: 0, unread_count: 0 });
    }
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401);
    expect((await request(app).patch(`/api/v1/notifications/${randomUUID()}/read`)).status).toBe(401);
    expect((await request(app).post('/api/v1/notifications/read-all')).status).toBe(401);
  });
});

describe('PATCH /notifications/{id}/read', () => {
  test('marks one read: the notification, the new unread count, one audit row and the count announced', async () => {
    const { cookie, user } = await signIn(['technician'], await createDepot());
    const [first, second] = [await notify(user, {}, 2), await notify(user, {}, 1)];

    const res = await patchRead(cookie, pub(first));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: pub(first), read: true, read_at: expect.any(String) });
    expect(res.body.meta.unread_count).toBe(1);
    expect(await readAtInDb(first)).not.toBeNull();
    expect(await readAtInDb(second)).toBeNull();
    expect(await auditRows(res)).toEqual(['UPDATE alert.notifications']);

    const [event, ...rest] = await unreadEvents();
    expect(rest).toEqual([]);
    expect(event.actor).toBe(pub(user));
    expect(event.aggregate).toBe(`inbox:${pub(user)}`);
    expect(event.payload).toMatchObject({ user_id: pub(user), unread_count: 1, reason: 'read' });
  });

  test('reading again changes nothing: the same answer, no second audit row, no second event', async () => {
    const { cookie, user } = await signIn(['technician'], await createDepot());
    const n = await notify(user);
    const first = await patchRead(cookie, pub(n));
    const readAt = await readAtInDb(n);

    const again = await patchRead(cookie, pub(n));
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect(await readAtInDb(n)).toEqual(readAt);
    expect(await auditRows(again)).toEqual([]);
    expect(await unreadEvents()).toHaveLength(1);
  });

  test("another user's notification is 404, the same body as a missing one, and it stays unread for its owner", async () => {
    const depot = await createDepot();
    const [owner, intruder] = [await signIn(['technician'], depot), await signIn(['technician'], depot)];
    const admin = await signIn(['admin']);
    const n = await notify(owner.user);

    const attempt = await patchRead(intruder.cookie, pub(n));
    const missing = await patchRead(intruder.cookie, randomUUID());
    expect(attempt.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(attempt.body.error).toEqual(missing.body.error);
    expect(attempt.body.error.code).toBe('NOT_FOUND');
    // Not even an admin may read (or mark) someone else's inbox.
    expect((await patchRead(admin.cookie, pub(n))).status).toBe(404);

    expect(await readAtInDb(n)).toBeNull();
    expect(await unreadInDb(owner.user)).toBe(1);
    expect(await unreadEvents()).toEqual([]);
  });

  test('a malformed id, an email delivery of your own and a body are all refused; nothing changes', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    const email = await notify(user, { channel: 'email', status: 'sent' });
    const inApp = await notify(user);

    expect((await patchRead(cookie, 'not-a-uuid')).status).toBe(404);
    expect((await patchRead(cookie, pub(email))).status).toBe(404);
    const withBody = await patchRead(cookie, pub(inApp), { read_at: '2020-01-01T00:00:00Z' });
    expect(withBody.status).toBe(400);
    expect(withBody.body.error.details).toEqual([{ field: 'read_at', reason: 'not_writable' }]);
    expect(await readAtInDb(inApp)).toBeNull();
    expect(await readAtInDb(email)).toBeNull();
  });
});

describe('POST /notifications/read-all', () => {
  test("marks all of the caller's unread read and no one else's; one audit entry for the batch and one announcement", async () => {
    const depot = await createDepot();
    const [me, other] = [await signIn(['technician'], depot), await signIn(['technician'], depot)];
    const [a, b, alreadyRead] = [await notify(me.user, {}, 3), await notify(me.user, {}, 2), await notify(me.user, { read_at: new Date().toISOString() }, 1)];
    const theirs = await notify(other.user);
    const myEmail = await notify(me.user, { channel: 'email', status: 'sent' });

    const res = await readAll(me.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 2 });
    expect(res.body.meta.unread_count).toBe(0);
    expect(await unreadInDb(me.user)).toBe(0);
    expect(await readAtInDb(a)).not.toBeNull();
    expect(await readAtInDb(b)).not.toBeNull();
    expect(await readAtInDb(alreadyRead)).not.toBeNull();
    // Nobody else's, and not a delivery on another channel.
    expect(await readAtInDb(theirs)).toBeNull();
    expect(await readAtInDb(myEmail)).toBeNull();
    expect(await unreadInDb(other.user)).toBe(1);

    expect(await auditRows(res)).toEqual(['notification.read_all alert.notifications']);
    const [event, ...rest] = await unreadEvents();
    expect(rest).toEqual([]);
    expect(event.payload).toMatchObject({ user_id: pub(me.user), unread_count: 0, reason: 'read_all' });
  });

  test('with nothing unread it changes nothing: updated 0, no audit entry, no event', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    await notify(user, { read_at: new Date().toISOString() });
    const res = await readAll(cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 0 });
    expect(await auditRows(res)).toEqual([]);
    expect(await unreadEvents()).toEqual([]);
    // And an empty inbox the same.
    expect((await readAll((await signIn(['driver'], await createDepot())).cookie)).body.data).toEqual({ updated: 0 });
  });

  test('repeating it is safe; a body is refused', async () => {
    const { cookie, user } = await signIn(['dispatcher'], await createDepot());
    await notify(user);
    expect((await readAll(cookie)).body.data.updated).toBe(1);
    expect((await readAll(cookie)).body.data.updated).toBe(0);
    const withBody = await readAll(cookie, { user_id: 1 });
    expect(withBody.status).toBe(400);
    expect(withBody.body.error.details).toEqual([{ field: 'user_id', reason: 'not_writable' }]);
  });
});

describe('the unread count follows every change (FMS-48 + FMS-92)', () => {
  const fault = (vehicle: Row) => ({
    type: 'VehicleFaultDetected',
    payload: { source: 'dvir', dvir_report_id: randomUUID(), vehicle_id: pub(vehicle), driver_id: null, trip_id: null, inspection_type: 'pre_trip', defect_count: 1, defects: ['Brakes'], maintenance_flag_set: true },
  });

  async function emit(...events: { type: string; payload: Record<string, unknown> }[]) {
    await withTransaction(pool, (tx) => eventBus.publish(tx, events.map((e) => createEvent(e.type, e.payload, { actor: null, correlationId: randomUUID() }))));
    await deliverEvents();
  }

  test("an alert's recipients each get their own new count, and only they: nobody else is announced", async () => {
    const [depot, elsewhere] = [await createDepot(), await createDepot()];
    const vehicle = await createVehicle({ depot });
    const [technician, depotAdmin] = [await signIn(['technician'], depot), await signIn(['depot_admin'], depot)];
    const stranger = await signIn(['technician'], elsewhere);
    // The technician already has one unread: the announcement carries the total, not 1.
    await notify(technician.user, {}, 5);

    await emit(fault(vehicle));

    const events = (await unreadEvents()).map((e) => e.payload);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ user_id: pub(technician.user), unread_count: 2, reason: 'delivered' }));
    expect(events).toContainEqual(expect.objectContaining({ user_id: pub(depotAdmin.user), unread_count: 1, reason: 'delivered' }));
    expect(events.map((e) => e.user_id)).not.toContain(pub(stranger.user));
    // The inbox the count describes.
    expect((await get(technician.cookie, '/notifications?status=unread')).body.meta.unread_count).toBe(2);
    expect((await get(stranger.cookie, '/notifications')).body.meta.unread_count).toBe(0);
  });

  test('a second alert raises it again; reading brings it down; the sequence is exactly what the screen should show', async () => {
    const depot = await createDepot();
    const [first, second] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const { cookie, user } = await signIn(['technician'], depot);

    await emit(fault(first));
    await emit(fault(second));
    const inbox = await get(cookie, '/notifications');
    expect(inbox.body.meta.unread_count).toBe(2);
    await patchRead(cookie, inbox.body.data[0].id);
    await readAll(cookie);

    const mine = (await unreadEvents()).filter((e) => e.payload.user_id === pub(user));
    expect(mine.map((e) => [e.payload.unread_count, e.payload.reason])).toEqual([
      [1, 'delivered'],
      [2, 'delivered'],
      [1, 'read'],
      [0, 'read_all'],
    ]);
  });

  test('a repeat of the same alert tells nobody again, so announces nothing', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await signIn(['technician'], depot);
    await emit(fault(vehicle));
    const before = (await unreadEvents()).length;
    await emit(fault(vehicle));
    expect((await unreadEvents()).length).toBe(before);
  });
});
