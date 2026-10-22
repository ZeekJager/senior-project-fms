import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { ALERT_EVENTS, alertEngine } from '../../src/modules/alert';
import { fleetModule } from '../../src/modules/fleet';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { addisDate } from '../support/dates';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-92: the alert engine. Source events are published as their modules publish them, then delivered
// by the relay, as in production.

const app = createApp();
const PASSWORD = 'Alert-Engine-Test-1';
type Row = Record<string, unknown> & { id: string };
const MIN = 60_000;

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<{ cookie: string; user: Row }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), user };
}

/** Publishes events as a module would, in a committed transaction, then lets the relay deliver them. */
async function emit(...events: { type: string; payload: Record<string, unknown> }[]) {
  await withTransaction(pool, (tx) =>
    eventBus.publish(
      tx,
      events.map((e) => createEvent(e.type, e.payload, { actor: null, correlationId: randomUUID() })),
    ),
  );
  await deliverEvents();
}

const fault = (vehicle: Row, extra: Record<string, unknown> = {}) => ({
  type: 'VehicleFaultDetected',
  payload: {
    source: 'dvir',
    dvir_report_id: randomUUID(),
    vehicle_id: vehicle.public_id,
    driver_id: null,
    trip_id: null,
    inspection_type: 'pre_trip',
    defect_count: 2,
    defects: ['Brakes', 'Lights'],
    maintenance_flag_set: true,
    ...extra,
  },
});

const alertsOf = async (vehicle: Row) =>
  (await pool.query('SELECT * FROM alert.alerts WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows as Row[];
const recipientsOf = async (alert: Row) =>
  (
    await pool.query("SELECT recipient_user_id::text AS id, notification_type, channel, status FROM alert.notifications WHERE alert_id = $1 ORDER BY recipient_user_id", [alert.id])
  ).rows as { id: string; notification_type: string; channel: string; status: string }[];
const get = (cookie: string, path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const post = (cookie: string, path: string, body: object = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);

describe('raising alerts from events', () => {
  test("a vehicle fault becomes one alert for the vehicle's depot, told to its technicians and depot admins", async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-77001' });
    const { driver } = await createDriver({ depot });
    const trip = await createTrip({ vehicle, driver, status: 'en_route', actual_start: new Date().toISOString() });
    const technician = await createUser({ roles: ['technician'], depot });
    const depotAdmin = await createUser({ roles: ['depot_admin'], depot });
    const elsewhere = await createUser({ roles: ['technician'], depot: other });
    const inactive = await createUser({ roles: ['technician'], depot, status: 'inactive' });
    const manager = await createUser({ roles: ['fleet_manager'] });

    await emit(fault(vehicle, { driver_id: driver.public_id, trip_id: trip.public_id }));

    const [alert] = await alertsOf(vehicle);
    expect(alert).toMatchObject({
      alert_type: 'vehicle_fault',
      severity: 'high',
      status: 'open',
      source_module: 'fleet',
      source_event_type: 'VehicleFaultDetected',
      title: 'Defects reported on AA 3-77001',
      description: '2 defects on the pre-trip inspection: Brakes, Lights.',
      depot_id: depot.id,
      driver_id: driver.id,
      trip_id: trip.id,
      entity_type: 'dvir_report',
      occurrence_count: 1,
      escalation_level: 0,
    });
    // Tier 0 only: the depot's technicians and depot admins, active ones. Fleet managers hear on escalation.
    const told = (await recipientsOf(alert)).map((r) => r.id);
    expect(told.sort()).toEqual([technician.id, depotAdmin.id].map(String).sort());
    expect(told).not.toContain(String(elsewhere.id));
    expect(told).not.toContain(String(inactive.id));
    expect(told).not.toContain(String(manager.id));
    expect((await recipientsOf(alert))[0]).toMatchObject({ notification_type: 'alert', channel: 'in_app', status: 'delivered' });

    const [created] = await publishedEvents(ALERT_EVENTS.created);
    expect(created.payload).toMatchObject({
      alert_id: alert.public_id,
      depot_id: depot.public_id,
      alert_type: 'vehicle_fault',
      severity: 'high',
      priority: 2,
      status: 'open',
      vehicle_id: vehicle.public_id,
      title: 'Defects reported on AA 3-77001',
    });
    expect(created.aggregate).toBe(`alert:${alert.public_id}`);
  });

  test('a repeat within the window updates the one alert, never lowers its severity, and tells nobody again', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await createUser({ roles: ['technician'], depot });

    await emit(fault(vehicle));
    await emit(fault(vehicle, { severity: 'critical', defects: ['Steering'], defect_count: 1 }));
    await emit(fault(vehicle, { severity: 'low' }));

    const alerts = await alertsOf(vehicle);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ occurrence_count: 3, severity: 'critical' });
    expect(await recipientsOf(alerts[0])).toHaveLength(1);
    const updates = await publishedEvents(ALERT_EVENTS.updated);
    expect(updates.map((e) => e.payload.occurrence_count)).toEqual([2, 3]);
    expect(updates[1].payload).toMatchObject({ alert_id: alerts[0].public_id, severity: 'critical', priority: 1 });
  });

  test('after the window, or once resolved, a repeat opens a new alert', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await emit(fault(vehicle));
    // Last seen 61 minutes ago: past the fault rule's 60-minute window.
    await pool.query("UPDATE alert.alerts SET last_occurred_at = now() - interval '61 minutes' WHERE vehicle_id = $1", [vehicle.id]);
    await emit(fault(vehicle));
    expect(await alertsOf(vehicle)).toHaveLength(2);

    await pool.query("UPDATE alert.alerts SET status = 'resolved', resolved_at = now() WHERE vehicle_id = $1", [vehicle.id]);
    await emit(fault(vehicle));
    const alerts = await alertsOf(vehicle);
    expect(alerts.map((a) => a.status)).toEqual(['resolved', 'resolved', 'open']);
  });

  test("expiry warnings: a vehicle document is the vehicle's depot's; a licence, the driver's depot's", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-77002' });
    const { driver } = await createDriver({ depot });
    await createUser({ roles: ['depot_admin'], depot });
    const documentId = randomUUID();

    await emit(
      {
        type: 'DocumentExpiring',
        payload: { document_id: documentId, owner_type: 'vehicle', owner_id: vehicle.public_id, document_type: 'insurance', expires_on: '2026-11-20', days_left: 30, level: 'amber' },
      },
      { type: 'LicenceExpiring', payload: { driver_id: driver.public_id, user_id: null, depot_id: depot.public_id, license_expiry: '2026-10-25', days_left: 4, level: 'red' } },
    );
    // The red level of the same document: the same alert, now high.
    await emit({
      type: 'DocumentExpiring',
      payload: { document_id: documentId, owner_type: 'vehicle', owner_id: vehicle.public_id, document_type: 'insurance', expires_on: '2026-11-20', days_left: 7, level: 'red' },
    });

    const rows = (await pool.query('SELECT * FROM alert.alerts WHERE depot_id = $1 ORDER BY id', [depot.id])).rows;
    expect(rows.map((r) => [r.alert_type, r.severity, r.occurrence_count])).toEqual([
      ['document_expiring', 'high', 2],
      ['licence_expiring', 'high', 1],
    ]);
    expect(rows[0]).toMatchObject({ title: 'Insurance expires in 7 days', entity_type: 'document', entity_id: documentId });
    expect(rows[1]).toMatchObject({ driver_id: driver.id, entity_type: 'driver', entity_id: driver.public_id });
  });

  test('end to end: the daily document check (FMS-26) raises DocumentExpiring, and the engine an alert', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-77004' });
    const uploader = await createUser({ roles: ['admin'] });
    const admin = await createUser({ roles: ['depot_admin'], depot });
    const expiresOn = addisDate(5);
    await pool.query(
      `INSERT INTO document.documents (owner_type, owner_id, document_type, storage_key, content_type, size_bytes, sha256, uploaded_by, expires_on)
       VALUES ('vehicle', $1, 'insurance', $2, 'application/pdf', 100, $3, $4, $5)`,
      [vehicle.id, `test/${randomUUID()}`, randomUUID().replaceAll('-', '').repeat(2), uploader.id, expiresOn],
    );
    const check = fleetModule.jobs!.find((j) => j.name === 'document-expiry-check')!;
    await check.run({ now: new Date(), correlationId: randomUUID(), runKey: 'test' });
    await deliverEvents();

    const [alert] = await alertsOf(vehicle);
    expect(alert).toMatchObject({ alert_type: 'document_expiring', severity: 'high', depot_id: depot.id, entity_type: 'document' });
    expect(alert.description).toBe(`The insurance of AA 3-77004 expires on ${expiresOn}.`);
    expect((await recipientsOf(alert)).map((r) => r.id)).toEqual([String(admin.id)]);
  });

  test('an event of a planned source (the telemetry rules) is an alert by its contract', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-77003' });
    await emit({ type: 'TelemetryFlagRaised', payload: { flag_id: randomUUID(), vehicle_id: vehicle.public_id, flag_type: 'speeding', observed_at: new Date().toISOString() } });
    const [alert] = await alertsOf(vehicle);
    expect(alert).toMatchObject({ alert_type: 'unsafe_driving', severity: 'high', title: 'Speeding: AA 3-77003', source_module: 'integration' });
  });
});

describe('acknowledge and resolve', () => {
  test('acknowledging records who and when, with the comment; it cannot happen twice; resolving closes it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await emit(fault(vehicle));
    const [alert] = await alertsOf(vehicle);
    const { cookie, user } = await signIn(['dispatcher'], depot);

    const acked = await post(cookie, `/alerts/${alert.public_id}/acknowledge`, { comment: 'Calling the driver' });
    expect(acked.status).toBe(200);
    expect(acked.body.data).toMatchObject({ id: alert.public_id, status: 'acknowledged', acknowledged_by: user.public_id, acknowledged_at: expect.any(String) });
    const history = (await pool.query('SELECT user_id, action, comment FROM alert.alert_acknowledgements WHERE alert_id = $1', [alert.id])).rows;
    expect(history).toEqual([{ user_id: user.id, action: 'acknowledge', comment: 'Calling the driver' }]);
    const audited = (await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'alert.alerts' AND entity_id = $1 ORDER BY id", [alert.id])).rows;
    expect(audited.map((r) => r.action)).toContain('UPDATE');
    const [event] = await publishedEvents(ALERT_EVENTS.acknowledged);
    expect(event).toMatchObject({ actor: user.public_id, payload: { alert_id: alert.public_id, depot_id: depot.public_id, status: 'acknowledged', acknowledged_by: user.public_id } });

    const again = await post(cookie, `/alerts/${alert.public_id}/acknowledge`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'alert_acknowledged' }] });

    const resolved = await post(cookie, `/alerts/${alert.public_id}/resolve`);
    expect(resolved.body.data).toMatchObject({ status: 'resolved', resolved_by: user.public_id, acknowledged_by: user.public_id });
    expect((await post(cookie, `/alerts/${alert.public_id}/resolve`)).status).toBe(409);
    expect((await publishedEvents(ALERT_EVENTS.resolved))[0].payload).toMatchObject({ status: 'resolved', resolved_by: user.public_id });
  });

  test('permissions and depot scope: alert:ack, alert:resolve, and another depot is not found', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await emit(fault(vehicle));
    const [alert] = await alertsOf(vehicle);

    const technician = await signIn(['technician'], depot);
    expect((await get(technician.cookie, `/alerts/${alert.public_id}`)).status).toBe(200);
    expect((await post(technician.cookie, `/alerts/${alert.public_id}/acknowledge`)).status).toBe(403);
    const depotAdmin = await signIn(['depot_admin'], depot);
    expect((await post(depotAdmin.cookie, `/alerts/${alert.public_id}/resolve`)).status).toBe(403);
    const driver = await signIn(['driver'], depot);
    expect((await get(driver.cookie, '/alerts')).status).toBe(403);

    const otherDepot = await signIn(['dispatcher'], await createDepot());
    expect((await get(otherDepot.cookie, `/alerts/${alert.public_id}`)).status).toBe(404);
    expect((await post(otherDepot.cookie, `/alerts/${alert.public_id}/acknowledge`)).status).toBe(404);
    expect((await post(otherDepot.cookie, `/alerts/${alert.public_id}/acknowledge`, { note: 'x' })).status).toBe(400);
    expect((await get(otherDepot.cookie, '/alerts/not-a-uuid')).status).toBe(404);
  });
});

describe('GET /alerts', () => {
  test("a depot's staff see their depot's alerts; filters and priority order", async () => {
    const a = await createDepot();
    const b = await createDepot();
    const inA = await createVehicle({ depot: a });
    const otherInA = await createVehicle({ depot: a });
    const inB = await createVehicle({ depot: b });
    await emit(fault(inA), fault(otherInA, { severity: 'critical' }), fault(inB));

    const dispatcher = await signIn(['dispatcher'], a);
    const all = await get(dispatcher.cookie, '/alerts');
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ page: 1, total_items: 2 });
    expect(all.body.data.map((x: { vehicle_id: string }) => x.vehicle_id).sort()).toEqual([inA.public_id, otherInA.public_id].sort());

    const byPriority = await get(dispatcher.cookie, '/alerts?sort=priority');
    expect(byPriority.body.data.map((x: { severity: string; priority: number }) => [x.severity, x.priority])).toEqual([
      ['critical', 1],
      ['high', 2],
    ]);
    expect((await get(dispatcher.cookie, '/alerts?severity=critical')).body.data).toHaveLength(1);
    expect((await get(dispatcher.cookie, `/alerts?vehicle_id=${inA.public_id}&status=open,acknowledged&type=vehicle_fault`)).body.data).toHaveLength(1);
    expect((await get(dispatcher.cookie, `/alerts?depot_id=${b.public_id}`)).body.data).toEqual([]);

    const manager = await signIn(['fleet_manager']);
    expect((await get(manager.cookie, `/alerts?depot_id=${b.public_id}`)).body.data.map((x: { vehicle_id: string }) => x.vehicle_id)).toEqual([inB.public_id]);

    const bad = await get(dispatcher.cookie, '/alerts?status=closed&sort=oldest');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_INVALID_ENUM');
  });
});

describe('escalation', () => {
  test('a critical alert unacknowledged for 15 minutes goes to fleet managers, after 30 to admins, then stops', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await createUser({ roles: ['technician'], depot });
    const manager = await createUser({ roles: ['fleet_manager'] });
    const admin = await createUser({ roles: ['admin'] });
    await emit(fault(vehicle, { severity: 'critical' }));
    const [alert] = await alertsOf(vehicle);
    // created_at has microseconds a JS Date drops: a second past each mark.
    const raised = new Date(alert.created_at as string).getTime() + 1000;
    const run = (minutesLater: number) => alertEngine.escalate(new Date(raised + minutesLater * MIN), randomUUID());

    expect(await run(14)).toEqual({ escalated: 0, notified: 0 });
    // The 15-minute run, a couple of milliseconds short of the mark (scheduler jitter), still escalates.
    const first = await alertEngine.escalate(new Date(raised - 1000 + 15 * MIN - 2), randomUUID());
    expect(first.escalated).toBe(1);
    let [row] = await alertsOf(vehicle);
    expect(row).toMatchObject({ escalation_level: 1, status: 'open' });
    const tier1 = (await recipientsOf(alert)).filter((r) => r.notification_type === 'alert_escalated').map((r) => r.id);
    expect(tier1).toContain(String(manager.id));
    expect(tier1).not.toContain(String(admin.id));
    const [escalated] = await publishedEvents(ALERT_EVENTS.escalated);
    expect(escalated.payload).toMatchObject({ alert_id: alert.public_id, depot_id: depot.public_id, escalation_level: 1 });

    expect((await run(29)).escalated).toBe(0);
    expect((await run(30)).escalated).toBe(1);
    [row] = await alertsOf(vehicle);
    expect(row.escalation_level).toBe(2);
    expect((await recipientsOf(alert)).map((r) => r.id)).toContain(String(admin.id));
    // No tier after the admins.
    expect((await run(120)).escalated).toBe(0);
  });

  test('an acknowledged critical alert, or a high one, never escalates', async () => {
    const depot = await createDepot();
    const critical = await createVehicle({ depot });
    const high = await createVehicle({ depot });
    await emit(fault(critical, { severity: 'critical' }), fault(high));
    const { cookie } = await signIn(['dispatcher'], depot);
    const [alert] = await alertsOf(critical);
    expect((await post(cookie, `/alerts/${alert.public_id}/acknowledge`)).status).toBe(200);
    expect(await alertEngine.escalate(new Date(Date.now() + 60 * MIN), randomUUID())).toEqual({ escalated: 0, notified: 0 });
  });
});
