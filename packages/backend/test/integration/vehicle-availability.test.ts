import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { rebuildReadModels } from '../../src/modules';
import { fleetAvailability, fleetModule } from '../../src/modules/fleet';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Status-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const status = (cookie: string, vehicle: Row, query = '') => request(app).get(`/api/v1/vehicles/${vehicle.public_id}/status${query}`).set('Cookie', cookie);
const setStatus = (cookie: string, vehicle: Row, body: object) => request(app).post(`/api/v1/vehicles/${vehicle.public_id}/status`).set('Cookie', cookie).send(body);

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [
    res.headers['x-request-id'],
  ]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

/** A trip event as the trip module publishes it (after a direct write to the trip): fleet's projection runs inside publish. */
async function tripEvent(type: string, tripPublicId: string) {
  const client = await pool.connect();
  try {
    await eventBus.publish(client, [createEvent(type, { trip_id: tripPublicId }, { actor: null, correlationId: randomUUID() })]);
  } finally {
    client.release();
  }
  await deliverEvents();
}

async function readModel(tripPublicId: string) {
  return (await pool.query('SELECT status, lower(during) AS start, upper(during) AS "end" FROM fleet.trip_assignments WHERE trip_id = $1', [tripPublicId])).rows;
}

describe('GET /vehicles/{id}/status', () => {
  test('an idle active vehicle: available now, no assignments, no status change yet', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const res = await status(await signIn(['dispatcher'], depot), vehicle);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"0"');
    expect(res.body.data).toMatchObject({
      vehicle_id: vehicle.public_id,
      registration_number: vehicle.registration_number,
      depot_id: depot.public_id,
      status: 'active',
      maintenance: { flagged: false, in_workshop: false, open_record_id: null },
      availability: { availability: 'available', reasons: [] },
      current_assignment: null,
      next_assignment: null,
      last_status_change: null,
      version: 0,
    });
  });

  test('a flagged vehicle reports unavailable with the reason and its open maintenance record', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const repair = await request(app)
      .post('/api/v1/maintenance')
      .set('Cookie', await signIn(['fleet_manager']))
      .send({ vehicle_id: vehicle.public_id, description: 'Brake pads worn', labour_hours: 2, total_cost_cents: 150000 });
    expect(repair.status).toBe(201);

    const res = await status(await signIn(['dispatcher'], depot), vehicle);
    expect(res.body.data.availability).toMatchObject({ availability: 'unavailable', reasons: [{ code: 'maintenance_flag', severity: 'block' }] });
    expect(res.body.data.maintenance).toEqual({ flagged: true, in_workshop: false, open_record_id: repair.body.data.id });
  });

  test('vehicle:read and depot scope: another depot is 404, no permission is 403, a bad window is 400', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    expect((await status(await signIn(['dispatcher'], await createDepot()), vehicle)).status).toBe(404);
    expect((await status(await signIn(['finance_clerk'], depot), vehicle)).status).toBe(403);
    const cookie = await signIn(['dispatcher'], depot);
    const backwards = await status(cookie, vehicle, '?from=2026-11-02T10:00:00Z&to=2026-11-02T08:00:00Z');
    expect(backwards.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
    expect((await status(cookie, vehicle, '?from=2026-11-01&to=2026-12-31')).body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
  });
});

describe('POST /vehicles/{id}/status', () => {
  test('a status change is audited, kept with its reason, published, and shown as the last change', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    const res = await setStatus(cookie, vehicle, { status: 'maintenance', reason: 'Gearbox noise' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'maintenance',
      maintenance: { in_workshop: true },
      availability: { availability: 'unavailable', reasons: [{ code: 'vehicle_in_maintenance', severity: 'block' }] },
      last_status_change: { from_status: 'active', to_status: 'maintenance', reason: 'Gearbox noise', changed_by: expect.any(String) },
      version: 1,
    });
    expect(res.body.meta.warnings).toEqual([]);
    expect(await auditRows(res)).toEqual(['UPDATE fleet.vehicles', 'INSERT fleet.vehicle_status_history']);

    const [event] = await publishedEvents('VehicleStatusChanged');
    expect(event.payload).toEqual({
      vehicle_id: vehicle.public_id,
      depot_id: depot.public_id,
      previous_status: 'active',
      new_status: 'maintenance',
      changed_at: expect.any(String),
      changed_by: res.body.data.last_status_change.changed_by,
      reason: 'Gearbox noise',
      source: 'manual',
      maintenance_record_id: null,
    });
    expect(event.aggregate).toBe(`vehicle:${vehicle.public_id}`);
    // The vehicle itself shows the new status (its cache was dropped).
    expect((await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', cookie)).body.data.status).toBe('maintenance');
  });

  test('out of service (inactive) and back; nothing leaves retired; unknown statuses and a missing reason are 400', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['fleet_manager']);
    expect((await setStatus(cookie, vehicle, { status: 'inactive', reason: 'Parked for winter' })).body.data.availability.reasons[0].code).toBe('vehicle_out_of_service');
    expect((await setStatus(cookie, vehicle, { status: 'active', reason: 'Back in service' })).body.data.availability.availability).toBe('available');

    expect((await setStatus(cookie, vehicle, { status: 'decommissioned', reason: 'x'.repeat(5) })).status).toBe(400);
    expect((await setStatus(cookie, vehicle, { status: 'inactive' })).status).toBe(400);
    expect((await setStatus(cookie, vehicle, { status: 'retired', reason: 'Sold at auction' })).body.data.status).toBe('retired');
    const back = await setStatus(cookie, vehicle, { status: 'active', reason: 'Bought back' });
    expect(back.status).toBe(409);
    expect(back.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'retired_to_active' }] });
  });

  test('a vehicle under way cannot be taken off the road; trips assigned ahead come back as warnings', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const busy = await createVehicle({ depot });
    const onRoad = await createTrip({ vehicle: busy, driver: (await createDriver({ depot })).driver, status: 'en_route' });
    const blocked = await setStatus(cookie, busy, { status: 'inactive', reason: 'Parked' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CONFLICT_VEHICLE_IN_USE', details: [{ reason: 'trip_en_route', record_id: onRoad.public_id }] });

    const booked = await createVehicle({ depot });
    const ahead = await createTrip({ vehicle: booked, driver: (await createDriver({ depot })).driver, scheduled_start: '2099-01-02T06:00:00Z', scheduled_end: '2099-01-02T08:00:00Z' });
    await tripEvent('TripAssigned', ahead.public_id as string);
    const res = await setStatus(cookie, booked, { status: 'maintenance', reason: 'Service' });
    expect(res.status).toBe(200);
    expect(res.body.meta.warnings).toEqual([{ warning: 'ASSIGNED_TRIP_AFFECTED', trip_id: ahead.public_id, start: '2099-01-02T06:00:00.000Z' }]);
  });

  test('vehicle:write is needed: a dispatcher gets 403', async () => {
    const depot = await createDepot();
    expect((await setStatus(await signIn(['dispatcher'], depot), await createVehicle({ depot }), { status: 'inactive', reason: 'Parked' })).status).toBe(403);
  });

  test('DELETE /vehicles/{id} is a status change too: history and VehicleStatusChanged', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    expect((await request(app).delete(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', cookie)).status).toBe(204);
    expect((await publishedEvents('VehicleStatusChanged'))[0].payload).toMatchObject({ previous_status: 'active', new_status: 'retired', reason: null });
    expect((await status(cookie, vehicle)).body.data).toMatchObject({ status: 'retired', last_status_change: { to_status: 'retired' }, availability: { availability: 'unavailable' } });
  });
});

describe('read model from trip events', () => {
  test('TripAssigned adds the trip; the vehicle is unavailable for overlapping windows; TripCancelled removes it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const trip = await createTrip({ vehicle, driver: (await createDriver({ depot })).driver, scheduled_start: '2099-03-01T06:00:00Z', scheduled_end: '2099-03-01T08:00:00Z' });
    const cookie = await signIn(['dispatcher'], depot);
    expect(await readModel(trip.public_id as string)).toEqual([]);

    await tripEvent('TripAssigned', trip.public_id as string);
    expect(await readModel(trip.public_id as string)).toEqual([{ status: 'assigned', start: new Date('2099-03-01T06:00:00Z'), end: new Date('2099-03-01T08:00:00Z') }]);

    const during = await status(cookie, vehicle, '?from=2099-03-01T07:00:00Z&to=2099-03-01T09:00:00Z');
    expect(during.body.data.availability).toMatchObject({ availability: 'unavailable', reasons: [{ code: 'assigned_to_overlapping_trip', trip_id: trip.public_id }] });
    expect(during.body.data.next_assignment).toMatchObject({ trip_id: trip.public_id, status: 'assigned' });
    // Touching ends count: a window starting when the trip ends is not free.
    expect((await status(cookie, vehicle, '?from=2099-03-01T08:00:00Z&to=2099-03-01T09:00:00Z')).body.data.availability.availability).toBe('unavailable');
    expect((await status(cookie, vehicle, '?from=2099-03-01T08:01:00Z&to=2099-03-01T09:00:00Z')).body.data.availability.availability).toBe('available');

    await pool.query("UPDATE trip.trips SET status = 'cancelled' WHERE id = $1", [trip.id]);
    await tripEvent('TripCancelled', trip.public_id as string);
    expect(await readModel(trip.public_id as string)).toEqual([]);
    expect((await status(cookie, vehicle, '?from=2099-03-01T07:00:00Z&to=2099-03-01T09:00:00Z')).body.data.availability.availability).toBe('available');
  });

  test('the trip is the truth, not the event: a late TripAssigned for a trip already cancelled adds nothing', async () => {
    const depot = await createDepot();
    const trip = await createTrip({ vehicle: await createVehicle({ depot }), driver: (await createDriver({ depot })).driver, status: 'cancelled' });
    await tripEvent('TripAssigned', trip.public_id as string);
    expect(await readModel(trip.public_id as string)).toEqual([]);
  });

  test('a trip under way is the current assignment; a reschedule moves its window', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const trip = await createTrip({ vehicle, driver: (await createDriver({ depot })).driver, status: 'en_route', scheduled_start: '2026-01-01T06:00:00Z', scheduled_end: '2026-01-01T08:00:00Z' });
    await tripEvent('TripStarted', trip.public_id as string);
    const res = await status(await signIn(['dispatcher'], depot), vehicle);
    expect(res.body.data.current_assignment).toMatchObject({ trip_id: trip.public_id, status: 'en_route' });

    await pool.query("UPDATE trip.trips SET scheduled_end = '2026-01-01T09:00:00Z' WHERE id = $1", [trip.id]);
    await tripEvent('TripUpdated', trip.public_id as string);
    expect((await readModel(trip.public_id as string))[0].end).toEqual(new Date('2026-01-01T09:00:00Z'));
  });

  test('the daily trip-assignment-sync rebuilds the read model from the trips, repairing missed events', async () => {
    const depot = await createDepot();
    const missed = await createTrip({ vehicle: await createVehicle({ depot }), driver: (await createDriver({ depot })).driver, scheduled_start: '2099-04-01T06:00:00Z', scheduled_end: '2099-04-01T07:00:00Z' });
    await pool.query("INSERT INTO fleet.trip_assignments (trip_id, status, during) VALUES ($1, 'assigned', tstzrange(now(), now() + interval '1 hour', '[]'))", [randomUUID()]);
    const job = fleetModule.jobs!.find((j) => j.name === 'trip-assignment-sync')!;
    const result = await job.run({ now: new Date(), correlationId: randomUUID(), runKey: '2026-11-02' });
    // Drift is counted (and logged): a row repaired for the trip written without its event, a stale row removed.
    expect(result).toMatchObject({ repaired: 1, removed: 1 });
    expect(await readModel(missed.public_id as string)).toEqual([{ status: 'assigned', start: new Date('2099-04-01T06:00:00Z'), end: new Date('2099-04-01T07:00:00Z') }]);
  });
});

describe("read model kept in the trip change's transaction (projection)", () => {
  const fleetManager = () => signIn(['fleet_manager']);

  test('a reschedule through the trip API updates the read model at once, with no event delivery', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const trip = await createTrip({ vehicle, driver: (await createDriver({ depot })).driver, scheduled_start: '2099-05-01T06:00:00Z', scheduled_end: '2099-05-01T08:00:00Z' });
    const res = await request(app).patch(`/api/v1/trips/${trip.public_id}`).set('Cookie', await fleetManager()).send({ scheduled_end: '2099-05-01T10:00:00Z', reason: 'Loading runs late' });
    expect(res.status).toBe(200);
    // No deliverEvents(): the row was written by the PATCH's own transaction.
    expect(await readModel(trip.public_id as string)).toEqual([{ status: 'assigned', start: new Date('2099-05-01T06:00:00Z'), end: new Date('2099-05-01T10:00:00Z') }]);
    const cookie = await signIn(['dispatcher'], depot);
    expect((await status(cookie, vehicle, '?from=2099-05-01T09:00:00Z&to=2099-05-01T09:30:00Z')).body.data.availability.availability).toBe('unavailable');
  });

  test('a cancel through the trip API frees the vehicle at once', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const trip = await createTrip({ vehicle, driver: (await createDriver({ depot })).driver, scheduled_start: '2099-05-02T06:00:00Z', scheduled_end: '2099-05-02T08:00:00Z' });
    await tripEvent('TripAssigned', trip.public_id as string);
    expect(await readModel(trip.public_id as string)).toHaveLength(1);
    const res = await request(app).patch(`/api/v1/trips/${trip.public_id}`).set('Cookie', await fleetManager()).send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(await readModel(trip.public_id as string)).toEqual([]);
  });

  test('every trip event type is projected, so a new publisher (FMS-31, FMS-32) needs no fleet change', () => {
    for (const type of ['TripCreated', 'TripUpdated', 'TripCancelled', 'TripAssigned', 'TripStarted', 'TripCompleted']) {
      expect(eventBus.projections.namesOf(type)).toEqual(['fleet.trip-assignments']);
      expect(eventBus.subscribers.consumersOf(type)).not.toContain('fleet.trip-assignments');
    }
  });

  test('rebuildReadModels rebuilds every module read model, for the seed or an import that wrote without events', async () => {
    const depot = await createDepot();
    const trip = await createTrip({ vehicle: await createVehicle({ depot }), driver: (await createDriver({ depot })).driver, scheduled_start: '2099-05-03T06:00:00Z', scheduled_end: '2099-05-03T07:00:00Z' });
    const results = await rebuildReadModels();
    expect(Object.keys(results)).toEqual(['fleet.driver_accounts', 'fleet.trip_assignments', 'fleet.downtime_periods', 'fleet.meter_readings']);
    expect(results['fleet.trip_assignments']).toMatchObject({ repaired: expect.any(Number) });
    expect(await readModel(trip.public_id as string)).toHaveLength(1);
  });
});

describe('status follows workshop work', () => {
  const openWork = async (vehicle: Row, body: object = {}) =>
    request(app)
      .post('/api/v1/maintenance')
      .set('Cookie', await signIn(['fleet_manager']))
      .send({
        vehicle_id: vehicle.public_id,
        description: 'Clutch replacement',
        labour_hours: 4,
        total_cost_cents: 300000,
        // A corrective repair is completed only with what failed (FMS-125).
        failures: [{ component: 'transmission', failure_mode: 'wear', unplanned: true }],
        ...body,
      });
  const updateWork = async (recordId: string, body: object) =>
    request(app).patch(`/api/v1/maintenance/${recordId}`).set('Cookie', await signIn(['fleet_manager'])).send(body);

  test('work in progress puts the vehicle in the workshop; the last of it ending takes it out', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['dispatcher'], depot);

    const first = await openWork(vehicle, { status: 'in_progress' });
    expect(first.status).toBe(201);
    let res = await status(cookie, vehicle);
    expect(res.body.data).toMatchObject({
      status: 'maintenance',
      maintenance: { flagged: true, in_workshop: true },
      last_status_change: { from_status: 'active', to_status: 'maintenance', source: 'maintenance', maintenance_record_id: first.body.data.id, reason: 'Maintenance work started.' },
    });
    expect((await publishedEvents('VehicleStatusChanged'))[0].payload).toMatchObject({ new_status: 'maintenance', source: 'maintenance', maintenance_record_id: first.body.data.id });

    const second = await openWork(vehicle);
    expect((await updateWork(second.body.data.id, { status: 'in_progress' })).status).toBe(200);
    expect((await updateWork(first.body.data.id, { status: 'completed' })).status).toBe(200);
    // Other work is still in progress: still in the workshop.
    expect((await status(cookie, vehicle)).body.data.status).toBe('maintenance');

    expect((await updateWork(second.body.data.id, { status: 'completed' })).status).toBe(200);
    res = await status(cookie, vehicle);
    expect(res.body.data).toMatchObject({
      status: 'active',
      maintenance: { flagged: false, in_workshop: false },
      availability: { availability: 'available' },
      last_status_change: { from_status: 'maintenance', to_status: 'active', source: 'maintenance', maintenance_record_id: second.body.data.id },
    });
  });

  test('open (not started) work only flags the vehicle; a status set by hand outlives the work', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    const work = await openWork(vehicle);
    expect((await status(cookie, vehicle)).body.data).toMatchObject({ status: 'active', maintenance: { flagged: true } });

    expect((await setStatus(cookie, vehicle, { status: 'maintenance', reason: 'Waiting for parts' })).status).toBe(200);
    expect((await updateWork(work.body.data.id, { status: 'in_progress' })).status).toBe(200);
    expect((await updateWork(work.body.data.id, { status: 'completed' })).status).toBe(200);
    expect((await status(cookie, vehicle)).body.data).toMatchObject({ status: 'maintenance', last_status_change: { source: 'manual', reason: 'Waiting for parts' } });
  });

  test('out of service stays out of service when work starts', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    await setStatus(cookie, vehicle, { status: 'inactive', reason: 'Accident damage' });
    expect((await openWork(vehicle, { status: 'in_progress' })).status).toBe(201);
    expect((await status(cookie, vehicle)).body.data.status).toBe('inactive');
  });
});

describe('statuses as stored', () => {
  test('shared.vehicle_status no longer has the legacy decommissioned', async () => {
    const res = await pool.query<{ values: string }>('SELECT enum_range(NULL::shared.vehicle_status)::text AS values');
    expect(res.rows[0].values).toBe('{active,inactive,maintenance,retired}');
  });
});

describe('fleet availability interface (for trip assignment)', () => {
  const window = { start: new Date('2029-05-01T06:00:00Z'), end: new Date('2029-05-01T08:00:00Z') };

  test('an absent driver reports available-with-warning; a driver on an overlapping trip is unavailable', async () => {
    const depot = await createDepot();
    const { driver: absent } = await createDriver({ depot });
    const clerk = await createUser({ roles: ['depot_admin'], depot });
    await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, '2029-05-01', 'absent', $2)", [absent.id, clerk.id]);
    const { driver: busy } = await createDriver({ depot });
    const trip = await createTrip({ vehicle: await createVehicle({ depot }), driver: busy, scheduled_start: '2029-05-01T07:00:00Z', scheduled_end: '2029-05-01T09:00:00Z' });
    await tripEvent('TripAssigned', trip.public_id as string);
    const { driver: free } = await createDriver({ depot });

    const answer = await fleetAvailability.check(pool, { driverIds: [absent.id, busy.id, free.id], window });
    expect(answer.drivers.get(absent.id)).toEqual({ availability: 'available_with_warning', reasons: [{ code: 'driver_absent', severity: 'warning' }] });
    expect(answer.drivers.get(busy.id)).toEqual({ availability: 'unavailable', reasons: [{ code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: trip.public_id }] });
    expect(answer.drivers.get(free.id)).toEqual({ availability: 'available', reasons: [] });
    // The trip being re-assigned is not its own conflict.
    expect((await fleetAvailability.check(pool, { driverIds: [busy.id], window, excludeTripId: trip.public_id as string })).drivers.get(busy.id)?.availability).toBe('available');
  });

  test("asked for a depot's trip: another depot's vehicle and driver are unavailable", async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const own = { vehicle: await createVehicle({ depot }), driver: (await createDriver({ depot })).driver };
    const lent = { vehicle: await createVehicle({ depot: other }), driver: (await createDriver({ depot: other })).driver };
    const answer = await fleetAvailability.check(pool, { vehicleIds: [own.vehicle.id, lent.vehicle.id], driverIds: [own.driver.id, lent.driver.id], window, depotId: depot.id });
    expect(answer.vehicles.get(own.vehicle.id)?.availability).toBe('available');
    expect(answer.drivers.get(own.driver.id)?.availability).toBe('available');
    expect(answer.vehicles.get(lent.vehicle.id)?.reasons).toEqual([{ code: 'vehicle_other_depot', severity: 'block' }]);
    expect(answer.drivers.get(lent.driver.id)?.reasons).toEqual([{ code: 'driver_other_depot', severity: 'block' }]);
  });

  test('vehicles and drivers in one call; an expired licence blocks; unknown ids are absent', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, maintenance_flag: true });
    const { driver: expired } = await createDriver({ depot, license_expiry: '2029-04-30' });
    const answer = await fleetAvailability.check(pool, { vehicleIds: [vehicle.id, '999999999'], driverIds: [expired.id], window });
    expect(answer.vehicles.get(vehicle.id)?.reasons).toEqual([{ code: 'maintenance_flag', severity: 'block' }]);
    expect(answer.vehicles.has('999999999')).toBe(false);
    expect(answer.drivers.get(expired.id)?.reasons).toEqual([{ code: 'license_expired', severity: 'block' }]);
  });
});
