import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { appealJobs } from '../../src/modules/analytics';
import { monthOf, monthStart } from '../../src/modules/analytics/domain/appeal';
import { generateVapidKeys, integrationGateway, notificationAdapter } from '../../src/modules/integration';
import { settings } from '../../src/modules/settings';
import { deliverEvents, publishedEvents } from '../support/events';
import { copyDriverAccount, createDepot, createProvider, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-159: score appeals and complaints. A driver appeals a flag, an incident or a month's score with photos; reviewers
// of their depot claim, ask and decide it; an approval corrects the score (the facts stay) and the trip risk labels.
// The status flow and the working-day deadline are unit-tested (src/modules/analytics/domain/appeal.test.ts).

const app = createApp();
const PASSWORD = 'Appeal-Test-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

afterEach(() => settings.forget());

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const EXPLANATION = 'The GPS jumped near the bridge; I was going 60 the whole way.';

async function cookieOf(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function staff(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD, fullName: `Reviewer ${roles[0]}` });
  return { user, cookie: await cookieOf(user.email) };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, cookie: string, body: object = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** Trips, flags and the like start here: within the current Addis Ababa month and in the past. */
const base = () => new Date(Math.max(Date.now() - 3 * HOUR, monthStart(monthOf(new Date())).getTime() + 60_000));

/** A driver with a truck, 4 completed 100 km trips this month (on time, inspected), and a speeding flag on each of the first `flags`. */
async function driverWithMonth(depot: Depot, name: string, flags = 2) {
  const user = await createUser({ roles: ['driver'], depot, password: PASSWORD, fullName: name });
  const driver = (await pool.query<Row>("INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, 'LIC-' || gen_random_uuid(), '2030-12-31') RETURNING *", [user.id])).rows[0];
  await copyDriverAccount(String(user.id));
  const truck = (await createVehicle({ depot })) as Row;
  const trips: Row[] = [];
  const flagRows: Row[] = [];
  for (let i = 0; i < 4; i++) {
    const start = new Date(base().getTime() + i * 10 * 60_000);
    const end = new Date(start.getTime() + 8 * 60_000);
    const trip = (
      await pool.query<Row>(
        `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_distance_source)
         VALUES ($1, $2, 'completed', $3, $4, $3, $4, 100, 'gps') RETURNING *`,
        [truck.id, driver.id, start, end],
      )
    ).rows[0];
    trips.push(trip);
    await pool.query("INSERT INTO fleet.dvir_reports (vehicle_id, driver_id, trip_id, inspection_type, submitted_at) VALUES ($1, $2, $3, 'pre_trip', $4)", [truck.id, driver.id, trip.id, new Date(start.getTime() - 60_000)]);
    if (i < flags) {
      flagRows.push(
        (
          await pool.query<Row>(
            "INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, severity, observed_at, resolved_at, details) VALUES ($1, $2, 'speeding', 'high', $3, $4, '{}') RETURNING *",
            [truck.id, trip.id, new Date(start.getTime() + 2 * 60_000), new Date(start.getTime() + 4 * 60_000)],
          )
        ).rows[0],
      );
    }
  }
  return { user, driver, truck, trips, flags: flagRows, cookie: await cookieOf(user.email) };
}

type Driver = Awaited<ReturnType<typeof driverWithMonth>>;

/** A driver's appeal of their flag, with two photos (multipart). */
function appealFlag(d: Driver, flag: Row, files: { bytes: Buffer; name: string; type: string }[] = []) {
  let req = request(app)
    .post('/api/v1/appeals')
    .set('Cookie', d.cookie)
    .field('target_type', 'flag')
    .field('target_id', String(flag.public_id))
    .field('reason', 'wrong_data')
    .field('explanation', EXPLANATION);
  for (const f of files) req = req.attach('files', f.bytes, { filename: f.name, contentType: f.type });
  return req;
}

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
    await pool.query<{ channel: string; type: string; title: string; entity_id: string }>(
      `SELECT channel::text, notification_type AS type, title, entity_id FROM alert.notifications WHERE recipient_user_id = $1 AND alert_id IS NULL ORDER BY id`,
      [userId],
    )
  ).rows;

describe('submitting and the review queue', () => {
  test('a driver appeals a speeding flag with 2 photos; the reviewer sees it at once, with the GPS track of that flag', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Abebe Appeal');
    const res = await appealFlag(d, d.flags[0], [
      { bytes: JPEG, name: 'speedo.jpg', type: 'image/jpeg' },
      { bytes: PNG, name: 'map.png', type: 'image/png' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'appeal', status: 'submitted', target: { type: 'flag', id: d.flags[0].public_id, trip_id: d.trips[0].public_id }, reason: 'wrong_data' });
    expect(res.body.data.attachments.map((a: { content_type: string }) => a.content_type)).toEqual(['image/jpeg', 'image/png']);
    expect(res.body.data.timeline.map((e: { type: string }) => e.type)).toEqual(['submitted']);
    expect(res.body.data.evidence).toBeNull();

    const manager = await staff(['fleet_manager']);
    const queue = await api.get(`/appeals?depot_id=${depot.public_id}`, manager.cookie);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((a: { id: string }) => a.id)).toEqual([res.body.data.id]);

    const detail = await api.get(`/appeals/${res.body.data.id}`, manager.cookie);
    expect(detail.status).toBe(200);
    const evidence = detail.body.data.evidence;
    expect(evidence.track).toMatchObject({ vehicle_id: d.truck.public_id, from: new Date(d.trips[0].actual_start as Date).toISOString(), to: new Date(d.trips[0].actual_end as Date).toISOString() });
    expect(evidence.flag).toMatchObject({ type: 'speeding', observed_at: new Date(d.flags[0].observed_at as Date).toISOString() });
    expect(evidence.trip_flags.map((f: { id: string }) => f.id)).toEqual([d.flags[0].public_id]);
    expect(evidence.corrections).toEqual(['exclude_flag', 'exclude_trip']);
    expect(evidence.score).toMatchObject({ month: monthOf(new Date(d.trips[0].actual_end as Date)), score: 97 });
    expect(detail.body.data.can).toMatchObject({ claim: true, decide: false, withdraw: false });
    expect((await publishedEvents('AppealSubmitted')).some((e) => e.payload.appeal_id === res.body.data.id)).toBe(true);
  });

  test('files are checked by their first bytes; more than 5 is refused', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Bekele Files');
    const svg = await appealFlag(d, d.flags[0], [{ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'x.jpg', type: 'image/jpeg' }]);
    expect(svg.status).toBe(415);
    const six = await appealFlag(d, d.flags[0], Array.from({ length: 6 }, (_, i) => ({ bytes: JPEG, name: `p${i}.jpg`, type: 'image/jpeg' })));
    expect(six.status).toBe(400);
    expect(six.body.error.details).toEqual([{ field: 'files', reason: 'too_many' }]);
  });

  test('a driver appeals only their own flag; a reviewer of another depot does not see it', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Chaltu Own');
    const other = await driverWithMonth(depot, 'Dawit Other');
    expect((await appealFlag(other, d.flags[0])).status).toBe(404);
    const appeal = (await appealFlag(d, d.flags[0])).body.data;
    const elsewhere = await staff(['depot_admin'], await createDepot());
    expect((await api.get(`/appeals/${appeal.id}`, elsewhere.cookie)).status).toBe(404);
    expect((await api.get('/appeals', elsewhere.cookie)).body.data).toEqual([]);
    expect((await api.get(`/appeals/${appeal.id}`, other.cookie)).status).toBe(404);
    const dispatcher = await staff(['dispatcher'], depot);
    expect((await api.get('/appeals', dispatcher.cookie)).status).toBe(403);
  });
});

describe('the status flow', () => {
  test('a step not in the flow is 409 invalid_transition; a second open appeal is 409 appeal_open; past 30 days is refused', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Elias Flow');
    const manager = await staff(['fleet_manager']);
    const appeal = (await appealFlag(d, d.flags[0])).body.data;

    const early = await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'rejected', note: 'No.' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'invalid_transition' }] });

    const again = await appealFlag(d, d.flags[0]);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CONFLICT_APPEAL_OPEN', details: [{ field: 'target', reason: 'appeal_open' }] });

    expect((await api.post(`/appeals/${appeal.id}/claim`, manager.cookie)).body.data.status).toBe('under_review');
    expect((await api.post(`/appeals/${appeal.id}/claim`, manager.cookie)).status).toBe(409);
    expect((await api.post(`/appeals/${appeal.id}/acknowledge`, d.cookie)).status).toBe(409);

    // Withdrawn before a decision: closed, and the flag may be appealed again.
    const withdrawn = await api.post(`/appeals/${appeal.id}/withdraw`, d.cookie);
    expect(withdrawn.body.data).toMatchObject({ status: 'closed', outcome: 'withdrawn' });
    expect((await api.post(`/appeals/${appeal.id}/withdraw`, d.cookie)).status).toBe(409);
    expect((await appealFlag(d, d.flags[0])).status).toBe(201);

    const old = (
      await pool.query<Row>(
        "INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, severity, observed_at, resolved_at, details) VALUES ($1, $2, 'idling', 'medium', $3, $3, '{}') RETURNING *",
        [d.truck.id, d.trips[3].id, new Date(Date.now() - 31 * DAY)],
      )
    ).rows[0];
    const late = await appealFlag(d, old);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'CONFLICT_APPEAL_WINDOW_CLOSED', details: [{ field: 'target', reason: 'appeal_window_closed' }] });
  });

  test('the window is a setting', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Fikru Window');
    await pool.query("UPDATE tracking.telemetry_flags SET observed_at = now() - interval '10 days' WHERE id = $1", [d.flags[0].id]);
    await pool.query("INSERT INTO settings.settings (key, value) VALUES ('appeal_window_days', '7') ON CONFLICT (key) DO UPDATE SET value = '7'");
    settings.forget();
    expect((await appealFlag(d, d.flags[0])).status).toBe(409);
  });
});

describe('the decision', () => {
  test('approving with Exclude flag corrects the month’s score and rank at once, the trip risk labels leave the flag out, and the flag stays', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Genet Correct');
    const manager = await staff(['fleet_manager']);
    const month = monthOf(new Date(d.trips[0].actual_end as Date));
    const ranking = async () =>
      (await api.get(`/analytics/driver-ranking?month=${month}&depot_id=${depot.public_id}`, manager.cookie)).body.data.drivers.find((r: { driver_id: string }) => r.driver_id === d.driver.public_id);
    const riskOf = async (tripId: string) => (await pool.query<{ safety_event: boolean }>('SELECT safety_event FROM analytics.trip_risk_facts WHERE trip_id = $1', [tripId])).rows[0].safety_event;
    // 400 km, 2 speeding: safety 90, the rest 100: (100·35 + 90·35 + 100·20 + 100·10) / 100 = 96.5, 97.
    expect((await ranking()).score).toBe(97);
    expect(await riskOf(d.trips[0].id)).toBe(true);

    const appeal = (await appealFlag(d, d.flags[0])).body.data;
    await api.post(`/appeals/${appeal.id}/claim`, manager.cookie);
    const decided = await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'approved', note: 'The GPS jumped there; the flag is wrong.', correction: 'exclude_flag' });
    expect(decided.status).toBe(200);
    // One speeding left: 0.25 per 100 km, safety 95: 98.25, 98.
    expect(decided.body.data).toMatchObject({ status: 'approved', outcome: 'approved', correction: 'exclude_flag', score_before: 97, score_after: 98 });
    expect((await ranking()).score).toBe(98);
    expect(await riskOf(d.trips[0].id)).toBe(false);
    expect(await riskOf(d.trips[1].id)).toBe(true);
    expect((await pool.query('SELECT 1 FROM tracking.telemetry_flags WHERE id = $1', [d.flags[0].id])).rowCount).toBe(1);

    const mine = await api.get(`/analytics/my-performance?month=${month}`, d.cookie);
    expect(mine.body.data.score).toBe(98);
    expect(mine.body.data.corrections).toEqual([expect.objectContaining({ appeal_id: appeal.id, correction: 'exclude_flag', score_before: 97, score_after: 98 })]);
    const corrected = await publishedEvents('ScoreCorrected');
    expect(corrected.find((e) => e.payload.appeal_id === appeal.id)?.payload).toMatchObject({ month, score_before: 97, score_after: 98, correction: 'exclude_flag' });
  });

  test('Exclude trip takes the whole trip out: its km, its flags', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Hana Trip');
    const manager = await staff(['fleet_manager']);
    const appeal = (await appealFlag(d, d.flags[0])).body.data;
    await api.post(`/appeals/${appeal.id}/claim`, manager.cookie);
    const decided = await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'approved', note: 'Not this driver’s trip.', correction: 'exclude_trip' });
    // 3 trips, 300 km, 1 speeding: 0.33 per 100 km, safety 93.3: (3500 + 3266.7 + 2000 + 1000) / 100 = 97.7, 98.
    expect(decided.body.data).toMatchObject({ correction: 'exclude_trip', score_before: 97, score_after: 98 });
    const month = monthOf(new Date(d.trips[0].actual_end as Date));
    expect((await api.get(`/analytics/my-performance?month=${month}`, d.cookie)).body.data.trips_completed).toBe(3);
  });

  test('rejecting without a note fails; the driver is told of the decision in the app and by push', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Iman Reject');
    await pushFor(String(d.user.id));
    const manager = await staff(['fleet_manager']);
    const appeal = (await appealFlag(d, d.flags[0])).body.data;
    await api.post(`/appeals/${appeal.id}/claim`, manager.cookie);
    const noNote = await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'rejected', note: '  ' });
    expect(noNote.status).toBe(400);
    const decided = await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'rejected', note: 'The speed is confirmed by two pings.' });
    expect(decided.body.data).toMatchObject({ status: 'rejected', decision_note: 'The speed is confirmed by two pings.', score_before: null });
    await deliverEvents();
    const told = await notices(String(d.user.id));
    expect(told.filter((n) => n.title === 'Your appeal was not approved').map((n) => n.channel).sort()).toEqual(['in_app', 'push']);
    expect(told.every((n) => n.type === 'appeal_update' && n.entity_id === appeal.id)).toBe(true);
    // Claiming was in the app only.
    expect(told.filter((n) => n.title === 'Your appeal is being reviewed').map((n) => n.channel)).toEqual(['in_app']);
    const inbox = await api.get('/notifications', d.cookie);
    expect(inbox.body.data.find((n: { type: string }) => n.type === 'appeal_update')).toMatchObject({ entity: { type: 'appeal', id: appeal.id } });
  });

  test('a reviewer who reported the incident cannot decide the appeal against it', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Kebede Incident', 0);
    const admin = await staff(['depot_admin'], depot);
    const incident = (
      await pool.query<Row>(
        "INSERT INTO alert.incident_reports (reported_by, driver_id, vehicle_id, trip_id, incident_type, description, severity, occurred_at) VALUES ($1, $2, $3, $4, 'accident', 'Scraped a gate', 'low', $5) RETURNING *",
        [admin.user.id, d.driver.id, d.truck.id, d.trips[1].id, new Date(Date.now() - HOUR)],
      )
    ).rows[0];
    const appeal = await api.post('/appeals', d.cookie, { target_type: 'incident', target_id: incident.public_id, reason: 'not_my_trip', explanation: 'I was at the depot office then, not driving.' });
    expect(appeal.status).toBe(201);
    await api.post(`/appeals/${appeal.body.data.id}/claim`, admin.cookie);
    const own = await api.post(`/appeals/${appeal.body.data.id}/decision`, admin.cookie, { outcome: 'approved', note: 'Agreed.', correction: 'exclude_incident' });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('CONFLICT_OWN_REPORT');
    const manager = await staff(['fleet_manager']);
    expect((await api.post(`/appeals/${appeal.body.data.id}/decision`, manager.cookie, { outcome: 'approved', note: 'Agreed.', correction: 'exclude_incident' })).status).toBe(200);
  });

  test('a month’s score: the reviewer names the flag it corrects', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Lemlem Month');
    const manager = await staff(['fleet_manager']);
    // Last month: its trips and flags are moved there, so it has ended and is in the window.
    const lastMonthDay = new Date(monthStart(monthOf(new Date())).getTime() - 2 * DAY);
    await pool.query('UPDATE trip.trips SET actual_start = $2, actual_end = $2::timestamptz + interval \'8 minutes\', scheduled_start = $2, scheduled_end = $2::timestamptz + interval \'8 minutes\' WHERE driver_id = $1', [d.driver.id, lastMonthDay]);
    await pool.query('UPDATE tracking.telemetry_flags SET observed_at = $2, resolved_at = $2 WHERE vehicle_id = $1', [d.truck.id, lastMonthDay]);
    const month = monthOf(lastMonthDay);
    const appealable = await api.get('/appeals/appealable', d.cookie);
    expect(appealable.body.data.months[0]).toBe(month);
    const appeal = await api.post('/appeals', d.cookie, { target_type: 'score', month, reason: 'road_conditions', explanation: 'Roadworks all month made the trips slow and flagged.' });
    expect(appeal.status).toBe(201);
    expect((await api.post('/appeals', d.cookie, { target_type: 'score', month, reason: 'other', explanation: 'Another try at the same month score.' })).status).toBe(409);
    await api.post(`/appeals/${appeal.body.data.id}/claim`, manager.cookie);
    const noItem = await api.post(`/appeals/${appeal.body.data.id}/decision`, manager.cookie, { outcome: 'approved', note: 'One flag was wrong.', correction: 'exclude_flag' });
    expect(noItem.status).toBe(400);
    const decided = await api.post(`/appeals/${appeal.body.data.id}/decision`, manager.cookie, { outcome: 'approved', note: 'One flag was wrong.', correction: 'exclude_flag', item_id: d.flags[1].public_id });
    expect(decided.body.data).toMatchObject({ score_before: 97, score_after: 98 });
  });
});

describe('deadlines', () => {
  test('an appeal not decided by its deadline escalates to the depot admin, once', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Meron Overdue');
    const admin = await staff(['depot_admin'], depot);
    const appeal = (await appealFlag(d, d.flags[0])).body.data;
    expect(new Date(appeal.due_at).getTime()).toBeGreaterThan(Date.now() + 4 * DAY);
    await pool.query("UPDATE analytics.score_appeals SET due_at = now() - interval '1 minute' WHERE public_id = $1", [appeal.id]);
    expect(await appealJobs.escalate(new Date(), randomUUID())).toEqual({ escalated: 1 });
    expect(await appealJobs.escalate(new Date(), randomUUID())).toEqual({ escalated: 0 });
    await deliverEvents();
    const alert = (await pool.query<{ id: string; depot_id: string }>("SELECT id, depot_id FROM alert.alerts WHERE alert_type = 'appeal_overdue' AND entity_id = $1", [appeal.id])).rows;
    expect(alert).toHaveLength(1);
    expect(String(alert[0].depot_id)).toBe(String(depot.id));
    expect((await pool.query('SELECT 1 FROM alert.notifications WHERE alert_id = $1 AND recipient_user_id = $2', [alert[0].id, admin.user.id])).rowCount).toBe(1);
    const view = await api.get(`/appeals/${appeal.id}`, admin.cookie);
    expect(view.body.data).toMatchObject({ overdue: true, escalated_at: expect.any(String) });
    expect((await api.get('/appeals?overdue=true', admin.cookie)).body.data.map((a: { id: string }) => a.id)).toEqual([appeal.id]);
  });

  test('a decision the driver acknowledges closes; one left alone closes after 7 days', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Nardos Close');
    const manager = await staff(['fleet_manager']);
    const one = (await appealFlag(d, d.flags[0])).body.data;
    const two = (await appealFlag(d, d.flags[1])).body.data;
    for (const a of [one, two]) {
      await api.post(`/appeals/${a.id}/claim`, manager.cookie);
      await api.post(`/appeals/${a.id}/decision`, manager.cookie, { outcome: 'rejected', note: 'Confirmed.' });
    }
    expect((await api.post(`/appeals/${one.id}/acknowledge`, d.cookie)).body.data).toMatchObject({ status: 'closed', acknowledged_at: expect.any(String) });
    expect(await appealJobs.autoClose(new Date(Date.now() + 6 * DAY), randomUUID())).toEqual({ closed: 0 });
    expect(await appealJobs.autoClose(new Date(Date.now() + 7 * DAY + 60_000), randomUUID())).toEqual({ closed: 1 });
    expect((await api.get(`/appeals/${two.id}`, d.cookie)).body.data).toMatchObject({ status: 'closed', outcome: 'rejected', acknowledged_at: null });
  });
});

describe('the timeline and the files', () => {
  test('every step with who and when; the files download only for the driver and the reviewers, by a recorded signed link', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Rahel Timeline');
    const manager = await staff(['fleet_manager']);
    const appeal = (await appealFlag(d, d.flags[0], [{ bytes: JPEG, name: 'speedo.jpg', type: 'image/jpeg' }])).body.data;
    await api.post(`/appeals/${appeal.id}/claim`, manager.cookie);
    await api.post(`/appeals/${appeal.id}/comments`, manager.cookie, { body: 'Which bridge was it?' });
    await api.post(`/appeals/${appeal.id}/comments`, d.cookie, { body: 'The Kality one.' });
    await api.post(`/appeals/${appeal.id}/decision`, manager.cookie, { outcome: 'approved', note: 'Agreed.', correction: 'exclude_flag' });
    await api.post(`/appeals/${appeal.id}/acknowledge`, d.cookie);

    const file = appeal.attachments[0];
    const link = await api.get(`/appeals/${appeal.id}/attachments/${file.id}/link`, d.cookie);
    expect(link.status).toBe(200);
    const bytes = await request(app).get(link.body.data.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(bytes.body as Buffer, JPEG)).toBe(0);
    expect((await request(app).get(link.body.data.url.replace(/signature=[0-9a-f]{4}/, 'signature=0000'))).status).toBe(401);
    expect((await api.get(`/appeals/${appeal.id}/attachments/${file.id}/link`, manager.cookie)).status).toBe(200);
    const stranger = await driverWithMonth(depot, 'Selam Stranger', 0);
    expect((await api.get(`/appeals/${appeal.id}/attachments/${file.id}/link`, stranger.cookie)).status).toBe(404);
    const finance = await staff(['finance_clerk'], depot);
    expect((await api.get(`/appeals/${appeal.id}/attachments/${file.id}/link`, finance.cookie)).status).toBe(403);

    const asReviewer = (await api.get(`/appeals/${appeal.id}`, manager.cookie)).body.data.timeline;
    expect(asReviewer.map((e: { type: string }) => e.type)).toEqual(['submitted', 'claimed', 'commented', 'commented', 'approved', 'acknowledged', 'closed', 'attachment_opened', 'attachment_opened']);
    expect(asReviewer[1].actor.name).toBe('Reviewer fleet_manager');
    expect(asReviewer[3]).toMatchObject({ body: 'The Kality one.', actor: { name: 'Rahel Timeline' }, at: expect.any(String) });
    // The driver's timeline leaves out who opened the files.
    const asDriver = (await api.get(`/appeals/${appeal.id}`, d.cookie)).body.data.timeline;
    expect(asDriver.map((e: { type: string }) => e.type)).not.toContain('attachment_opened');
    // Never deleted: the rows stay.
    expect((await pool.query('SELECT 1 FROM analytics.appeal_events e JOIN analytics.score_appeals a ON a.id = e.appeal_id WHERE a.public_id = $1', [appeal.id])).rowCount).toBe(9);
  });

  test('the KPI figures: opened, share approved, median days to a decision', async () => {
    const depot = await createDepot();
    const d = await driverWithMonth(depot, 'Tigist Kpi');
    const manager = await staff(['fleet_manager']);
    for (const [i, outcome] of (['approved', 'rejected'] as const).entries()) {
      const a = (await appealFlag(d, d.flags[i])).body.data;
      await api.post(`/appeals/${a.id}/claim`, manager.cookie);
      await api.post(`/appeals/${a.id}/decision`, manager.cookie, { outcome, note: 'Decided.', ...(outcome === 'approved' ? { correction: 'exclude_flag' } : {}) });
    }
    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const k = await api.get(`/appeals/kpis?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&depot_id=${depot.public_id}`, manager.cookie);
    expect(k.body.data).toMatchObject({ opened: 2, decided: 2, approved: 1, approved_share: 0.5, median_days_to_decision: 0 });
  });
});
