import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { generateVapidKeys, integrationGateway, notificationAdapter } from '../../src/modules/integration';
import { serviceDueJob } from '../../src/modules/maintenance';
import { addisDate } from '../support/dates';
import { deliverEvents } from '../support/events';
import { copyDriverAccount, createDepot, createProvider, createUser, createVehicle } from '../support/factories';

// FMS-149: a driver receives their own licence-expiry alerts and the service-due alerts of the vehicle they drive, in
// the app and by push only, in their own words. The alerts stay their audience's (depot admins, technicians) to act on.

const app = createApp();
const PASSWORD = 'Driver-Deadline-1';
const DAY = 86_400_000;
type Row = Record<string, unknown> & { id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

const vapid = generateVapidKeys();
const PUSH_CODE = `push-${randomUUID().slice(0, 8)}`;
let registered = false;

/** Push on, so what a driver is sent by push is queued. Nothing is sent: the delivery job is not run here. Each test's data is its own. */
async function pushOn() {
  if (!registered) {
    integrationGateway.register(notificationAdapter(PUSH_CODE, { pushHosts: ['127.0.0.1'], allowHttpPush: true }));
    Object.assign(config.integrations.secrets, { [PUSH_CODE]: { apiKey: vapid.privateKey } });
    registered = true;
  }
  await createProvider({ code: PUSH_CODE, provider_type: 'notification', configuration: { channel: 'push', vapid_public_key: vapid.publicKey, subject: 'mailto:ops@fleet.test', max_retries: 0 } });
}

/** A browser with push on for this user. */
async function withPush(userId: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  await pool.query('INSERT INTO alert.push_subscriptions (user_id, endpoint, p256dh, auth_secret) VALUES ($1, $2, $3, $4)', [
    userId,
    `http://127.0.0.1:9/push/${randomUUID()}`,
    ecdh.getPublicKey().toString('base64url'),
    randomBytes(16).toString('base64url'),
  ]);
}

async function signIn(user: Row) {
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function driver(depot: Depot, extra: Record<string, unknown> = {}) {
  const user = await createUser({ roles: ['driver'], depot, password: PASSWORD, fullName: 'Test Driver' });
  await copyDriverAccount(String(user.id));
  const row = (
    await pool.query<Row>("INSERT INTO fleet.drivers (user_id, license_number, license_expiry, license_categories) VALUES ($1, $2, $3, ARRAY['dry_cargo_2']) RETURNING *", [
      user.id,
      `LIC-${randomUUID().slice(0, 8)}`,
      (extra.license_expiry as string) ?? '2030-12-31',
    ])
  ).rows[0];
  return { user: user as Row, driver: row };
}

/** Every notification a user was given, as they were given it. */
const notesOf = async (userId: string) =>
  (
    await pool.query<{ type: string; channel: string; title: string; message: string; alert_type: string }>(
      `SELECT n.notification_type AS type, n.channel::text AS channel, n.title, n.message, a.alert_type
         FROM alert.notifications n JOIN alert.alerts a ON a.id = n.alert_id
        WHERE n.recipient_user_id = $1 ORDER BY n.id`,
      [userId],
    )
  ).rows;

const licenceJob = () => fleetModule.jobs!.find((j) => j.name === 'licence-expiry-check')!;
const checkLicences = (now = new Date()) => licenceJob().run({ now, correlationId: randomUUID(), runKey: randomUUID() });

describe('a driver alerted to their own licence expiring (FMS-149)', () => {
  test('the driver gets the amber and the red warning in the app and by push, in their own words; another driver gets none', async () => {
    await pushOn();
    const depot = await createDepot();
    const admin = (await createUser({ roles: ['depot_admin'], depot })) as Row;
    const expiring = await driver(depot, { license_expiry: addisDate(20) });
    const other = await driver(depot, { license_expiry: '2030-12-31' });
    await withPush(String(expiring.user.id));
    await withPush(String(other.user.id));

    await checkLicences();
    await deliverEvents();
    expect(await notesOf(String(expiring.user.id))).toEqual([
      {
        type: 'alert_personal',
        channel: 'in_app',
        alert_type: 'licence_expiring',
        title: 'Your driving licence expires in 20 days',
        message: `Your driving licence expires on ${addisDate(20)}. Renew it and show the new one at the depot office: without a valid licence you cannot be given trips.`,
      },
      // Push, whatever the severity: amber is medium, which stays in the app for everyone else.
      expect.objectContaining({ type: 'alert_personal', channel: 'push', title: 'Your driving licence expires in 20 days' }),
    ]);
    // The depot admin's, as before: in the app, in the office's words.
    expect(await notesOf(String(admin.id))).toEqual([
      expect.objectContaining({ type: 'alert', channel: 'in_app', alert_type: 'licence_expiring', message: expect.stringMatching(/^A driver's licence expires on/) }),
    ]);
    // Never another driver's licence.
    expect(await notesOf(String(other.user.id))).toEqual([]);

    // Fifteen days on, five are left: red. The same alert grows to high, and the driver is told again.
    await checkLicences(new Date(Date.now() + 15 * DAY));
    await deliverEvents();
    const notes = await notesOf(String(expiring.user.id));
    expect(notes.map((n) => [n.channel, n.title])).toEqual([
      ['in_app', 'Your driving licence expires in 20 days'],
      ['push', 'Your driving licence expires in 20 days'],
      ['in_app', 'Your driving licence expires in 5 days'],
      ['push', 'Your driving licence expires in 5 days'],
    ]);
    // Never by email or SMS.
    expect(notes.every((n) => n.channel === 'in_app' || n.channel === 'push')).toBe(true);
    expect((await pool.query("SELECT severity FROM alert.alerts WHERE alert_type = 'licence_expiring' AND driver_id = $1", [expiring.driver.id])).rows).toEqual([{ severity: 'high' }]);
    expect(await notesOf(String(other.user.id))).toEqual([]);

    // In their inbox, which opens nothing of the office's.
    const inbox = await request(app).get('/api/v1/notifications').set('Cookie', await signIn(expiring.user));
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((n: { type: string; title: string }) => [n.type, n.title])).toEqual([
      ['alert_personal', 'Your driving licence expires in 5 days'],
      ['alert_personal', 'Your driving licence expires in 20 days'],
    ]);
  });

  test('a retired driver, or one whose account is not active, is not told', async () => {
    const depot = await createDepot();
    const retired = await driver(depot, { license_expiry: addisDate(10) });
    await pool.query('UPDATE fleet.drivers SET is_active = false WHERE id = $1', [retired.driver.id]);
    const suspended = await driver(depot, { license_expiry: addisDate(10) });
    await pool.query("UPDATE fleet.driver_accounts SET account_status = 'suspended' WHERE user_id = $1", [suspended.user.id]);
    await checkLicences();
    await deliverEvents();
    expect(await notesOf(String(retired.user.id))).toEqual([]);
    expect(await notesOf(String(suspended.user.id))).toEqual([]);
  });
});

describe("a vehicle's service due reaches the driver of its next trip (FMS-149)", () => {
  const runService = () => serviceDueJob.run({ now: new Date(), correlationId: randomUUID(), runKey: randomUUID() });
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  async function trip(depot: Depot, vehicle: Row, d: Row, status: 'assigned' | 'en_route' | 'scheduled', from: number, to: number) {
    const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Addis Ababa - Adama ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
    await pool.query(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [route.id, vehicle.id, status === 'scheduled' ? null : d.id, status, at(from), at(to), status === 'en_route' ? at(from) : null],
    );
  }

  test('due and overdue reach the driver of its trip under way, else its next assigned one; nobody else, and only as information', async () => {
    await pushOn();
    const depot = await createDepot();
    const manager = await createUser({ roles: ['fleet_manager'], depot, password: PASSWORD });
    const technician = (await createUser({ roles: ['technician'], depot })) as Row;
    const truck = (await createVehicle({ depot, odometer_km: 9600, created_at: new Date(Date.now() - DAY) })) as Row;
    const onRoad = (await createVehicle({ depot, odometer_km: 9600, created_at: new Date(Date.now() - DAY) })) as Row;
    const next = await driver(depot);
    const later = await driver(depot);
    const driving = await driver(depot);
    const elsewhere = await driver(depot);
    const unrelated = (await createVehicle({ depot, odometer_km: 100 })) as Row;
    // The truck: an old assigned trip already over (not counted), the next assigned one, and a later one.
    await trip(depot, truck, later.driver, 'assigned', -30, -27);
    await trip(depot, truck, next.driver, 'assigned', 5, 8);
    await trip(depot, truck, later.driver, 'assigned', 30, 33);
    // The other one is under way with one driver, and assigned to another after.
    await trip(depot, onRoad, driving.driver, 'en_route', -1, 2);
    await trip(depot, onRoad, later.driver, 'assigned', 10, 13);
    await trip(depot, unrelated, elsewhere.driver, 'assigned', 5, 8);
    await withPush(String(next.user.id));

    const created = await request(app)
      .post('/api/v1/service-programs')
      .set('Cookie', await signIn(manager as Row))
      .send({ name: 'B-service', interval_km: 10_000, lead_km: 500 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await runService();
    await deliverEvents();

    const plate = String(truck.registration_number);
    expect(await notesOf(String(next.user.id))).toEqual([
      {
        type: 'alert_personal',
        channel: 'in_app',
        alert_type: 'service_due',
        title: `B-service due: ${plate}`,
        message: `${plate}, the vehicle you drive next, is due for service at 10,000 km (odometer 9,600 km). The workshop books it in; there is nothing for you to do.`,
      },
      expect.objectContaining({ type: 'alert_personal', channel: 'push' }),
    ]);
    expect((await notesOf(String(driving.user.id))).map((n) => [n.channel, n.title])).toEqual([['in_app', `B-service due: ${onRoad.registration_number}`]]);
    expect(await notesOf(String(later.user.id))).toEqual([]);
    expect(await notesOf(String(elsewhere.user.id))).toEqual([]);
    // The technician's, as before.
    expect((await notesOf(String(technician.id))).map((n) => n.type)).toEqual(['alert', 'alert']);

    // Overdue: the same alert raised to high; the driver is told again.
    await pool.query('UPDATE fleet.vehicles SET odometer_km = 10050 WHERE id = $1', [truck.id]);
    await runService();
    await deliverEvents();
    const notes = await notesOf(String(next.user.id));
    expect(notes.map((n) => [n.channel, n.title])).toEqual([
      ['in_app', `B-service due: ${plate}`],
      ['push', `B-service due: ${plate}`],
      ['in_app', `B-service overdue: ${plate}`],
      ['push', `B-service overdue: ${plate}`],
    ]);
    expect(notes[2].message).toMatch(/is past its service, which fell due at 10,000 km .*The workshop books it in/);

    // Information only: a driver acts on no alert.
    const alertId = (await pool.query<{ public_id: string }>("SELECT public_id FROM alert.alerts WHERE vehicle_id = $1 AND alert_type = 'service_due'", [truck.id])).rows[0].public_id;
    const cookie = await signIn(next.user);
    expect((await request(app).post(`/api/v1/alerts/${alertId}/acknowledge`).set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).post(`/api/v1/alerts/${alertId}/resolve`).set('Cookie', cookie)).status).toBe(403);
  });
});
