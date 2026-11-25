import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { feedbackJobs } from '../../src/modules/analytics';
import { monthOf } from '../../src/modules/analytics/domain/appeal';
import { generateVapidKeys, integrationGateway, notificationAdapter } from '../../src/modules/integration';
import { settings } from '../../src/modules/settings';
import { deliverEvents, publishedEvents } from '../support/events';
import { copyDriverAccount, createDepot, createProvider, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-158: admin-to-driver feedback. A manager of the driver's depot gives feedback on a trip, a month or overall;
// the driver is told by push, reads it, acknowledges it and replies once; the author corrects it for 24 hours, then
// can only retract it; it is in the driver's data export and goes with an erasure. The pure rules are unit-tested
// (src/modules/analytics/domain/feedback.test.ts).

const app = createApp();
const PASSWORD = 'Feedback-Test-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

afterEach(() => settings.forget());

async function cookieOf(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function staff(roles: RoleName[], depot: Depot | null = null, fullName = `Manager ${roles[0]}`) {
  const user = await createUser({ roles, depot, password: PASSWORD, fullName });
  return { user, cookie: await cookieOf(user.email) };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, cookie: string, body: object = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, cookie: string, body: object = {}) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string, cookie: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
};

/** A driver of `depot` with `trips` completed 80 km trips in the last hours (3 make a score), signed in. */
async function driverOf(depot: Depot, name: string, trips = 1) {
  const user = await createUser({ roles: ['driver'], depot, password: PASSWORD, fullName: name });
  const driver = (await pool.query<Row>("INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, 'LIC-' || gen_random_uuid(), '2030-12-31') RETURNING *", [user.id])).rows[0];
  await copyDriverAccount(String(user.id));
  const truck = (await createVehicle({ depot })) as Row;
  const made: Row[] = [];
  for (let i = 0; i < trips; i++) {
    const end = new Date(Date.now() - HOUR - i * 20 * 60_000);
    const start = new Date(end.getTime() - 15 * 60_000);
    made.push(
      (
        await pool.query<Row>(
          `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_distance_source)
           VALUES ($1, $2, 'completed', $3, $4, $3, $4, 80, 'gps') RETURNING *`,
          [truck.id, driver.id, start, end],
        )
      ).rows[0],
    );
  }
  const trip = made[0];
  return { user, driver, trip, cookie: await cookieOf(user.email) };
}
type Driver = Awaited<ReturnType<typeof driverOf>>;

const onTrip = (d: Driver, extra: object = {}) => ({
  subject_type: 'trip',
  trip_id: d.trip.public_id,
  category: 'safety',
  tone: 'needs_improvement',
  message: 'You braked hard three times near the Bole junction. Keep more distance.',
  ...extra,
});

const vapid = generateVapidKeys();
const PUSH_CODE = `push-${randomUUID().slice(0, 8)}`;
let registered = false;
/** Push on, and a browser with push for this user: what they are sent by push is queued (never sent here). */
async function pushFor(userId: string) {
  if (!registered) {
    integrationGateway.register(notificationAdapter(PUSH_CODE, { pushHosts: ['127.0.0.1'], allowHttpPush: true }));
    Object.assign(config.integrations.secrets, { [PUSH_CODE]: { apiKey: vapid.privateKey } });
    registered = true;
  }
  await createProvider({ code: PUSH_CODE, provider_type: 'notification', configuration: { channel: 'push', vapid_public_key: vapid.publicKey, subject: 'mailto:ops@fleet.test', max_retries: 0 } });
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  await pool.query('INSERT INTO alert.push_subscriptions (user_id, endpoint, p256dh, auth_secret) VALUES ($1, $2, $3, $4)', [
    userId,
    `http://127.0.0.1:9/push/${randomUUID()}`,
    ecdh.getPublicKey().toString('base64url'),
    randomBytes(16).toString('base64url'),
  ]);
}

const notices = async (userId: string) =>
  (
    await pool.query<{ channel: string; type: string; title: string; entity_id: string; entity_type: string }>(
      `SELECT channel::text, notification_type AS type, title, entity_type, entity_id FROM alert.notifications
        WHERE recipient_user_id = $1 AND alert_id IS NULL ORDER BY id`,
      [userId],
    )
  ).rows;

const feedbackRow = async (publicId: string) => (await pool.query<Row>('SELECT * FROM analytics.driver_feedback WHERE public_id = $1', [publicId])).rows[0];

describe('giving feedback and the driver being told', () => {
  test('a fleet manager gives feedback on a trip; the driver is sent a push at once that opens the item', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Abebe Feedback');
    await pushFor(String(d.user.id));
    const manager = await staff(['fleet_manager'], null, 'Meron Manager');
    const given = await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d));
    expect(given.status).toBe(201);
    expect(given.body.data).toMatchObject({
      subject: { type: 'trip', trip_id: d.trip.public_id, month: null },
      category: 'safety',
      tone: 'needs_improvement',
      from: { name: 'Meron Manager' },
      acknowledged_at: null,
      retracted_at: null,
      can: { edit: true, retract: true },
    });
    const id = given.body.data.id;
    const [event] = await publishedEvents('FeedbackGiven');
    expect(event.payload).toMatchObject({ feedback_id: id, driver_id: d.driver.public_id, depot_id: depot.public_id, category: 'safety' });
    // Never the words in an event.
    expect(JSON.stringify(event.payload)).not.toContain('Bole');

    const before = Date.now();
    await deliverEvents();
    const told = await notices(String(d.user.id));
    expect(told.map((n) => n.channel).sort()).toEqual(['in_app', 'push']);
    expect(told.every((n) => n.type === 'feedback_update' && n.entity_type === 'feedback' && n.entity_id === id)).toBe(true);
    // Queued now for the delivery job, which runs every minute: the push leaves within one.
    const push = (
      await pool.query<{ status: string; next_attempt_at: Date }>(
        "SELECT status::text, next_attempt_at FROM alert.notifications WHERE recipient_user_id = $1 AND channel = 'push' AND entity_type = 'feedback'",
        [d.user.id],
      )
    ).rows;
    expect(push).toHaveLength(1);
    expect(push[0].status).toBe('queued');
    expect(push[0].next_attempt_at.getTime()).toBeLessThanOrEqual(before + 60_000);
    const inbox = await api.get('/notifications', d.cookie);
    expect(inbox.body.data.find((n: { type: string }) => n.type === 'feedback_update')).toMatchObject({ entity: { type: 'feedback', id } });
    // Never by email or SMS (the personal-channel rule).
    expect(told.some((n) => n.channel === 'email' || n.channel === 'sms')).toBe(false);

    const mine = await api.get('/driver/feedback', d.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((f: { id: string }) => f.id)).toEqual([id]);
    expect(mine.body.meta.unacknowledged).toBe(1);
    expect((await api.get(`/driver/feedback/${id}`, d.cookie)).body.data).toMatchObject({ id, message: onTrip(d).message, can: { acknowledge: true, reply: true, disagree: true } });
  });

  test('feedback on a month records the score shown; overall has no subject; a category not in use is refused', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Bekele Month', 3);
    const admin = await staff(['admin']);
    const month = monthOf(new Date(d.trip.actual_end as Date));
    const onMonth = await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { subject_type: 'month', month, category: 'punctuality', tone: 'praise', message: 'Every trip on time this month. Thank you.' });
    expect(onMonth.status).toBe(201);
    expect(onMonth.body.data.subject).toMatchObject({ type: 'month', month });
    // The score the author saw: the driver's own score card's, then.
    const card = await api.get(`/analytics/my-performance?month=${month}`, d.cookie);
    expect(card.body.data.score).toEqual(expect.any(Number));
    expect(onMonth.body.data.subject.score_shown).toBe(card.body.data.score);
    const overall = await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { subject_type: 'overall', category: 'general', tone: 'information', message: 'Your licence renewal is due in spring.' });
    expect(overall.body.data.subject).toEqual({ type: 'overall', trip_id: null, month: null, score_shown: null });

    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { ...onTrip(d), category: 'cargo' })).status).toBe(400);
    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { ...onTrip(d), message: 'Too short' })).status).toBe(400);
    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { subject_type: 'month', month: '2999-01', category: 'safety', tone: 'information', message: 'A month in the future.' })).status).toBe(400);
    const other = await driverOf(depot, 'Other Trip');
    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, onTrip(other))).status).toBe(400);

    // The categories are a settings parameter: one taken out of use is refused from then on.
    await pool.query("INSERT INTO settings.settings (key, value) VALUES ('feedback_categories', '[\"safety\", \"general\"]') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    settings.forget();
    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, { ...onTrip(d), category: 'punctuality' })).status).toBe(400);
    expect((await api.post(`/drivers/${d.driver.public_id}/feedback`, admin.cookie, onTrip(d))).status).toBe(201);
  });
});

describe('who reads it', () => {
  test('a driver sees only their own feedback; a manager of another depot gets 403', async () => {
    const depotA = await createDepot();
    const depotB = await createDepot();
    const a = await driverOf(depotA, 'Chaltu A');
    const b = await driverOf(depotA, 'Dawit B');
    const managerA = await staff(['depot_admin'], depotA);
    const managerB = await staff(['depot_admin'], depotB);
    const forA = (await api.post(`/drivers/${a.driver.public_id}/feedback`, managerA.cookie, onTrip(a))).body.data;
    await api.post(`/drivers/${b.driver.public_id}/feedback`, managerA.cookie, onTrip(b));

    expect((await api.get('/driver/feedback', a.cookie)).body.data.map((f: { id: string }) => f.id)).toEqual([forA.id]);
    expect((await api.get(`/driver/feedback/${forA.id}`, b.cookie)).status).toBe(404);
    expect((await api.post(`/driver/feedback/${forA.id}/acknowledge`, b.cookie)).status).toBe(404);
    // A driver holds no feedback permission: the managers' routes are closed to them.
    expect((await api.get(`/feedback/${forA.id}`, a.cookie)).status).toBe(403);
    expect((await api.get(`/drivers/${a.driver.public_id}/feedback`, a.cookie)).status).toBe(403);

    expect((await api.get(`/drivers/${a.driver.public_id}/feedback`, managerB.cookie)).status).toBe(403);
    expect((await api.get(`/feedback/${forA.id}`, managerB.cookie)).status).toBe(403);
    expect((await api.post(`/drivers/${a.driver.public_id}/feedback`, managerB.cookie, onTrip(a))).status).toBe(403);
    expect((await api.post(`/feedback/${forA.id}/retract`, managerB.cookie, { reason: 'Not mine to give.' })).status).toBe(403);
    // Neither dispatchers nor finance clerks read feedback (the card's open question: not for now).
    const dispatcher = await staff(['dispatcher'], depotA);
    expect((await api.get(`/drivers/${a.driver.public_id}/feedback`, dispatcher.cookie)).status).toBe(403);

    // The manager's view: newest first, filtered, with the 90 days' counts per category.
    await api.post(`/drivers/${a.driver.public_id}/feedback`, managerA.cookie, { subject_type: 'overall', category: 'vehicle_care', tone: 'praise', message: 'The cab is always spotless. Thank you.' });
    const view = await api.get(`/drivers/${a.driver.public_id}/feedback?tone=praise`, managerA.cookie);
    expect(view.status).toBe(200);
    expect(view.body.data.map((f: { category: string }) => f.category)).toEqual(['vehicle_care']);
    expect(view.body.meta.counts).toEqual({ days: 90, by_category: { safety: 1, vehicle_care: 1 }, unacknowledged_overdue: 0 });
  });

  test('an item unacknowledged for 7 days is flagged on the manager’s view', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Eden Stale');
    const manager = await staff(['fleet_manager']);
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d))).body.data;
    await pool.query("UPDATE analytics.driver_feedback SET created_at = now() - interval '8 days' WHERE public_id = $1", [item.id]);
    const view = await api.get(`/drivers/${d.driver.public_id}/feedback`, manager.cookie);
    expect(view.body.data[0].unacknowledged_overdue).toBe(true);
    expect(view.body.meta.counts.unacknowledged_overdue).toBe(1);
    await api.post(`/driver/feedback/${item.id}/acknowledge`, d.cookie);
    expect((await api.get(`/feedback/${item.id}`, manager.cookie)).body.data.unacknowledged_overdue).toBe(false);
  });
});

describe('corrections and retraction', () => {
  test('its author edits it within 24 hours, the earlier text kept; after that an edit is refused', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Fikru Edit');
    const author = await staff(['fleet_manager'], null, 'Author Manager');
    const colleague = await staff(['fleet_manager'], null, 'Colleague Manager');
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, author.cookie, onTrip(d))).body.data;

    expect((await api.patch(`/feedback/${item.id}`, colleague.cookie, { message: 'Someone else’s words here.' })).status).toBe(403);
    const edited = await api.patch(`/feedback/${item.id}`, author.cookie, { message: 'You braked hard twice near the Bole junction. Keep more distance.' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.message).toContain('twice');
    expect(edited.body.data.edited_at).not.toBeNull();
    expect(edited.body.data.revisions).toEqual([{ message: onTrip(d).message, revised_by: { id: author.user.public_id, name: 'Author Manager' }, at: expect.any(String) }]);
    expect((await publishedEvents('FeedbackEdited')).map((e) => e.payload.feedback_id)).toEqual([item.id]);

    // 24 hours later.
    await pool.query("UPDATE analytics.driver_feedback SET editable_until = now() - interval '1 minute' WHERE public_id = $1", [item.id]);
    const late = await api.patch(`/feedback/${item.id}`, author.cookie, { message: 'One more change, too late now.' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CONFLICT_FEEDBACK_LOCKED');
    expect((await api.get(`/feedback/${item.id}`, author.cookie)).body.data.can).toMatchObject({ edit: false, retract: true });
  });

  test('a retracted item disappears for the driver and stays in the audit log', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Genet Retract');
    const manager = await staff(['depot_admin'], depot);
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d))).body.data;
    expect((await api.post(`/feedback/${item.id}/retract`, manager.cookie, {})).status).toBe(400);
    const done = await api.post(`/feedback/${item.id}/retract`, manager.cookie, { reason: 'Given to the wrong driver.' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ retraction_reason: 'Given to the wrong driver.', retracted_by: { id: manager.user.public_id }, can: { edit: false, retract: false } });
    expect((await api.post(`/feedback/${item.id}/retract`, manager.cookie, { reason: 'Again.' })).body.error.code).toBe('CONFLICT_FEEDBACK_RETRACTED');

    expect((await api.get('/driver/feedback', d.cookie)).body.data).toEqual([]);
    expect((await api.get(`/driver/feedback/${item.id}`, d.cookie)).status).toBe(404);
    // Managers still see it, marked.
    expect((await api.get(`/drivers/${d.driver.public_id}/feedback`, manager.cookie)).body.data[0]).toMatchObject({ id: item.id, retracted_at: expect.any(String) });
    const row = await feedbackRow(item.id);
    const trail = await pool.query<{ action: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null }>(
      "SELECT action, old_values, new_values FROM audit.audit_logs WHERE entity_type = 'analytics.driver_feedback' AND entity_id = $1 ORDER BY id",
      [row.id],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
    expect(trail.rows[1].new_values).toMatchObject({ retraction_reason: 'Given to the wrong driver.', message: onTrip(d).message });
    expect((await publishedEvents('FeedbackRetracted')).map((e) => e.payload.feedback_id)).toEqual([item.id]);
  });
});

describe('the driver answering', () => {
  test('the driver’s acknowledgement and reply are visible to the author with their times; one reply only', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Hana Reply');
    const manager = await staff(['fleet_manager']);
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d))).body.data;

    const got = await api.post(`/driver/feedback/${item.id}/acknowledge`, d.cookie);
    expect(got.status).toBe(200);
    expect(got.body.data.acknowledged_at).toEqual(expect.any(String));
    expect(got.body.data.can).toMatchObject({ acknowledge: false, reply: true });
    // Acknowledging again changes nothing, and publishes nothing more.
    expect((await api.post(`/driver/feedback/${item.id}/acknowledge`, d.cookie)).body.data.acknowledged_at).toBe(got.body.data.acknowledged_at);
    expect(await publishedEvents('FeedbackAcknowledged')).toHaveLength(1);

    expect((await api.post(`/driver/feedback/${item.id}/reply`, d.cookie, { body: 'x'.repeat(1001) })).status).toBe(400);
    const replied = await api.post(`/driver/feedback/${item.id}/reply`, d.cookie, { body: 'A truck cut in front of me there twice. I will keep more distance.' });
    expect(replied.status).toBe(201);
    expect((await api.post(`/driver/feedback/${item.id}/reply`, d.cookie, { body: 'And another thing.' })).body.error.code).toBe('CONFLICT_FEEDBACK_REPLIED');

    const seen = (await api.get(`/feedback/${item.id}`, manager.cookie)).body.data;
    expect(seen).toMatchObject({ acknowledged_at: got.body.data.acknowledged_at, reply: 'A truck cut in front of me there twice. I will keep more distance.', replied_at: expect.any(String) });
  });

  test('"I disagree" opens an appeal naming the feedback; its author may not decide it', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Iman Disagree');
    const author = await staff(['fleet_manager']);
    const month = monthOf(new Date(d.trip.actual_end as Date));
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, author.cookie, { subject_type: 'month', month, category: 'safety', tone: 'needs_improvement', message: 'Too much speeding this month.' })).body.data;
    // A month's score is appealed once the month has ended: the month before is.
    const ended = monthOf(new Date(new Date(`${month}-01T00:00:00Z`).getTime() - DAY));
    const appeal = await api.post('/appeals', d.cookie, { target_type: 'score', month: ended, reason: 'wrong_data', explanation: 'The feedback counts speeding I did not do on that route.', feedback_id: item.id });
    expect(appeal.status).toBe(201);
    expect(appeal.body.data.feedback_id).toBe(item.id);
    expect((await api.post('/appeals', d.cookie, { target_type: 'score', month: ended, reason: 'other', explanation: 'Another appeal of feedback that is not mine.', feedback_id: randomUUID() })).status).toBe(404);

    await api.post(`/appeals/${appeal.body.data.id}/claim`, author.cookie);
    const decided = await api.post(`/appeals/${appeal.body.data.id}/decision`, author.cookie, { outcome: 'rejected', note: 'I stand by it.' });
    expect(decided.status).toBe(409);
    expect(decided.body.error.code).toBe('CONFLICT_OWN_REPORT');
  });
});

describe('data protection', () => {
  test('feedback is in the driver’s data export and is removed when the driver’s data is erased', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Jemal Erase');
    const manager = await staff(['fleet_manager']);
    const item = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d))).body.data;
    await api.patch(`/feedback/${item.id}`, manager.cookie, { message: 'You braked hard twice near the Bole junction.' });
    await api.post(`/driver/feedback/${item.id}/reply`, d.cookie, { body: 'Noted, thank you.' });

    const exported = await api.get('/auth/me/data-export', d.cookie);
    expect(exported.status).toBe(200);
    expect(exported.body.data.feedback).toEqual([
      expect.objectContaining({
        id: item.id,
        subject_type: 'trip',
        trip_id: d.trip.public_id,
        message: 'You braked hard twice near the Bole junction.',
        earlier_messages: [{ message: onTrip(d).message, replaced_at: expect.any(String) }],
        reply: 'Noted, thank you.',
      }),
    ]);

    // Only an admin erases.
    expect((await api.post(`/drivers/${d.driver.public_id}/data-erasure`, manager.cookie, { reason: 'Request under the data protection policy.' })).status).toBe(403);
    const admin = await staff(['admin']);
    expect((await api.post(`/drivers/${randomUUID()}/data-erasure`, admin.cookie, { reason: 'Nobody.' })).status).toBe(404);
    const erased = await api.post(`/drivers/${d.driver.public_id}/data-erasure`, admin.cookie, { reason: 'Request under the data protection policy.' });
    expect(erased.status).toBe(200);
    expect(erased.body.data).toEqual({ driver_id: d.driver.public_id, erased: { feedback: 1 } });

    expect(await feedbackRow(item.id)).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM analytics.feedback_revisions r WHERE NOT EXISTS (SELECT 1 FROM analytics.driver_feedback f WHERE f.id = r.feedback_id)')).rowCount).toBe(0);
    expect((await api.get('/auth/me/data-export', d.cookie)).body.data.feedback).toEqual([]);
    expect((await api.get(`/drivers/${d.driver.public_id}/feedback`, manager.cookie)).body.data).toEqual([]);
    // The erasure is audited with its counts and reason; the entry for the item never repeats its words.
    const audit = await pool.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM audit.audit_logs WHERE action IN ('privacy.data_erased', 'privacy.feedback_erased') ORDER BY id DESC LIMIT 2",
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['privacy.data_erased', 'privacy.feedback_erased']);
    expect(audit.rows.find((r) => r.action === 'privacy.data_erased')!.details).toMatchObject({ reason: 'Request under the data protection policy.', erased: { feedback: 1 } });
    expect(JSON.stringify(audit.rows)).not.toContain('Bole');
  });

  test('the retention job deletes feedback older than 24 months, retracted items too', async () => {
    const depot = await createDepot();
    const d = await driverOf(depot, 'Kidist Retention');
    const manager = await staff(['fleet_manager']);
    const old = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, onTrip(d))).body.data;
    const recent = (await api.post(`/drivers/${d.driver.public_id}/feedback`, manager.cookie, { ...onTrip(d), tone: 'praise' })).body.data;
    await pool.query("UPDATE analytics.driver_feedback SET created_at = now() - interval '25 months' WHERE public_id = $1", [old.id]);
    const result = await feedbackJobs.purge(new Date(), randomUUID());
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await feedbackRow(old.id)).toBeUndefined();
    expect(await feedbackRow(recent.id)).toBeDefined();
  });
});

describe('templates', () => {
  test('managers keep saved messages per category; drivers cannot read them', async () => {
    const manager = await staff(['fleet_manager']);
    const created = await api.post('/feedback/templates', manager.cookie, { category: 'fuel_efficiency', title: 'Idling', body: 'Switch the engine off when you wait more than 5 minutes.' });
    expect(created.status).toBe(201);
    expect((await api.post('/feedback/templates', manager.cookie, { category: 'cargo', title: 'X', body: 'Not a category in use.' })).status).toBe(400);
    const list = await api.get('/feedback/templates?category=fuel_efficiency', manager.cookie);
    expect(list.body.data.map((t: { id: string }) => t.id)).toContain(created.body.data.id);
    const renamed = await api.patch(`/feedback/templates/${created.body.data.id}`, manager.cookie, { title: 'Idling at depots' });
    expect(renamed.body.data).toMatchObject({ title: 'Idling at depots', category: 'fuel_efficiency' });
    expect((await api.delete(`/feedback/templates/${created.body.data.id}`, manager.cookie)).status).toBe(204);
    expect((await api.get('/feedback/templates', manager.cookie)).body.data.map((t: { id: string }) => t.id)).not.toContain(created.body.data.id);
    expect((await api.patch(`/feedback/templates/${created.body.data.id}`, manager.cookie, { title: 'Gone' })).status).toBe(404);

    const depot = await createDepot();
    const d = await driverOf(depot, 'Lemma Templates');
    expect((await api.get('/feedback/templates', d.cookie)).status).toBe(403);
  });
});
