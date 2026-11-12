import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-151: an assignment that raises a warning the depot holds is an exception a fleet manager approves, not one the
// dispatcher makes alone; the request, the decision, who made it and why are recorded. The safety rules (BR-1,
// BR-2, BR-8) refuse as before and are never held.

const app = createApp();
const PASSWORD = 'Approve-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string; public_id: string };

async function account(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const post = (cookie: string, path: string, body: Record<string, unknown> = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const getTrip = async (cookie: string, trip: Row) => (await request(app).get(`/api/v1/trips/${trip.public_id}`).set('Cookie', cookie)).body.data;
const tripRow = async (trip: Row) => (await pool.query('SELECT status, driver_id::text, vehicle_id::text, version FROM trip.trips WHERE id = $1', [trip.id])).rows[0];
const exceptionRows = async (trip: Row) =>
  (await pool.query('SELECT status, reason, decision_reason FROM trip.assignment_exceptions WHERE trip_id = $1 ORDER BY id', [trip.id])).rows;

/** A scheduled trip of the depot, 2026-11-02 06:00-09:00 UTC (09:00 in Addis Ababa). */
async function scheduled(depot: Depot) {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Addis Ababa - Adama ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
  return (
    await pool.query<Row>(
      "INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', '2026-11-02T06:00:00Z', '2026-11-02T09:00:00Z') RETURNING *",
      [route.id],
    )
  ).rows[0];
}

/**
 * A depot that holds the driver's attendance for approval, a dispatcher and a fleet manager, a truck, a truck
 * driver marked absent on the trip's day, and the trip.
 */
async function setup(policies: { attendance?: 'warn' | 'approve'; overrun?: 'warn' | 'approve' } = { attendance: 'approve' }) {
  const depot = await createDepot();
  await pool.query('INSERT INTO tracking.rule_thresholds (depot_id, attendance_exception, overrun_exception) VALUES ($1, $2, $3)', [
    depot.id,
    policies.attendance ?? 'warn',
    policies.overrun ?? 'warn',
  ]);
  const dispatcher = await account(['dispatcher'], depot);
  const manager = await account(['fleet_manager'], depot);
  const vehicle = (await createVehicle({ depot })) as Row;
  const driver = (await createDriver({ depot, license_categories: ['C'] })).driver as Row;
  const clerk = await createUser({ roles: ['depot_admin'], depot });
  await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, '2026-11-02', 'absent', $2)", [driver.id, clerk.id]);
  const trip = await scheduled(depot);
  const body = { driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: 0 };
  return { depot, dispatcher, manager, vehicle, driver, trip, body };
}

describe('assignment exceptions (FMS-151)', () => {
  test('a held assignment needs a reason, waits as a request, and assigns the trip only when a fleet manager approves', async () => {
    const s = await setup();
    const assign = (extra: Record<string, unknown> = {}) => post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, ...extra });

    // No reason: 409 naming the warning; nothing changes.
    const asked = await assign();
    expect(asked.status).toBe(409);
    expect(asked.body.error).toMatchObject({ code: 'CONFLICT_APPROVAL_REQUIRED', details: [{ field: 'driver_id', reason: 'driver_absent' }] });
    expect(await exceptionRows(s.trip)).toEqual([]);

    // With one: 202, the request; the trip stays unassigned and shows it waiting.
    const held = await assign({ exception_reason: 'Only licensed driver free today; absence logged by mistake.' });
    expect(held.status).toBe(202);
    expect(held.body.data).toMatchObject({
      trip_id: s.trip.public_id,
      status: 'pending',
      driver_id: s.driver.public_id,
      vehicle_id: s.vehicle.public_id,
      warnings: [{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }],
      reason: 'Only licensed driver free today; absence logged by mistake.',
      requested_by: s.dispatcher.user.public_id,
      requested_by_name: expect.any(String),
      decided_by: null,
    });
    expect(await tripRow(s.trip)).toMatchObject({ status: 'scheduled', driver_id: null, version: 0 });
    expect((await getTrip(s.dispatcher.cookie, s.trip)).exception).toMatchObject({ id: held.body.data.id, status: 'pending' });
    const [requested] = await publishedEvents('AssignmentExceptionRequested');
    expect(requested.payload).toMatchObject({ trip_id: s.trip.public_id, exception_id: held.body.data.id, depot_id: s.depot.public_id, warnings: ['DRIVER_ATTENDANCE'] });
    expect(await publishedEvents('TripAssigned')).toEqual([]);
    const requestAudit = await pool.query('SELECT action, entity_type, user_id::text FROM audit.audit_logs WHERE correlation_id = $1', [held.headers['x-request-id']]);
    expect(requestAudit.rows).toEqual([{ action: 'INSERT', entity_type: 'trip.assignment_exceptions', user_id: String(s.dispatcher.user.id) }]);

    // The depot's fleet managers are told.
    await deliverEvents();
    const alert = (await pool.query("SELECT id, severity, entity_type, entity_id, description FROM alert.alerts WHERE alert_type = 'assignment_exception' AND trip_id = $1", [s.trip.id])).rows[0];
    expect(alert).toMatchObject({ severity: 'medium', entity_type: 'trip_assignment', entity_id: s.trip.public_id });
    expect(alert.description).toContain('absence logged by mistake');
    const told = (await pool.query('SELECT recipient_user_id::text AS id FROM alert.notifications WHERE alert_id = $1', [alert.id])).rows.map((r) => r.id);
    expect(told).toContain(String(s.manager.user.id));
    expect(told).not.toContain(String(s.dispatcher.user.id));

    // A dispatcher cannot approve; a fleet manager does, and every rule is read again.
    expect((await post(s.dispatcher.cookie, `/assignment-exceptions/${held.body.data.id}/approve`)).status).toBe(403);
    const approved = await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/approve`, { note: 'Confirmed with the depot.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', decided_by: s.manager.user.public_id, decision_reason: 'Confirmed with the depot.' });
    expect(approved.body.meta.trip).toMatchObject({ id: s.trip.public_id, status: 'assigned', driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, exception: null });
    expect(approved.body.meta.warnings).toEqual([{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }]);
    const [assigned] = await publishedEvents('TripAssigned');
    expect(assigned.payload).toMatchObject({ trip_id: s.trip.public_id, exception_id: held.body.data.id });
    const [decided] = await publishedEvents('AssignmentExceptionDecided');
    expect(decided.payload).toMatchObject({ exception_id: held.body.data.id, decision: 'approved', requested_by: s.dispatcher.user.public_id });
    const decisionAudit = await pool.query('SELECT action, entity_type, user_id::text FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [approved.headers['x-request-id']]);
    expect(decisionAudit.rows).toEqual([
      { action: 'UPDATE', entity_type: 'trip.assignment_exceptions', user_id: String(s.manager.user.id) },
      { action: 'UPDATE', entity_type: 'trip.trips', user_id: String(s.manager.user.id) },
    ]);

    // Decided once.
    const again = await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/refuse`, { reason: 'Too late' });
    expect(again.status).toBe(409);
    expect(again.body.error.details).toEqual([{ field: 'status', reason: 'exception_approved' }]);
  });

  test('a refused request leaves the trip unassigned and tells the dispatchers why', async () => {
    const s = await setup();
    const held = await post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, exception_reason: 'Short of drivers.' });
    expect(held.status).toBe(202);
    expect((await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/refuse`)).status).toBe(400);

    const refused = await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/refuse`, { reason: 'He is on sick leave; call the reserve driver.' });
    expect(refused.status).toBe(200);
    expect(refused.body.data).toMatchObject({ status: 'refused', decided_by: s.manager.user.public_id, decision_reason: 'He is on sick leave; call the reserve driver.' });
    expect(await tripRow(s.trip)).toMatchObject({ status: 'scheduled', driver_id: null });
    expect((await getTrip(s.dispatcher.cookie, s.trip)).exception).toMatchObject({ status: 'refused', decision_reason: 'He is on sick leave; call the reserve driver.' });
    expect(await publishedEvents('TripAssigned')).toEqual([]);

    await deliverEvents();
    const alert = (await pool.query("SELECT id, description FROM alert.alerts WHERE alert_type = 'assignment_exception_refused' AND trip_id = $1", [s.trip.id])).rows[0];
    expect(alert.description).toContain('call the reserve driver');
    const told = (await pool.query('SELECT recipient_user_id::text AS id FROM alert.notifications WHERE alert_id = $1', [alert.id])).rows.map((r) => r.id);
    expect(told).toContain(String(s.dispatcher.user.id));

    // Approving it now is too late.
    expect((await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/approve`)).status).toBe(409);
  });

  test('a safety rule is refused as before, never held, and is read again at approval', async () => {
    const s = await setup();
    // BR-1: the driver is on another trip at that time. The reason changes nothing.
    await createTrip({ vehicle: await createVehicle({ depot: s.depot }), driver: s.driver, scheduled_start: '2026-11-02T08:00:00Z', scheduled_end: '2026-11-02T11:00:00Z' });
    const overlap = await post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, exception_reason: 'Please' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('CONFLICT_DRIVER_OVERLAP');
    expect(await exceptionRows(s.trip)).toEqual([]);

    // BR-2 at approval: the vehicle went to the workshop after the request. Refused; the request still waits.
    const other = await setup();
    const held = await post(other.dispatcher.cookie, `/trips/${other.trip.public_id}/assign`, { ...other.body, exception_reason: 'Short of drivers.' });
    expect(held.status).toBe(202);
    await pool.query("UPDATE fleet.vehicles SET status = 'maintenance' WHERE id = $1", [other.vehicle.id]);
    const approve = await post(other.manager.cookie, `/assignment-exceptions/${held.body.data.id}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('CONFLICT_VEHICLE_FLAGGED');
    expect(await exceptionRows(other.trip)).toEqual([{ status: 'pending', reason: 'Short of drivers.', decision_reason: null }]);
    expect(await tripRow(other.trip)).toMatchObject({ status: 'scheduled', driver_id: null });
  });

  test('an approval covers that trip and that warning only; never by the one who asked', async () => {
    const s = await setup({ attendance: 'approve', overrun: 'approve' });
    const held = await post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, exception_reason: 'Short of drivers.' });
    expect(held.status).toBe(202);
    // Since the request, a trip of the driver's went under way, and still is: a warning the request did not ask about.
    const late = await createTrip({
      vehicle: await createVehicle({ depot: s.depot }),
      driver: s.driver,
      status: 'en_route',
      scheduled_start: '2026-11-01T02:00:00Z',
      scheduled_end: '2026-11-01T04:00:00Z',
      actual_start: '2026-11-01T02:05:00Z',
    });
    const outdated = await post(s.manager.cookie, `/assignment-exceptions/${held.body.data.id}/approve`);
    expect(outdated.status).toBe(409);
    expect(outdated.body.error).toMatchObject({ code: 'CONFLICT_APPROVAL_REQUIRED', details: [{ field: 'driver_id', reason: 'previous_trip_overrun', record_id: late.public_id }] });

    // The dispatcher asks again, naming both: the new request replaces the one waiting.
    const both = await post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, exception_reason: 'The other trip ends at the depot.' });
    expect(both.status).toBe(202);
    expect(both.body.data.warnings.map((w: { warning: string }) => w.warning).sort()).toEqual(['DRIVER_ATTENDANCE', 'PREVIOUS_TRIP_OVERRUN']);
    expect((await exceptionRows(s.trip)).map((r) => r.status)).toEqual(['withdrawn', 'pending']);

    // A fleet manager who asks does not approve their own request.
    const own = await post(s.manager.cookie, `/trips/${s.trip.public_id}/assign`, { ...s.body, exception_reason: 'I will take it.' });
    expect(own.status).toBe(202);
    const self = await post(s.manager.cookie, `/assignment-exceptions/${own.body.data.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.error.details).toEqual([{ field: 'exception_id', reason: 'own_request' }]);

    // Another fleet manager does (fleet managers see every depot).
    const second = await account(['fleet_manager'], s.depot);
    expect((await post(second.cookie, `/assignment-exceptions/${own.body.data.id}/approve`)).status).toBe(200);
    expect(await tripRow(s.trip)).toMatchObject({ status: 'assigned' });
    // A request id that does not exist.
    expect((await post(second.cookie, '/assignment-exceptions/00000000-0000-4000-8000-000000000000/approve')).status).toBe(404);
  });

  test('warn, the default, assigns as before; cancelling the trip withdraws a waiting request', async () => {
    const s = await setup({ attendance: 'warn' });
    const res = await post(s.dispatcher.cookie, `/trips/${s.trip.public_id}/assign`, s.body);
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings).toEqual([{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }]);
    expect(res.body.data.exception).toBeNull();

    const held = await setup();
    expect((await post(held.dispatcher.cookie, `/trips/${held.trip.public_id}/assign`, { ...held.body, exception_reason: 'Short of drivers.' })).status).toBe(202);
    const cancel = await request(app).patch(`/api/v1/trips/${held.trip.public_id}`).set('Cookie', held.dispatcher.cookie).send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);
    expect((await exceptionRows(held.trip)).map((r) => r.status)).toEqual(['withdrawn']);
  });

  test('the settings set each warning per depot: warn or approve; one left out keeps the row', async () => {
    const depot = await createDepot();
    const admin = await account(['admin']);
    const base = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 2, idle_minutes: 10 };
    const put = (body: Record<string, unknown>) => request(app).put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`).set('Cookie', admin.cookie).send(body);
    expect((await put({ ...base, driver_attendance_exception: 'approve' })).status).toBe(200);
    expect((await put({ ...base, trip_overrun_exception: 'sometimes' })).status).toBe(400);
    expect((await put({ ...base, idle_minutes: 12 })).status).toBe(200);
    const listed = (await request(app).get('/api/v1/settings/telemetry-rules').set('Cookie', admin.cookie)).body.data;
    expect(listed.fleet).toMatchObject({ driver_attendance_exception: 'warn', trip_overrun_exception: 'warn' });
    expect(listed.depots.find((d: { depot_id: string }) => d.depot_id === depot.public_id)).toMatchObject({ idle_minutes: 12, driver_attendance_exception: 'approve', trip_overrun_exception: 'warn' });
  });
});
