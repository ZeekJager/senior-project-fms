import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { ASSIGNMENT_EVENTS } from '../../src/modules/fleet/domain/assignment';
import { publishedEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-77 (docs/driver-vehicle-assignments.md): a driver's regular vehicle, apart from trips.

const app = createApp();
const PASSWORD = 'Assign-Test-1';

async function signIn(roles: RoleName[], depot: { id: string } | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const post = (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const iso = (d: string) => new Date(d).toISOString();

async function fleet() {
  const depot = await createDepot();
  const [v1, v2] = [await createVehicle({ depot }), await createVehicle({ depot })];
  const [d1, d2] = [await createDriver({ depot }), await createDriver({ depot })];
  return { depot, v1, v2, d1: d1.driver, d2: d2.driver };
}

describe('driver-vehicle assignments (FMS-77)', () => {
  test('a primary assignment is created, audited and published; a second primary for the same driver is 409', async () => {
    const { v1, v2, d1 } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const created = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id, notes: 'Regular truck' }, cookie);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      driver: { id: d1.public_id, full_name: 'Test Driver' },
      vehicle: { id: v1.public_id, registration_number: v1.registration_number },
      assignment_type: 'primary',
      status: 'active',
      current: true,
      end_at: null,
      notes: 'Regular truck',
    });
    expect(created.headers.location).toBe(`/api/v1/driver-vehicle-assignments/${created.body.data.id}`);
    const [event] = await publishedEvents(ASSIGNMENT_EVENTS.assigned);
    expect(event.payload).toMatchObject({ assignment_id: created.body.data.id, driver_id: d1.public_id, vehicle_id: v1.public_id, assignment_type: 'primary' });
    const audit = await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'fleet.driver_vehicle_assignments' AND correlation_id = $1", [created.headers['x-request-id']]);
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT']);

    // The card's rule: one primary per driver.
    const second = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v2.public_id }, cookie);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT_DRIVER_IN_USE');
    expect(second.body.error.details).toEqual([{ field: 'driver_id', reason: 'driver_has_primary_vehicle', record_id: created.body.data.id }]);
  });

  test('a vehicle has one primary driver; a temporary assignment may overlap, and needs an end', async () => {
    const { v1, d1, d2 } = await fleet();
    const cookie = await signIn(['dispatcher'], null);
    // A dispatcher without a depot sees nothing: use a fleet manager for the setup, then check the rules.
    const fm = await signIn(['fleet_manager']);
    const first = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id }, fm);
    expect(first.status).toBe(201);
    const clash = await post('/driver-vehicle-assignments', { driver_id: d2.public_id, vehicle_id: v1.public_id }, fm);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'CONFLICT_VEHICLE_IN_USE', details: [{ field: 'vehicle_id', reason: 'vehicle_has_primary_driver', record_id: first.body.data.id }] });

    const noEnd = await post('/driver-vehicle-assignments', { driver_id: d2.public_id, vehicle_id: v1.public_id, assignment_type: 'temporary' }, fm);
    expect(noEnd.status).toBe(400);
    expect(noEnd.body.error.details).toEqual([{ field: 'end_at', reason: 'required' }]);
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const temp = await post('/driver-vehicle-assignments', { driver_id: d2.public_id, vehicle_id: v1.public_id, assignment_type: 'temporary', end_at: end }, fm);
    expect(temp.status).toBe(201);
    expect(temp.body.data).toMatchObject({ assignment_type: 'temporary', current: true, end_at: end });

    expect((await get(`/vehicles/${v1.public_id}/assignments`, cookie)).status).toBe(404);
  });

  test('history lists past assignments, newest first; ending one frees the driver for another', async () => {
    const { v1, v2, d1 } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const old = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id, start_at: iso('2026-01-05T06:00:00Z') }, cookie);
    expect(old.status).toBe(201);

    const ended = await post(`/driver-vehicle-assignments/${old.body.data.id}/end`, { end_at: iso('2026-06-30T18:00:00Z'), notes: 'Moved to the long-haul truck' }, cookie);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data).toMatchObject({ status: 'ended', current: false, end_at: iso('2026-06-30T18:00:00Z'), notes: 'Moved to the long-haul truck' });
    expect((await publishedEvents(ASSIGNMENT_EVENTS.ended))[0].payload).toMatchObject({ assignment_id: old.body.data.id, end_at: iso('2026-06-30T18:00:00Z') });
    const again = await post(`/driver-vehicle-assignments/${old.body.data.id}/end`, {}, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');

    const current = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v2.public_id, start_at: iso('2026-07-01T06:00:00Z') }, cookie);
    expect(current.status).toBe(201);

    const driverHistory = await get(`/drivers/${d1.public_id}/assignments`, cookie);
    expect(driverHistory.status).toBe(200);
    expect(driverHistory.body.data.map((a: { id: string; current: boolean; vehicle: { id: string } }) => [a.id, a.current, a.vehicle.id])).toEqual([
      [current.body.data.id, true, v2.public_id],
      [old.body.data.id, false, v1.public_id],
    ]);
    expect(driverHistory.body.meta).toMatchObject({ total_items: 2, page: 1 });

    const vehicleHistory = await get(`/vehicles/${v1.public_id}/assignments`, cookie);
    expect(vehicleHistory.body.data).toHaveLength(1);
    expect(vehicleHistory.body.data[0]).toMatchObject({ id: old.body.data.id, status: 'ended', driver: { id: d1.public_id } });
    expect((await get(`/driver-vehicle-assignments/${old.body.data.id}`, cookie)).body.data.id).toBe(old.body.data.id);
  });

  test('a period that ended before the new one starts does not clash; one that overlaps it does', async () => {
    const { v1, v2, d1 } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const may = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id, start_at: iso('2026-05-01T00:00:00Z'), end_at: iso('2026-06-01T00:00:00Z') }, cookie);
    expect(may.status).toBe(201);
    const june = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v2.public_id, start_at: iso('2026-06-01T00:00:00Z') }, cookie);
    expect(june.status).toBe(201);
    const midMay = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v2.public_id, start_at: iso('2026-04-15T00:00:00Z'), end_at: iso('2026-05-15T00:00:00Z') }, cookie);
    expect(midMay.status).toBe(409);
  });

  test('driver and vehicle must be in the caller’s depots and in the same one; retired ones are refused', async () => {
    const { depot, v1, d1 } = await fleet();
    const other = await createDepot();
    const farVehicle = await createVehicle({ depot: other });
    const admin = await signIn(['admin']);
    const mismatch = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: farVehicle.public_id }, admin);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('CONFLICT_DEPOT_MISMATCH');

    // A depot admin of the other depot cannot see this depot's driver or vehicle.
    const otherAdmin = await signIn(['depot_admin'], other);
    const hidden = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id }, otherAdmin);
    expect(hidden.status).toBe(400);
    expect(hidden.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);
    expect((await get(`/drivers/${d1.public_id}/assignments`, otherAdmin)).status).toBe(404);

    const ownAdmin = await signIn(['depot_admin'], depot);
    await pool.query('UPDATE fleet.drivers SET is_active = FALSE WHERE id = $1', [d1.id]);
    const retired = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id }, ownAdmin);
    expect(retired.status).toBe(409);
    expect(retired.body.error).toMatchObject({ code: 'CONFLICT_DRIVER_NOT_ELIGIBLE', details: [{ field: 'driver_id', reason: 'driver_retired' }] });
  });

  test('assignment:read and assignment:write: a technician may do neither', async () => {
    const { v1, d1 } = await fleet();
    const tech = await signIn(['technician']);
    expect((await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id }, tech)).status).toBe(403);
    expect((await get(`/vehicles/${v1.public_id}/assignments`, tech)).status).toBe(403);
  });

  test('an end before the start, or in the future, is refused', async () => {
    const { v1, d1 } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const bad = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id, start_at: iso('2026-05-01T00:00:00Z'), end_at: iso('2026-04-01T00:00:00Z') }, cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
    const a = await post('/driver-vehicle-assignments', { driver_id: d1.public_id, vehicle_id: v1.public_id }, cookie);
    const future = await post(`/driver-vehicle-assignments/${a.body.data.id}/end`, { end_at: new Date(Date.now() + 86_400_000).toISOString() }, cookie);
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual([{ field: 'end_at', reason: 'in_future' }]);
  });
});
